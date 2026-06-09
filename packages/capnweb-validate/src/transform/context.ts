// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Long-lived state shared across per-module transforms in one build. One instance per plugin.

import { basename, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

import type { ValidationMode } from "../internal/core.js";

export type TransformContextOptions = {
  /** Path to the tsconfig.json that defines the TS Program. */
  tsconfig?: string;
  /** Optional include glob list layered on top of TS rootNames. */
  include?: string[];
  /** Optional exclude glob list layered on top of TS rootNames. */
  exclude?: string[];
  /** Working directory used to resolve relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** How a failed server-side check is handled: "throw" (default) raises a TypeError; "warn" logs and lets the value through. */
  serverValidation?: ValidationMode;
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function hasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

function escapeRegexChar(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; ) {
    let char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      source += "[^/]";
      i++;
    } else {
      source += escapeRegexChar(char);
      i++;
    }
  }
  return new RegExp(`${source}$`);
}

function matchesPattern(
  fileName: string,
  cwd: string,
  pattern: string
): boolean {
  let clean = fileName.split("?", 1)[0]!.split("#", 1)[0]!;
  let abs = normalizePath(resolve(cwd, clean));
  let rel = normalizePath(relative(cwd, abs));
  let normalizedPattern = normalizePath(pattern);
  let target = isAbsolute(pattern) ? abs : rel;

  if (!hasGlob(normalizedPattern)) {
    let bare = normalizedPattern.replace(/\/$/, "");
    return (
      target === bare ||
      target.startsWith(`${bare}/`) ||
      (!bare.includes("/") && basename(target) === bare)
    );
  }

  return globToRegExp(normalizedPattern).test(target);
}

export function fileMatchesTransformFilters(
  fileName: string,
  options: TransformContextOptions = {}
): boolean {
  let cwd = resolve(options.cwd ?? process.cwd());
  let include = options.include;
  let exclude = options.exclude;
  if (
    include?.length &&
    !include.some((p) => matchesPattern(fileName, cwd, p))
  ) {
    return false;
  }
  if (exclude?.some((p) => matchesPattern(fileName, cwd, p))) {
    return false;
  }
  return true;
}

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
  let publicOptions: TransformContextOptions = { ...options, cwd };
  let program: ts.Program | null = null;
  let checker: ts.TypeChecker | null = null;

  function ensureProgram(): ts.Program {
    if (program) return program;

    // An explicit path resolves directly; otherwise walk up from cwd. Either
    // way, a missing file yields the same actionable error below rather than a
    // lower-level read failure.
    let tsconfigPath = options.tsconfig
      ? resolve(cwd, options.tsconfig)
      : ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
    if (!tsconfigPath || !ts.sys.fileExists(tsconfigPath)) {
      throw new Error(
        `capnweb-validate: tsconfig not found ` +
        `(${tsconfigPath ?? `tsconfig.json, cwd=${cwd}`}). ` +
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
    options: publicOptions,

    listSourceFiles(): Iterable<string> {
      let prog = ensureProgram();
      let files: string[] = [];
      for (let sf of prog.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (sf.fileName.includes("/node_modules/")) continue;
        if (!fileMatchesTransformFilters(sf.fileName, { ...options, cwd })) {
          continue;
        }
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

    invalidateFile(_id: string): void {
      // Drop the whole Program: any file change can shift resolved types elsewhere, and
      // rebuild is a flat ~30-95ms (lib load/bind floor), so oldProgram reuse isn't worth the stale-type risk.
      rebuildProgram();
    },

    dispose(): void {
      program = null;
      checker = null;
    },
  };
}
