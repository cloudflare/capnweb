// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Long-lived state shared across per-module transforms in one build. One instance per plugin.

import { resolve } from "node:path";
import ts from "typescript";

import type { ValidationMode } from "../internal/core.js";
import type { UnsupportedTypeHandler } from "./type-introspector.js";

export type TransformContextOptions = {
  /** Path to the tsconfig.json that defines the TS Program. */
  tsconfig?: string;
  /** Optional include glob list layered on top of TS rootNames. */
  include?: string[];
  /** Optional exclude glob list layered on top of TS rootNames. */
  exclude?: string[];
  /** Working directory used to resolve relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** How a failed client-side check is handled: "throw" (default) raises an RpcValidationError; "warn" logs and lets the value through. */
  clientValidation?: ValidationMode;
  /** How a failed server-side check is handled: "throw" (default) raises an RpcValidationError; "warn" logs and lets the value through. */
  serverValidation?: ValidationMode;
  /** Decide what to do with a type capnweb does not transport. Return "passthrough" to accept it as `any` (e.g. a host like Workers RPC that accepts more types); default is a build error. */
  onUnsupportedType?: UnsupportedTypeHandler;
};

export interface TransformContext {
  readonly options: TransformContextOptions;
  /** Absolute paths of every `.ts`/`.tsx` file the build should consider. */
  listSourceFiles(): Iterable<string>;
  /** The shared TypeScript checker. Lazily built on first call. */
  getChecker(): ts.TypeChecker;
  /** The shared TypeScript program. Same lifecycle as the checker. */
  getProgram(): ts.Program;
  /** Resolve a `ts.SourceFile` for the given absolute path, or undefined. */
  getSourceFile(id: string): ts.SourceFile | undefined;
  /** Drop the cached source file for `id` so the next access re-parses it. */
  invalidateFile(id: string): void;
  /** Release any retained resources. Called on `buildEnd`. */
  dispose(): void;
}

export function createTransformContext(
    options: TransformContextOptions = {}): TransformContext {
  let cwd = resolve(options.cwd ?? process.cwd());
  let program: ts.Program | null = null;
  let checker: ts.TypeChecker | null = null;
  /** Cache of `id` -> mtime/version we last parsed at. Invalidation bumps this. */
  let fileVersions = new Map<string, number>();
  let invalidated = new Set<string>();

  function ensureProgram(): ts.Program {
    if (program) return program;

    let tsconfigPath = options.tsconfig
      ? resolve(cwd, options.tsconfig)
      : ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
    if (!tsconfigPath) {
      throw new Error(
        `capnweb-validate: tsconfig.json not found (cwd=${cwd}). ` +
        `Pass \`tsconfig\` to capnwebValidate({...}) or run from a directory ` +
        `with a tsconfig.`,
      );
    }

    let parsed = readParsedConfig(tsconfigPath);
    let host = ts.createCompilerHost(parsed.options, /* setParentNodes */ true);
    program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      host,
    });
    checker = program.getTypeChecker();
    for (let sf of program.getSourceFiles()) {
      if (!sf.isDeclarationFile) fileVersions.set(sf.fileName, 0);
    }
    return program;
  }

  function readParsedConfig(tsconfigPath: string): ts.ParsedCommandLine {
    let raw = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (raw.error) {
      throw new Error(
        `capnweb-validate: failed to read ${tsconfigPath}: ` +
        ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"),
      );
    }
    let parsed = ts.parseJsonConfigFileContent(
      raw.config,
      ts.sys,
      resolve(tsconfigPath, ".."),
      /* existingOptions */ undefined,
      tsconfigPath,
    );
    return parsed;
  }

  function rebuildProgram(): void {
    // Any source change can affect resolved types elsewhere, so rebuild the
    // Program lazily on the next access.
    program = null;
    checker = null;
  }

  return {
    options,

    listSourceFiles(): Iterable<string> {
      let prog = ensureProgram();
      let files: string[] = [];
      for (let sf of prog.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (sf.fileName.includes("/node_modules/")) continue;
        files.push(sf.fileName);
      }
      return files;
    },

    getChecker(): ts.TypeChecker {
      ensureProgram();
      return checker!;
    },

    getProgram(): ts.Program {
      return ensureProgram();
    },

    getSourceFile(id: string): ts.SourceFile | undefined {
      return ensureProgram().getSourceFile(id);
    },

    invalidateFile(id: string): void {
      invalidated.add(id);
      fileVersions.set(id, (fileVersions.get(id) ?? 0) + 1);
      // Drop the whole Program: any file change can shift resolved types elsewhere, and
      // rebuild is a flat ~30-95ms (lib load/bind floor), so oldProgram reuse isn't worth the stale-type risk.
      rebuildProgram();
    },

    dispose(): void {
      program = null;
      checker = null;
      fileVersions.clear();
      invalidated.clear();
    },
  };
}
