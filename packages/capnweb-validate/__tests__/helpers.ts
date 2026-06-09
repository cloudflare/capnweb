// Shared fixtures for transform tests: build an in-memory TypeScript project,
// run the real transform, and return the generated code plus any warnings.
import {
  createFSBackedSystem,
  createVirtualCompilerHost,
} from "@typescript/vfs";
import ts from "typescript";
import * as cw from "../src/internal/core.js";
import type {
  MethodSpec,
  ServiceValidator,
  Validator,
} from "../src/internal/core.js";
import type {
  TransformContext,
  TransformContextOptions,
} from "../src/transform/context.js";
import { transformModule } from "../src/transform/transform-module.js";

/** Base capnweb shim: RpcTarget plus the server marker. */
export const SHIM = `declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
}
declare module "capnweb-validate/capnweb" {
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}`;

/** SHIM plus the decorator markers, for @validateRpc / @skipRpcValidation tests. */
export const DECORATOR_SHIM = `${SHIM}
declare module "capnweb-validate" {
  export function validateRpc<T = unknown>(): any;
  export function skipRpcValidation(...a: unknown[]): unknown;
}`;

export type FixtureOptions = {
  /** Ambient .d.ts contents. Defaults to SHIM. */
  shim?: string;
  /** tsconfig `lib` list. Defaults to ["es2022", "DOM"]. */
  lib?: string[];
  /** Extra compiler options layered over the default virtual project options. */
  compilerOptions?: ts.CompilerOptions;
  /** Additional virtual files, keyed by path relative to the virtual project root. */
  files?: Record<string, string>;
  /** Additional virtual files to include as Program roots. */
  rootFiles?: string[];
  /** Import lines prepended to the body. Defaults to the server marker + RpcTarget. */
  imports?: string;
  /** When set, append a handler returning newWorkersRpcResponse(req, <target>). */
  target?: string;
};

export type FixtureResult = { code: string; warns: string[] };

export type CheckedMethodSpec = Extract<
  MethodSpec,
  { returns: Validator }
>;

export type VirtualTransformContextOptions = Pick<
  FixtureOptions,
  "shim" | "lib" | "compilerOptions" | "files" | "rootFiles"
> & {
  /** Virtual worker.ts contents. */
  worker?: string;
};

const DEFAULT_IMPORTS =
  `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";\n` +
  `import { RpcTarget } from "capnweb";\n`;

const VIRTUAL_ROOT = "/capnweb-validate-vfs";
const SHIM_PATH = `${VIRTUAL_ROOT}/capnweb.d.ts`;
const WORKER_PATH = `${VIRTUAL_ROOT}/worker.ts`;

function virtualPath(path: string): string {
  return path.startsWith("/") ? path : `${VIRTUAL_ROOT}/${path}`;
}

function normalizeLibName(lib: string): string {
  let name = lib.toLowerCase();
  return name.startsWith("lib.") ? name : `lib.${name}.d.ts`;
}

function createVirtualContext(
  files: Map<string, string>,
  rootNames: string[],
  compilerOptions: ts.CompilerOptions
): TransformContext {
  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    types: [],
    ...compilerOptions,
    lib: (compilerOptions.lib ?? ["es2022", "DOM"]).map(normalizeLibName),
  };
  let sys = createFSBackedSystem(files, process.cwd(), ts);
  let { compilerHost } = createVirtualCompilerHost(sys, options, ts);
  compilerHost.getCurrentDirectory = () => VIRTUAL_ROOT;
  let program = ts.createProgram({
    rootNames,
    options,
    host: compilerHost,
  });
  let checker = program.getTypeChecker();
  let contextOptions: TransformContextOptions = { cwd: VIRTUAL_ROOT };

  return {
    options: contextOptions,
    listSourceFiles() {
      return program
        .getSourceFiles()
        .filter(
          (sf) =>
            !sf.isDeclarationFile && sf.fileName.startsWith(`${VIRTUAL_ROOT}/`)
        )
        .map((sf) => sf.fileName);
    },
    getChecker() {
      return checker;
    },
    getProgram() {
      return program;
    },
    getSourceFile(id) {
      return program.getSourceFile(id);
    },
    invalidateFile() {},
    dispose() {},
  };
}

export function createVirtualTransformContext(
  opts: VirtualTransformContextOptions = {}
): TransformContext {
  let files = new Map<string, string>([
    [SHIM_PATH, opts.shim ?? SHIM],
    [WORKER_PATH, opts.worker ?? ""],
  ]);
  for (let [path, source] of Object.entries(opts.files ?? {})) {
    files.set(virtualPath(path), source);
  }
  let rootNames = [
    SHIM_PATH,
    WORKER_PATH,
    ...(opts.rootFiles ?? []).map(virtualPath),
  ];
  return createVirtualContext(files, rootNames, {
    ...opts.compilerOptions,
    lib: opts.compilerOptions?.lib ?? opts.lib ?? ["es2022", "DOM"],
  });
}

/**
 * Transform `body` in a virtual project, capturing console.warn. Returns the
 * generated `code` and `warns`. Throws if the transform reports a build error.
 */
export function transformFixture(
  body: string,
  opts: FixtureOptions = {}
): FixtureResult {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: unknown) => {
    warns.push(String(m));
  };
  try {
    const imports = opts.imports ?? DEFAULT_IMPORTS;
    const tail = opts.target
      ? `\nexport function handler(req: Request): Promise<Response> { return newWorkersRpcResponse(req, ${opts.target}); }`
      : "";
    const code = imports + body + tail;
    const ctx = createVirtualTransformContext({
      shim: opts.shim,
      lib: opts.lib,
      compilerOptions: opts.compilerOptions,
      files: opts.files,
      rootFiles: opts.rootFiles,
      worker: code,
    });
    try {
      const r = transformModule(ctx, WORKER_PATH, code);
      if (!r) throw new Error("transformModule returned null");
      return { code: r.code, warns };
    } finally {
      ctx.dispose();
    }
  } finally {
    console.warn = origWarn;
  }
}

/** The build error message, or throws if the transform unexpectedly succeeds. */
export function transformError(body: string, opts: FixtureOptions = {}): string {
  try {
    transformFixture(body, opts);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a build error but transform succeeded");
}

export function loadValidator(
  code: string,
  binding = "__capnweb_validate_Api_server"
): ServiceValidator {
  const runtimeImports = [
    `import * as __cw from "capnweb-validate/internal/core";\n`,
    `import * as __cw from "capnweb-validate/internal/capnweb";\n`,
  ];
  const runtimeImport = runtimeImports.find((text) => code.startsWith(text));
  if (!runtimeImport) {
    throw new Error("validator runtime import not found in:\n" + code);
  }

  const start = runtimeImport.length;
  let end = code.length;
  for (let lineStart = start; lineStart < code.length; ) {
    let lineEnd = code.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = code.length;
    let line = code.slice(lineStart, lineEnd);
    if (line.trimStart().startsWith("import ")) {
      end = lineStart;
      break;
    }
    lineStart = lineEnd + 1;
  }
  const declarations = code.slice(start, end);

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("__cw", `${declarations}\nreturn ${binding};`)(
    cw
  ) as ServiceValidator;
}

export function checkedMethod(
  validator: ServiceValidator,
  name: string
): CheckedMethodSpec {
  const spec = validator.methods[name];
  if (!spec || spec.unchecked === true) {
    throw new Error(`expected checked method ${name}`);
  }
  return spec as CheckedMethodSpec;
}

export function accepts(validator: Validator, value: unknown): boolean {
  try {
    validator(value, []);
    return true;
  } catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
}

export function validatorShape(
  validator: Validator
): Record<string, unknown> | undefined {
  const symbol = Object.getOwnPropertySymbols(validator).find(
    (s) => s.description === "capnweb-validate.validatorShape"
  );
  return symbol
    ? (validator as Record<symbol, Record<string, unknown> | undefined>)[symbol]
    : undefined;
}
