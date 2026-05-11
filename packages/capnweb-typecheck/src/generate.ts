// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Build-time generator that produces Cap'n Web validation artifacts in a
// user-specified output directory. The hard work (turning each
// `RpcTarget`-method's TypeScript signature into a runtime validator) is
// delegated to Typia: we synthesize a `specs.ts` module containing
// `typia.createValidate<T>()` call sites for each parameter / return type,
// run Typia's transformer programmatically, and rewrite the resulting JS so
// the user's app pulls in the validator helpers through
// `capnweb/internal/typecheck` rather than `typia/lib/internal/*`.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { transform as typiaTransform } from "typia/lib/transform.js";
import {
  collectReachableSourceFiles,
  commonDir,
  createProject,
  extractClasses,
  findTsConfig,
  type RpcClassInfo,
} from "./extract.js";
import { emitShadowSources, wrapFunctionName, wrapSessionFunctionName } from "./rewrite.js";
import type {
  ClassRegistration,
  GenOptions,
  GenResult,
} from "./types.js";

/**
 * CLI / Wrangler path. Emits a shadow source tree alongside the validator
 * artifacts and a worker entry point that re-exports the user's module after
 * registering server-side validators.
 */
export function generate(options: GenOptions): GenResult {
  let prepared = prepare(options);
  let { classes, outAbs, sourceFile, reachableFiles, root, runtimeImport } = prepared;

  let entryAbs = emitShadowSources(reachableFiles, sourceFile, outAbs, root,
      classes.map(c => c.name));
  let importPath = jsImportPath(relative(outAbs, entryAbs));
  let hasDefaultExport = sourceFile.getDefaultExportSymbol() !== undefined;

  emitArtifacts(prepared);

  writeFileSync(join(outAbs, "worker.entry.ts"),
      emitWorkerEntry(importPath, hasDefaultExport, classes, outAbs, root));
  log(outAbs, "worker.entry.ts");

  return makeGenResult(classes);
}

/**
 * Vite path. Same artifacts as CLI mode minus the shadow source tree and
 * worker-entry module: the Vite plugin handles client rewrites in memory and
 * injects the server validator registration into the user's worker module
 * itself.
 */
export function generateValidatorsOnly(options: GenOptions): GenResult {
  let prepared = prepare(options);
  emitArtifacts(prepared);
  return makeGenResult(prepared.classes);
}

type Prepared = {
  classes: RpcClassInfo[];
  outAbs: string;
  runtimeImport: string;
  sourceFile: ReturnType<ReturnType<typeof createProject>["addSourceFileAtPath"]>;
  reachableFiles: ReturnType<typeof collectReachableSourceFiles>;
  root: string;
};

function prepare(options: GenOptions): Prepared {
  let inputAbs = resolve(options.input);
  let outAbs = resolve(options.outDir);
  let runtimeImport = options.runtimeImport ?? "capnweb/internal/typecheck";

  if (!existsSync(inputAbs)) {
    throw new Error(`Input file does not exist: ${options.input}`);
  }

  let project = createProject(inputAbs);
  let sourceFile = project.addSourceFileAtPath(inputAbs);
  let reachableFiles = collectReachableSourceFiles(sourceFile);
  let root = commonDir(reachableFiles.map(file => file.getFilePath()));
  let classes = extractClasses(reachableFiles);
  if (classes.length === 0) {
    throw new Error(`No classes extending RpcTarget found in ${options.input}`);
  }

  checkNameCollisions(classes);
  mkdirSync(outAbs, { recursive: true });

  return { classes, outAbs, runtimeImport, sourceFile, reachableFiles, root };
}

function checkNameCollisions(classes: RpcClassInfo[]): void {
  let seenNames = new Map<string, RpcClassInfo>();
  for (let klass of classes) {
    let prior = seenNames.get(klass.name);
    if (prior) {
      throw new Error(`Multiple RpcTarget classes share the name '${klass.name}'. ` +
          `Sources: ${prior.sourcePath}, ${klass.sourcePath}. ` +
          `Give one of them an explicit name (e.g., name the default-exported class) ` +
          `so the generated validator map has unique keys.`);
    }
    seenNames.set(klass.name, klass);
  }

}

function emitArtifacts(p: Prepared): void {
  emitSpecs(p);
  writeFileSync(join(p.outAbs, "validators.ts"), emitValidatorsWrapper(p.runtimeImport));
  log(p.outAbs, "validators.ts");
  writeFileSync(join(p.outAbs, "clients.ts"), emitClientsWrapper(p.classes, p.runtimeImport));
  log(p.outAbs, "clients.ts");
}

// =====================================================================
// specs.ts -> specs.js: synthesize typia.createValidate calls, run Typia's
// transformer programmatically, rewrite the resulting JS imports to point at
// our vendored runtime shim. The compiled specs.js is what downstream code
// (validators.ts, clients.ts) imports at runtime.

function emitSpecs(p: Prepared): void {
  let specsSrc = synthesizeSpecsSource(p);
  let specsAbs = join(p.outAbs, "specs.ts");
  writeFileSync(specsAbs, specsSrc);

  let compilerOptions = readCompilerOptions(p.sourceFile.getFilePath());
  let program = ts.createProgram({
    rootNames: [specsAbs],
    options: {
      ...compilerOptions,
      target: compilerOptions.target ?? ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: compilerOptions.jsx ?? ts.JsxEmit.ReactJSX,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      allowImportingTsExtensions: false,
      noEmit: false,
      // We capture emitted files via a writeFile callback and write them to
      // their final location ourselves, so we don't pass outDir here -- TS
      // would compute rootDir from the source graph (which includes user
      // files outside .capnweb/) and produce nested output paths.
      rootDir: undefined,
      outDir: undefined,
      declaration: false,
      emitDeclarationOnly: false,
    },
  });

  // Typia's transformer needs `extras.addDiagnostic` to report type-level
  // problems (e.g. attempting to validate an `any` type). We collect those
  // alongside the standard TypeScript emit diagnostics.
  let typiaDiags: ts.Diagnostic[] = [];
  let extras = {
    addDiagnostic: (d: ts.Diagnostic) => typiaDiags.push(d),
  };
  let transformer = typiaTransform(program, undefined, extras);
  let emittedFiles: { name: string; text: string }[] = [];
  let specsFile = program.getSourceFile(specsAbs);
  if (!specsFile) {
    throw new Error("capnweb-typecheck: expected generated specs.ts to be part of the TypeScript program.");
  }
  let emit = program.emit(
    specsFile,
    (fileName, text) => emittedFiles.push({ name: fileName, text }),
    undefined,
    false,
    { before: [transformer] },
  );

  let allDiags = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(specsFile),
    ...program.getSemanticDiagnostics(specsFile),
    ...emit.diagnostics,
    ...typiaDiags,
  ];
  let blockingDiags = allDiags.filter(d => d.category === ts.DiagnosticCategory.Error);
  if (blockingDiags.length > 0) {
    let msgs = blockingDiags.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    throw new Error(`capnweb-typecheck: TypeScript reported errors while ` +
        `generating validators:\n  ${msgs.join("\n  ")}`);
  }

  // The emit callback receives whatever path TS picked for each output. We
  // only care about the .js for our synthesized specs file; rewrite its
  // typia imports and place it at `<outAbs>/specs.js`.
  let specsJsName = "specs.js";
  let written = false;
  for (let { name, text } of emittedFiles) {
    if (!name.endsWith(".js")) continue;
    if (!name.endsWith(specsJsName)) continue;
    text = rewriteTypiaImports(text, p.runtimeImport);
    writeFileSync(join(p.outAbs, specsJsName), text);
    written = true;
    break;
  }
  if (!written) {
    throw new Error("capnweb-typecheck: expected specs.js to be emitted but it wasn't. " +
        `Emitted files: ${emittedFiles.map(f => f.name).join(", ")}`);
  }

  // The synthesized specs.ts is only useful to feed the transformer; remove
  // it so downstream tooling doesn't accidentally pull in the un-transformed
  // (`typia.createValidate` call site) source.
  try { unlinkSync(specsAbs); } catch {}
  log(p.outAbs, "specs.js");
}

function synthesizeSpecsSource(p: Prepared): string {
  let lines: string[] = [
    `// Generated by capnweb-typecheck gen. Do not edit.`,
    `// This file is consumed by Typia's transformer at build time; the`,
    `// emitted JS contains inline runtime validators.`,
    `import typia from "typia";`,
  ];

  let importPaths = new Map<string, Set<string>>();
  let defaultImports: { alias: string; path: string }[] = [];
  for (let klass of p.classes) {
    let importPath = jsImportPath(relative(p.outAbs, klass.sourcePath));
    let typeName = klass.name;
    if (klass.isDefault) {
      defaultImports.push({ alias: klass.valueName, path: importPath });
    } else {
      let set = importPaths.get(importPath);
      if (!set) {
        set = new Set();
        importPaths.set(importPath, set);
      }
      set.add(typeName);
    }
  }
  for (let [path, names] of importPaths) {
    lines.push(`import type { ${[...names].join(", ")} } from ${JSON.stringify(path)};`);
  }
  for (let { alias, path } of defaultImports) {
    lines.push(`import type ${alias} from ${JSON.stringify(path)};`);
  }
  lines.push(``);

  // Synthesize one typia.createValidate per parameter and per return.
  p.classes.forEach((klass, classIndex) => {
    let typeRef = klass.isDefault ? klass.valueName : klass.name;
    klass.methods.forEach((method, methodIndex) => {
      let methodKey = JSON.stringify(method.name);
      let validatorPrefix = `_v_${classIndex}_${methodIndex}`;
      let argsTuple = `Parameters<${typeRef}[${methodKey}]>`;
      let returnT = `Awaited<ReturnType<${typeRef}[${methodKey}]>>`;
      method.paramNames.forEach((_, i) => {
        lines.push(`const ${validatorPrefix}_arg${i} = ` +
            `typia.createValidate<${argsTuple}[${i}]>();`);
      });
      lines.push(`const ${validatorPrefix}_return = ` +
          `typia.createValidate<${returnT}>();`);
    });
  });

  lines.push(``, `export const validators = {`);
  p.classes.forEach((klass, classIndex) => {
    lines.push(`  ${JSON.stringify(klass.name)}: {`);
    klass.methods.forEach((method, methodIndex) => {
      let validatorPrefix = `_v_${classIndex}_${methodIndex}`;
      lines.push(`    ${JSON.stringify(method.name)}: {`);
      lines.push(`      paramNames: ${JSON.stringify(method.paramNames)},`);
      lines.push(`      paramOptional: ${JSON.stringify(method.paramOptional)},`);
      let argRefs = method.paramNames.map((_, i) =>
          `${validatorPrefix}_arg${i}`).join(", ");
      lines.push(`      paramValidators: [${argRefs}],`);
      lines.push(`      returns: ${validatorPrefix}_return,`);
      lines.push(`    },`);
    });
    lines.push(`  },`);
  });
  lines.push(`};`);

  return lines.join("\n") + "\n";
}

// Typia emits imports like:
//   import * as __typia_transform__validateReport from "typia/lib/internal/_validateReport";
//   import * as __typia_transform__createStandardSchema from "typia/lib/internal/_createStandardSchema";
//   import typia from "typia";
// We rewrite the first two to import from `capnweb/internal/typecheck` (where
// we re-export the vendored helpers), and drop the third (Typia replaces all
// call sites, so `typia` itself is dead-imported).
function rewriteTypiaImports(src: string, runtimeImport: string): string {
  src = src.replace(
      /import \* as (\S+) from "typia\/lib\/internal\/_(?:validateReport|createStandardSchema)(?:\.js)?";\n/g,
      `import * as $1 from ${JSON.stringify(runtimeImport)};\n`);
  src = src.replace(/^import typia from "typia";\n/m, "");
  return src;
}

function readCompilerOptions(inputAbs: string): ts.CompilerOptions {
  let tsconfig = findTsConfig(inputAbs);
  if (!tsconfig) return {};
  let config = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfig)).options;
}

// =====================================================================
// Thin TS wrappers around specs.js. These are the modules user-side code
// imports from `.capnweb/`.

function emitValidatorsWrapper(runtimeImport: string): string {
  return `// Generated by capnweb-typecheck gen. Do not edit.
import { __capnweb_registerRpcValidators } from ${JSON.stringify(runtimeImport)};
// @ts-ignore - specs.js is generated by Typia and ships without .d.ts
import { validators } from "./specs.js";

export function registerCapnwebValidators(classes: Record<string, Function>): void {
  __capnweb_registerRpcValidators(classes, validators as Record<string, Record<string, any>>);
}
`;
}

function emitClientsWrapper(classes: RpcClassInfo[], runtimeImport: string): string {
  let lines: string[] = [
    `// Generated by capnweb-typecheck gen. Do not edit.`,
    `import { __capnweb_bindClientValidator } from ${JSON.stringify(runtimeImport)};`,
    `// @ts-ignore - specs.js is generated by Typia and ships without .d.ts`,
    `import { validators } from "./specs.js";`,
    ``,
  ];
  for (let klass of classes) {
    let stub = wrapFunctionName(klass.name);
    let session = wrapSessionFunctionName(klass.name);
    let key = JSON.stringify(klass.name);
    lines.push(`export function ${stub}<T>(stub: T): T {`);
    lines.push(`  return __capnweb_bindClientValidator(stub as object, ${key}, ` +
        `(validators as any)[${key}]) as T;`);
    lines.push(`}`);
    lines.push(``);
    lines.push(`export function ${session}<T>(session: T): T {`);
    lines.push(`  let main = (session as { getRemoteMain(): object }).getRemoteMain();`);
    lines.push(`  __capnweb_bindClientValidator(main, ${key}, (validators as any)[${key}]);`);
    lines.push(`  return session;`);
    lines.push(`}`);
    lines.push(``);
  }
  return lines.join("\n");
}

function emitWorkerEntry(
    importPath: string, hasDefault: boolean, classes: RpcClassInfo[],
    outAbs: string, root: string): string {
  let registration = emitRegistrationImportsAndCall(classes, outAbs,
      sourcePath => join(outAbs, "source", relative(root, sourcePath)));
  return `// Generated by capnweb-typecheck gen. Do not edit.
import { registerCapnwebValidators } from "./validators.js";
${registration.imports.join("\n")}
registerCapnwebValidators({ ${registration.entries.join(", ")} });
export * from ${JSON.stringify(importPath)};
${hasDefault ? `export { default } from ${JSON.stringify(importPath)};\n` : ""}`;
}

type RegistrationEmit = { imports: string[]; entries: string[] };

export function emitViteRegistration(
    classes: ClassRegistration[], inputAbs: string,
    validatorsAbs: string): { imports: string; call: string } {
  let registration = emitRegistrationImportsAndCall(classes, dirname(inputAbs),
      sourcePath => sourcePath, inputAbs);
  let imports = `import { registerCapnwebValidators as __capnweb_registerValidators } ` +
      `from ${JSON.stringify(jsImportPath(relative(dirname(inputAbs), validatorsAbs)))};\n` +
      `${registration.imports.join("\n")}`;
  let call = `__capnweb_registerValidators({ ${registration.entries.join(", ")} });`;
  return { imports, call };
}

function emitRegistrationImportsAndCall(
    classes: ClassRegistration[], baseDir: string,
    sourcePathFor: (sourcePath: string) => string,
    localSourcePath?: string): RegistrationEmit {
  let imports: string[] = [];
  let entries: string[] = [];
  let namedImports = new Map<string, string[]>();
  let defaultImports: string[] = [];

  for (let klass of classes) {
    if (localSourcePath && klass.sourcePath === localSourcePath) {
      if (klass.isDefault && klass.name === "default") {
        throw new Error("capnweb-typecheck/vite cannot auto-register an anonymous default-exported " +
            "RpcTarget class. Give the class a name.");
      }
      let localValueName = klass.isDefault ? klass.name : klass.valueName;
      entries.push(`${JSON.stringify(klass.name)}: ${localValueName}`);
      continue;
    }

    let sourcePath = sourcePathFor(klass.sourcePath);
    let importPath = jsImportPath(relative(baseDir, sourcePath));
    let alias = `__capnweb_${klass.valueName}`;
    entries.push(`${JSON.stringify(klass.name)}: ${alias}`);
    if (klass.isDefault) {
      defaultImports.push(`import ${alias} from ${JSON.stringify(importPath)};`);
    } else {
      let group = namedImports.get(importPath);
      if (!group) {
        group = [];
        namedImports.set(importPath, group);
      }
      group.push(`${klass.name} as ${alias}`);
    }
  }

  for (let [importPath, group] of namedImports) {
    imports.push(`import { ${group.join(", ")} } from ${JSON.stringify(importPath)};`);
  }
  imports.push(...defaultImports);
  return { imports, entries };
}

function makeGenResult(classes: RpcClassInfo[]): GenResult {
  return {
    classes: classes.map(c => c.name),
    registrations: classes.map(({name, valueName, isDefault, sourcePath}) =>
        ({ name, valueName, isDefault, sourcePath })),
  };
}

function jsImportPath(path: string): string {
  let normalized = path.split(/[/\\]+/).join("/");
  let ext = extname(normalized);
  if (ext) normalized = normalized.slice(0, -ext.length) + ".js";
  if (!normalized.startsWith("./") && !normalized.startsWith("../")) normalized = "./" + normalized;
  return normalized;
}

function log(outAbs: string, name: string): void {
  console.log(`Generated ${relative(process.cwd(), join(outAbs, name))}`);
}

export type { GenOptions, GenResult } from "./types.js";
