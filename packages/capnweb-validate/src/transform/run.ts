// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Build-time driver used by the CLI. Walks the configured source set,
// runs the per-module transform, and writes results under `out`. Files
// the transform leaves alone are copied verbatim so `out/` is a complete
// drop-in replacement for the original source tree.

import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

import {
  createTransformContext,
  TransformContextOptions,
} from "./context.js";
import { transformModule } from "./transform-module.js";

export type BuildOptions = TransformContextOptions & {
  out: string;
};

export type BuildResult = {
  transformed: number;
  copied: number;
  /** Source files skipped because they map outside --out (outside cwd). */
  skipped: number;
};

function isInsideOrEqual(parent: string, child: string): boolean {
  let rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

const SKIP_PATH_PARTS = new Set([".git", ".hg", ".svn", "node_modules"]);

function isTypeScriptFile(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path);
}

function cleanSpecifier(specifier: string): string {
  return specifier.split("?", 1)[0]!.split("#", 1)[0]!;
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function hasIgnoredPathPart(path: string, cwd: string): boolean {
  return relative(cwd, path)
    .split(/[\\/]/)
    .some((part) => SKIP_PATH_PARTS.has(part));
}

function collectAssetRefs(code: string, importer: string): string[] {
  let out: string[] = [];
  let sf = ts.createSourceFile(importer, code, ts.ScriptTarget.Latest, true);
  function add(specifier: string | undefined): void {
    if (!specifier) return;
    let clean = cleanSpecifier(specifier);
    if (!clean.startsWith("./") && !clean.startsWith("../")) return;
    if (!extname(clean)) return;
    let resolved = resolve(dirname(importer), clean);
    if (!isTypeScriptFile(resolved)) out.push(resolved);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      if (importHasRuntimeBindings(node.importClause)) {
        add(literalText(node.moduleSpecifier));
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (exportHasRuntimeBindings(node)) {
        add(literalText(node.moduleSpecifier));
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      add(literalText(node.arguments[0]));
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      isImportMetaUrl(node.arguments?.[1])
    ) {
      add(literalText(node.arguments?.[0]));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

function importHasRuntimeBindings(
  clause: ts.ImportClause | undefined
): boolean {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  let bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  if (bindings.elements.length === 0) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntimeBindings(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  let clause = node.exportClause;
  if (!clause) return true;
  if (ts.isNamespaceExport(clause)) return true;
  if (clause.elements.length === 0) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function isImportMetaUrl(node: ts.Node | undefined): boolean {
  return !!(
    node &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta"
  );
}

async function hasSymlinkParentPathPart(
  path: string,
  cwd: string
): Promise<boolean> {
  let rel = relative(cwd, path);
  let current = cwd;
  let parts = rel.split(/[\\/]/);
  for (let part of parts.slice(0, -1)) {
    if (!part) continue;
    current = resolve(current, part);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return false;
      throw err;
    }
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  let cwd = resolve(options.cwd ?? process.cwd());
  let out = resolve(cwd, options.out);
  if (isInsideOrEqual(out, cwd)) {
    throw new Error(
      `capnweb-validate: --out must not be the project directory or a parent ` +
      `of it (cwd=${cwd}, out=${out}).`,
    );
  }
  if (await hasSymlinkParentPathPart(out, cwd)) {
    throw new Error(
      `capnweb-validate: --out must not be inside a symlinked directory ` +
      `(cwd=${cwd}, out=${out}).`,
    );
  }

  // Remove stale output before building. Do this before creating the TS Program
  // so deleted/renamed files from a previous run cannot stay in the source set.
  await rm(out, { recursive: true, force: true });

  let context = createTransformContext({
    ...options,
    tsconfig: options.tsconfig ?? "tsconfig.json",
  });
  let transformed = 0;
  let copied = 0;
  let skippedOutside: string[] = [];
  let written = new Set<string>();
  let assetRefs = new Set<string>();
  try {
    for (let id of context.listSourceFiles()) {
      if (isInsideOrEqual(out, id)) continue;
      let dest = resolve(out, relative(cwd, id));
      // A source file outside cwd (e.g. an included sibling dir) maps to a dest
      // that escapes --out and could clobber unrelated files. Skip it rather
      // than write outside the requested output tree; warned once below.
      if (!isInsideOrEqual(out, dest)) {
        skippedOutside.push(id);
        continue;
      }
      let code = await readFile(id, "utf8");
      for (let asset of collectAssetRefs(code, id)) assetRefs.add(asset);
      let result = transformModule(context, id, code);
      await mkdir(dirname(dest), { recursive: true });
      if (result) {
        await writeFile(dest, result.code);
        transformed++;
      } else {
        await writeFile(dest, code);
        copied++;
      }
      written.add(dest);
    }
  } finally {
    context.dispose();
  }

  copied += await copyAssets(assetRefs, cwd, out, written);
  // One consolidated warning, not one per file (shared sibling dirs are common).
  if (skippedOutside.length > 0) {
    console.warn(
      `capnweb-validate: skipped ${skippedOutside.length} file(s) outside the ` +
      `project directory (cwd=${cwd}); they cannot be written under --out, so ` +
      `they are not validated (e.g. ${skippedOutside[0]}).`,
    );
  }
  return { transformed, copied, skipped: skippedOutside.length };
}

async function copyAssets(
  assets: Set<string>,
  cwd: string,
  out: string,
  written: Set<string>
): Promise<number> {
  let copied = 0;
  let realCwd = await realpath(cwd);
  let realOut = await realpath(out).catch(() => out);
  for (let src of assets) {
    if (!isInsideOrEqual(cwd, src)) continue;
    if (isInsideOrEqual(out, src)) continue;
    if (hasIgnoredPathPart(src, cwd)) continue;
    let dest = resolve(out, relative(cwd, src));
    if (written.has(dest)) continue;
    if (!isInsideOrEqual(out, dest)) continue;
    let stat: Awaited<ReturnType<typeof lstat>>;
    let copyFrom = src;
    try {
      if (await hasSymlinkParentPathPart(src, cwd)) continue;
      stat = await lstat(src);
      if (stat.isSymbolicLink()) {
        let realSrc = await realpath(src);
        if (!isInsideOrEqual(realCwd, realSrc)) continue;
        if (isInsideOrEqual(realOut, realSrc)) continue;
        if (hasIgnoredPathPart(realSrc, realCwd)) continue;
        copyFrom = realSrc;
        stat = await lstat(realSrc);
      }
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(copyFrom, dest);
    written.add(dest);
    copied++;
  }
  return copied;
}
