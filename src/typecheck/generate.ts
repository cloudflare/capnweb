// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import {
  collectReachableSourceFiles,
  commonDir,
  createProject,
  extractClasses,
} from "./extract.js";
import { emitShadowSources, wrapFunctionName, wrapSessionFunctionName } from "./rewrite.js";
import type { ClassRegistration, ExtractedClassSpec, GenOptions, GenResult, MethodSpec, TypeSpec } from "./types.js";

export function generate(options: GenOptions): GenResult {
  let prepared = prepare(options);
  let { classes, outAbs, sourceFile, reachableFiles, root } = prepared;

  let entryAbs = emitShadowSources(reachableFiles, sourceFile, outAbs, root, classes.map(c => c.name));
  let importPath = jsImportPath(relative(outAbs, entryAbs));
  let hasDefaultExport = sourceFile.statements.some(statement =>
    (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
    (ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)));

  emitArtifacts(prepared);
  writeFileSync(join(outAbs, "worker.entry.ts"),
      emitWorkerEntry(importPath, hasDefaultExport, classes, outAbs, root));
  log(outAbs, "worker.entry.ts");
  return makeGenResult(classes);
}

export function generateValidatorsOnly(options: GenOptions): GenResult {
  let prepared = prepare(options);
  emitArtifacts(prepared);
  return makeGenResult(prepared.classes);
}

type Prepared = {
  classes: ExtractedClassSpec[];
  outAbs: string;
  runtimeImport: string;
  sourceFile: ReturnType<typeof createProject>["sourceFile"];
  reachableFiles: ReturnType<typeof collectReachableSourceFiles>;
  root: string;
};

function prepare(options: GenOptions): Prepared {
  let inputAbs = resolve(options.input);
  let outAbs = resolve(options.outDir);
  let runtimeImport = options.runtimeImport ?? "capnweb/internal/typecheck";
  if (!existsSync(inputAbs)) throw new Error(`Input file does not exist: ${options.input}`);

  let project = createProject(inputAbs);
  let sourceFile = project.sourceFile;
  let reachableFiles = collectReachableSourceFiles(project);
  let root = commonDir(reachableFiles.map(file => file.fileName));
  let classes = extractClasses(project, reachableFiles);
  if (classes.length === 0) throw new Error(`No classes extending RpcTarget found in ${options.input}`);
  checkNameCollisions(classes);
  for (let klass of classes) {
    for (let method of klass.methods) {
      for (let param of method.params) checkSupported(param.type);
      checkSupported(method.returns);
    }
  }
  mkdirSync(outAbs, { recursive: true });
  return { classes, outAbs, runtimeImport, sourceFile, reachableFiles, root };
}

function checkNameCollisions(classes: ExtractedClassSpec[]): void {
  let seen = new Map<string, ExtractedClassSpec>();
  for (let klass of classes) {
    let prior = seen.get(klass.name);
    if (prior) {
      throw new Error(`Multiple RpcTarget classes share the name '${klass.name}'. ` +
          `Sources: ${prior.sourcePath}, ${klass.sourcePath}. Give one of them an explicit name.`);
    }
    seen.set(klass.name, klass);
  }
}

function checkSupported(type: TypeSpec): void {
  switch (type.kind) {
    case "unsupported": throw new Error(`Unsupported RPC type: ${type.text}`);
    case "array": checkSupported(type.element); break;
    case "tuple": for (let element of type.elements) checkSupported(element); break;
    case "map": checkSupported(type.key); checkSupported(type.value); break;
    case "set": checkSupported(type.value); break;
    case "object": for (let prop of type.props) checkSupported(prop.type); break;
    case "record": checkSupported(type.value); break;
    case "union": for (let variant of type.variants) checkSupported(variant); break;
  }
}

function emitArtifacts(p: Prepared): void {
  writeFileSync(join(p.outAbs, "specs.ts"), emitSpecsModule(p.classes, p.runtimeImport));
  log(p.outAbs, "specs.ts");
  writeFileSync(join(p.outAbs, "validators.ts"), emitValidatorsModule(p.runtimeImport));
  log(p.outAbs, "validators.ts");
  writeFileSync(join(p.outAbs, "clients.ts"), emitClientsModule(p.classes, p.runtimeImport));
  log(p.outAbs, "clients.ts");
}

function emitSpecsModule(classes: ExtractedClassSpec[], runtimeImport: string): string {
  let emit: ValidatorEmit = { lines: [], nextId: 0 };
  let classEntries: string[] = [];

  for (let klass of classes) {
    let methodEntries = klass.methods.map(method => {
      let paramValidators = method.params.map(param => emitTypeValidator(param.type, emit));
      let returnValidator = emitTypeValidator(method.returns, emit);
      let returnPathValidator = emitTypePathValidator(method.returns, emit);
      return emitMethodValidator(klass.name, method, paramValidators, returnValidator, returnPathValidator);
    });
    classEntries.push("  " + JSON.stringify(klass.name) + ": {\n" +
        methodEntries.join(",\n") + "\n  }");
  }

  let lines = [
    "// Generated by capnweb typecheck gen. Do not edit.",
    "import { RpcTarget as __capnweb_RpcTarget } from " + JSON.stringify(runtimeImport) + ";",
    "",
    "type __CapnwebValidationOptions = { isRpcPlaceholder?: (value: unknown) => boolean };",
    "type __CapnwebValidationFailure = { path: (string | number)[]; expected: string; actual: string; value: unknown };",
    "",
    "function __capnweb_mismatch(path: (string | number)[], expected: string, value: unknown): __CapnwebValidationFailure {",
    "  return { path, expected, actual: __capnweb_actualKind(value), value };",
    "}",
    "",
    "function __capnweb_missing(path: (string | number)[], expected: string): __CapnwebValidationFailure {",
    "  return { path, expected, actual: \"missing\", value: undefined };",
    "}",
    "",
    "function __capnweb_makeValidationError(prefix: string, failure: __CapnwebValidationFailure): TypeError {",
    "  let where = failure.path.length > 0 ? failure.path.join(\".\") : \"value\";",
    "  let err = new TypeError(prefix + \": \" + where + \": expected \" + failure.expected + \", got \" + failure.actual);",
    "  (err as TypeError & { rpcValidation: __CapnwebValidationFailure }).rpcValidation = failure;",
    "  return err;",
    "}",
    "",
    "function __capnweb_actualKind(value: unknown): string {",
    "  if (value === null) return \"null\";",
    "  if (Array.isArray(value)) return \"array\";",
    "  if (value instanceof Date) return \"Date\";",
    "  if (value instanceof RegExp) return \"RegExp\";",
    "  if (value instanceof Error) return \"Error\";",
    "  if (typeof value === \"object\") {",
    "    let ctor = (value as object).constructor;",
    "    if (ctor && ctor.name && ctor.name !== \"Object\") return ctor.name;",
    "    return \"object\";",
    "  }",
    "  return typeof value;",
    "}",
    "",
    ...emit.lines,
    "export const validators = {",
    classEntries.join(",\n"),
    "};",
    "",
  ];
  return lines.join("\n");
}

type ValidatorEmit = { lines: string[]; nextId: number };

function emitTypeValidator(type: TypeSpec, emit: ValidatorEmit): string {
  let name = "__capnweb_validate_" + emit.nextId++;
  let expected = JSON.stringify(typeDescription(type));
  let lines = [
    "function " + name + "(value: unknown, path: (string | number)[], options?: __CapnwebValidationOptions): __CapnwebValidationFailure | undefined {",
    "  if (options?.isRpcPlaceholder?.(value)) return undefined;",
  ];

  switch (type.kind) {
    case "any":
      lines.push("  return undefined;");
      break;
    case "never":
      lines.push("  return __capnweb_mismatch(path, " + expected + ", value);");
      break;
    case "primitive":
      lines.push("  return " + primitiveCheck("value", type.name) + " ? undefined : __capnweb_mismatch(path, " + expected + ", value);");
      break;
    case "literal":
      lines.push("  return value === " + JSON.stringify(type.value) + " ? undefined : __capnweb_mismatch(path, " + expected + ", value);");
      break;
    case "array": {
      let element = emitTypeValidator(type.element, emit);
      lines.push(
          "  if (!Array.isArray(value)) return __capnweb_mismatch(path, " + expected + ", value);",
          "  for (let i = 0; i < value.length; i++) {",
          "    let failure = " + element + "(value[i], [...path, \"[\" + i + \"]\"], options);",
          "    if (failure) return failure;",
          "  }",
          "  return undefined;");
      break;
    }
    case "tuple": {
      let elements = type.elements.map(element => emitTypeValidator(element, emit));
      lines.push(
          "  if (!Array.isArray(value) || value.length !== " + elements.length + ") return __capnweb_mismatch(path, " + expected + ", value);");
      elements.forEach((element, index) => {
        lines.push(
            "  {",
            "    let failure = " + element + "(value[" + index + "], [...path, \"[" + index + "]\"], options);",
            "    if (failure) return failure;",
            "  }");
      });
      lines.push("  return undefined;");
      break;
    }
    case "map": {
      let key = emitTypeValidator(type.key, emit);
      let value = emitTypeValidator(type.value, emit);
      lines.push(
          "  if (!(value instanceof Map)) return __capnweb_mismatch(path, " + expected + ", value);",
          "  for (let [key, item] of value) {",
          "    let keyFailure = " + key + "(key, [...path, \"<key>\"], options);",
          "    if (keyFailure) return keyFailure;",
          "    let valueFailure = " + value + "(item, [...path, String(key)], options);",
          "    if (valueFailure) return valueFailure;",
          "  }",
          "  return undefined;");
      break;
    }
    case "set": {
      let value = emitTypeValidator(type.value, emit);
      lines.push(
          "  if (!(value instanceof Set)) return __capnweb_mismatch(path, " + expected + ", value);",
          "  let i = 0;",
          "  for (let item of value) {",
          "    let failure = " + value + "(item, [...path, \"[\" + i++ + \"]\"], options);",
          "    if (failure) return failure;",
          "  }",
          "  return undefined;");
      break;
    }
    case "object":
      lines.push(
          "  if (typeof value !== \"object\" || value === null || Array.isArray(value)) return __capnweb_mismatch(path, " + expected + ", value);",
          "  let record = value as Record<string, unknown>;");
      for (let prop of type.props) {
        let propValidator = emitTypeValidator(prop.type, emit);
        let propName = JSON.stringify(prop.name);
        let propPath = "[...path, " + propName + "]";
        if (prop.optional) {
          lines.push(
              "  if (Object.prototype.hasOwnProperty.call(record, " + propName + ") && record[" + propName + "] !== undefined) {",
              "    let failure = " + propValidator + "(record[" + propName + "], " + propPath + ", options);",
              "    if (failure) return failure;",
              "  }");
        } else {
          lines.push(
              "  if (!Object.prototype.hasOwnProperty.call(record, " + propName + ")) return __capnweb_missing(" + propPath + ", " + JSON.stringify(typeDescription(prop.type)) + ");",
              "  {",
              "    let failure = " + propValidator + "(record[" + propName + "], " + propPath + ", options);",
              "    if (failure) return failure;",
              "  }");
        }
      }
      lines.push("  return undefined;");
      break;
    case "record": {
      let value = emitTypeValidator(type.value, emit);
      lines.push(
          "  if (typeof value !== \"object\" || value === null || Array.isArray(value)) return __capnweb_mismatch(path, " + expected + ", value);",
          "  for (let [key, item] of Object.entries(value as Record<string, unknown>)) {",
          "    let failure = " + value + "(item, [...path, key], options);",
          "    if (failure) return failure;",
          "  }",
          "  return undefined;");
      break;
    }
    case "union": {
      let variants = type.variants.map(variant => emitTypeValidator(variant, emit));
      lines.push("  let failures: __CapnwebValidationFailure[] = [];");
      for (let variant of variants) {
        lines.push(
            "  {",
            "    let failure = " + variant + "(value, path, options);",
            "    if (!failure) return undefined;",
            "    failures.push(failure);",
            "  }");
      }
      lines.push("  return failures.find(failure => failure.path.length > path.length) ?? __capnweb_mismatch(path, " + expected + ", value);");
      break;
    }
    case "instance":
      lines.push(
          "  let ctor = (globalThis as Record<string, unknown>)[" + JSON.stringify(type.name) + "];",
          "  return typeof ctor === \"function\" && value instanceof ctor ? undefined : __capnweb_mismatch(path, " + expected + ", value);");
      break;
    case "rpcTarget":
      lines.push("  return value instanceof __capnweb_RpcTarget ? undefined : __capnweb_mismatch(path, " + expected + ", value);");
      break;
    case "stub":
      lines.push("  return value !== null && (typeof value === \"object\" || typeof value === \"function\") ? undefined : __capnweb_mismatch(path, " + expected + ", value);");
      break;
    case "function":
      lines.push("  return typeof value === \"function\" ? undefined : __capnweb_mismatch(path, " + expected + ", value);");
      break;
    case "unsupported":
      lines.push("  return __capnweb_mismatch(path, " + expected + ", value);");
      break;
  }

  lines.push("}", "");
  emit.lines.push(...lines);
  return name;
}

function emitTypePathValidator(type: TypeSpec, emit: ValidatorEmit): string {
  let name = "__capnweb_validate_path_" + emit.nextId++;
  let fullValidator = emitTypeValidator(type, emit);
  let lines = [
    "function " + name + "(path: (string | number)[], value: unknown, offset = 0, options?: __CapnwebValidationOptions): __CapnwebValidationFailure | undefined {",
    "  if (offset >= path.length) return " + fullValidator + "(value, path, options);",
  ];

  switch (type.kind) {
    case "object": {
      lines.push("  switch (path[offset]) {");
      for (let prop of type.props) {
        let child = emitTypePathValidator(prop.type, emit);
        lines.push("    case " + JSON.stringify(prop.name) + ":");
        if (prop.optional) {
          lines.push("      return value === undefined ? undefined : " + child + "(path, value, offset + 1, options);");
        } else {
          lines.push("      return " + child + "(path, value, offset + 1, options);");
        }
      }
      lines.push(
          "    default: return undefined;",
          "  }");
      break;
    }
    case "array": {
      let child = emitTypePathValidator(type.element, emit);
      lines.push("  return " + child + "(path, value, offset + 1, options);");
      break;
    }
    case "tuple": {
      let elements = type.elements.map(element => emitTypePathValidator(element, emit));
      lines.push("  switch (path[offset]) {");
      elements.forEach((element, index) => {
        lines.push(
            "    case " + JSON.stringify(String(index)) + ":",
            "    case " + index + ": return " + element + "(path, value, offset + 1, options);");
      });
      lines.push(
          "    default: return undefined;",
          "  }");
      break;
    }
    case "record": {
      let child = emitTypePathValidator(type.value, emit);
      lines.push("  return " + child + "(path, value, offset + 1, options);");
      break;
    }
    case "map": {
      let child = emitTypePathValidator(type.value, emit);
      lines.push("  return " + child + "(path, value, offset + 1, options);");
      break;
    }
    case "union": {
      let variants = type.variants.map(variant => emitTypePathValidator(variant, emit));
      lines.push("  let failures: __CapnwebValidationFailure[] = [];");
      for (let variant of variants) {
        lines.push(
            "  {",
            "    let failure = " + variant + "(path, value, offset, options);",
            "    if (!failure) return undefined;",
            "    failures.push(failure);",
            "  }");
      }
      lines.push("  return failures.find(failure => failure.path.length > offset) ?? failures[0];");
      break;
    }
    default:
      lines.push("  return undefined;");
      break;
  }

  lines.push("}", "");
  emit.lines.push(...lines);
  return name;
}

function primitiveCheck(value: string, name: string): string {
  switch (name) {
    case "string": return "typeof " + value + " === \"string\"";
    case "number": return "typeof " + value + " === \"number\"";
    case "bigint": return "typeof " + value + " === \"bigint\"";
    case "boolean": return "typeof " + value + " === \"boolean\"";
    case "undefined":
    case "void": return value + " === undefined";
    case "null": return value + " === null";
    default: throw new Error("Unknown primitive type: " + name);
  }
}

function emitMethodValidator(
    className: string, method: MethodSpec, paramValidators: string[],
    returnValidator: string, returnPathValidator: string): string {
  let prefix = className + "." + method.name;
  let minArgs = method.params.reduce((min, param, index) => param.optional ? min : index + 1, 0);
  let expected = minArgs === method.params.length ? String(minArgs) : minArgs + "-" + method.params.length;
  let lines = [
    "    " + JSON.stringify(method.name) + ": {",
    "      args(args: unknown[], options?: __CapnwebValidationOptions): void {",
    "        if (args.length < " + minArgs + " || args.length > " + method.params.length + ") {",
    "          throw new TypeError(" + JSON.stringify(prefix + " expected " + expected + " argument(s), got ") + " + args.length);",
    "        }",
  ];

  method.params.forEach((param, index) => {
    let path = JSON.stringify([param.name]);
    if (param.optional) {
      lines.push(
          "        if (args[" + index + "] !== undefined) {",
          "          let failure = " + paramValidators[index] + "(args[" + index + "], " + path + ", options);",
          "          if (failure) throw __capnweb_makeValidationError(" + JSON.stringify(prefix) + ", failure);",
          "        }");
    } else {
      lines.push(
          "        {",
          "          let failure = " + paramValidators[index] + "(args[" + index + "], " + path + ", options);",
          "          if (failure) throw __capnweb_makeValidationError(" + JSON.stringify(prefix) + ", failure);",
          "        }");
    }
  });

  lines.push(
      "      },",
      "      returns(value: unknown): void {",
      "        let failure = " + returnValidator + "(value, []);",
      "        if (failure) throw __capnweb_makeValidationError(" + JSON.stringify(prefix + " return") + ", failure);",
      "      },",
      "      returnsPath(path: (string | number)[], value: unknown): void {",
      "        let failure = " + returnPathValidator + "(path, value);",
      "        if (failure) throw __capnweb_makeValidationError(" + JSON.stringify(prefix + " return") + ", failure);",
      "      },",
      "    }");
  return lines.join("\n");
}

function typeDescription(type: TypeSpec): string {
  switch (type.kind) {
    case "any": return "any";
    case "never": return "never";
    case "primitive": return type.name === "void" ? "undefined" : type.name;
    case "literal": return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value);
    case "array": return typeDescription(type.element) + "[]";
    case "tuple": return "[" + type.elements.map(typeDescription).join(", ") + "]";
    case "map": return "Map<" + typeDescription(type.key) + ", " + typeDescription(type.value) + ">";
    case "set": return "Set<" + typeDescription(type.value) + ">";
    case "object": return "{ " + type.props.map(p => p.name + (p.optional ? "?" : "") + ": " + typeDescription(p.type)).join(", ") + " }";
    case "record": return "Record<string, " + typeDescription(type.value) + ">";
    case "union": return type.variants.map(typeDescription).sort().join(" | ");
    case "instance": return type.name;
    case "rpcTarget": return "RpcTarget";
    case "stub": return "RpcStub";
    case "function": return "Function";
    case "unsupported": return type.text;
  }
}

function emitValidatorsModule(runtimeImport: string): string {
  return [
    "// Generated by capnweb typecheck gen. Do not edit.",
    "import { __capnweb_registerRpcValidators } from " + JSON.stringify(runtimeImport) + ";",
    "import { validators } from \"./specs.js\";",
    "",
    "export function registerCapnwebValidators(classes: Record<string, Function>): void {",
    "  __capnweb_registerRpcValidators(classes, validators);",
    "}",
    "",
  ].join("\n");
}

function emitClientsModule(classes: ExtractedClassSpec[], runtimeImport: string): string {
  let parts = [
    "// Generated by capnweb typecheck gen. Do not edit.",
    "import { __capnweb_bindClientValidator } from " + JSON.stringify(runtimeImport) + ";",
    "import { validators } from \"./specs.js\";",
    "",
  ];
  for (let klass of classes) {
    let key = JSON.stringify(klass.name);
    parts.push("export function " + wrapFunctionName(klass.name) + "<T>(stub: T): T {");
    parts.push("  return __capnweb_bindClientValidator(stub as object, validators[" + key + "]) as T;");
    parts.push("}");
    parts.push("");
    parts.push("export function " + wrapSessionFunctionName(klass.name) + "<T>(session: T): T {");
    parts.push("  let main = (session as { getRemoteMain(): object }).getRemoteMain();");
    parts.push("  __capnweb_bindClientValidator(main, validators[" + key + "]);");
    parts.push("  return session;");
    parts.push("}");
    parts.push("");
  }
  return parts.join("\n");
}

function emitWorkerEntry(
    importPath: string, hasDefault: boolean, classes: ExtractedClassSpec[],
    outAbs: string, root: string): string {
  let registration = emitRegistrationImportsAndCall(classes, outAbs,
      sourcePath => join(outAbs, "source", relative(root, sourcePath)));
  return `// Generated by capnweb typecheck gen. Do not edit.\n` +
    `import { registerCapnwebValidators } from "./validators.js";\n` +
    `${registration.imports.join("\n")}\n` +
    `registerCapnwebValidators({ ${registration.entries.join(", ")} });\n` +
    `export * from ${JSON.stringify(importPath)};\n` +
    (hasDefault ? `export { default } from ${JSON.stringify(importPath)};\n` : "");
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
  let named = new Map<string, string[]>();
  let defaults: string[] = [];
  for (let klass of classes) {
    if (localSourcePath && klass.sourcePath === localSourcePath) {
      entries.push(`${JSON.stringify(klass.name)}: ${klass.isDefault ? klass.name : klass.valueName}`);
      continue;
    }
    let importPath = jsImportPath(relative(baseDir, sourcePathFor(klass.sourcePath)));
    let alias = `__capnweb_${klass.valueName}`;
    entries.push(`${JSON.stringify(klass.name)}: ${alias}`);
    if (klass.isDefault) defaults.push(`import ${alias} from ${JSON.stringify(importPath)};`);
    else {
      let group = named.get(importPath) ?? [];
      group.push(`${klass.name} as ${alias}`);
      named.set(importPath, group);
    }
  }
  for (let [importPath, group] of named) {
    imports.push(`import { ${group.join(", ")} } from ${JSON.stringify(importPath)};`);
  }
  imports.push(...defaults);
  return { imports, entries };
}

function makeGenResult(classes: ExtractedClassSpec[]): GenResult {
  return {
    classes: classes.map(c => c.name),
    registrations: classes.map(({ name, valueName, isDefault, sourcePath }) =>
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
