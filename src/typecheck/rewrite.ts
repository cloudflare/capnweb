// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import * as fs from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import type { SourceFile } from "./extract.js";

export function wrapFunctionName(className: string): string {
  return `__capnweb_wrap_${className}`;
}

export function wrapSessionFunctionName(className: string): string {
  return `__capnweb_wrap_RpcSession_${className}`;
}

const STUB_FACTORY_NAMES = new Set([
  "newHttpBatchRpcSession",
  "newWebSocketRpcSession",
  "newMessagePortRpcSession",
]);

const SESSION_CONSTRUCTOR_NAME = "RpcSession";

export function emitShadowSources(
    sourceFiles: SourceFile[], entry: SourceFile, outAbs: string, commonRoot: string,
    classNames: string[]): string {
  let shadowRoot = join(outAbs, "source");
  let classSet = new Set(classNames);
  let entryShadow = "";

  for (let file of sourceFiles) {
    let originalPath = file.fileName;
    let relativePath = relative(commonRoot, originalPath);
    let shadowPath = join(shadowRoot, relativePath);
    fs.mkdirSync(dirname(shadowPath), { recursive: true });

    let clientsImport = jsImportPath(relative(dirname(shadowPath), join(outAbs, "clients.ts")));
    let transformed = transformClientCalls(file, classSet, clientsImport);
    fs.writeFileSync(shadowPath, transformed);
    copyRelativeAssets(file, shadowPath, shadowRoot);

    if (originalPath === entry.fileName) entryShadow = shadowPath;
  }

  return entryShadow || entry.fileName;
}

function copyRelativeAssets(file: SourceFile, shadowPath: string, shadowRoot: string): void {
  let copySpecifier = (specifier: string) => {
    if (!specifier.startsWith(".")) return;
    if (resolveTypeScriptImport(dirname(file.fileName), specifier)) return;

    let assetSpecifier = specifier.split(/[?#]/, 1)[0];
    let sourcePath = resolve(dirname(file.fileName), assetSpecifier);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`Cannot copy relative asset import ${JSON.stringify(specifier)} ` +
          `from ${file.fileName}.`);
    }

    let destPath = resolve(dirname(shadowPath), assetSpecifier);
    if (!isPathInside(shadowRoot, destPath)) {
      throw new Error(`Relative asset import ${JSON.stringify(specifier)} from ` +
          `${file.fileName} would escape the generated shadow source tree.`);
    }
    fs.mkdirSync(dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
  };

  for (let statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      copySpecifier(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)) {
      copySpecifier(statement.moduleSpecifier.text);
    }
  }
}

function resolveTypeScriptImport(baseDir: string, specifier: string): string | undefined {
  let clean = specifier.split(/[?#]/, 1)[0];
  let base = resolve(baseDir, clean);
  let candidates = [base];
  let ext = extname(base);
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    candidates.push(base.slice(0, -ext.length) + ".ts");
    candidates.push(base.slice(0, -ext.length) + ".tsx");
    candidates.push(base.slice(0, -ext.length) + ".mts");
    candidates.push(base.slice(0, -ext.length) + ".cts");
  }
  for (let candidate of candidates) {
    if (isTypeScriptSource(candidate) && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isTypeScriptSource(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path) && !/\.d\.(?:ts|mts|cts)$/.test(path);
}

function isPathInside(parent: string, child: string): boolean {
  let rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(rel));
}

export function transformClientCalls(
    source: string | SourceFile, knownClasses: Set<string>,
    clientsImport: string, fileName = "capnweb-rewrite-input.ts"): string {
  let sourceFile = typeof source === "string"
      ? ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2023, true, scriptKindFor(fileName))
      : source;
  let code = sourceFile.getFullText();
  let imports = collectCapnwebImports(sourceFile);
  let rewrites = findClientRewrites(sourceFile, knownClasses, imports);
  if (rewrites.length === 0) return code;

  let usedNames = new Set<string>();
  for (let edit of rewrites) usedNames.add(nameForRewrite(edit));

  rewrites.sort((a, b) => b.start - a.start);
  let result = code;
  for (let edit of rewrites) {
    let original = result.slice(edit.start, edit.end);
    result = result.slice(0, edit.start) + `${nameForRewrite(edit)}(${original})` +
        result.slice(edit.end);
  }

  let importStatement = `import { ${[...usedNames].sort().join(", ")} } from ${JSON.stringify(clientsImport)};\n`;
  let insertAt = importInsertionPoint(sourceFile);
  let prefix = result.slice(0, insertAt);
  if (prefix && !prefix.endsWith("\n")) prefix += "\n";
  return prefix + importStatement + result.slice(insertAt);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.split(/[?#]/, 1)[0].endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function importInsertionPoint(sourceFile: SourceFile): number {
  let code = sourceFile.getFullText();
  let point = 0;
  if (code.startsWith("#!")) {
    let newline = code.indexOf("\n");
    point = newline < 0 ? code.length : newline + 1;
  }

  for (let statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
      point = statement.end;
    } else {
      break;
    }
  }
  return point;
}

function nameForRewrite(edit: ClientRewrite): string {
  return edit.kind === "session" ? wrapSessionFunctionName(edit.className) :
      wrapFunctionName(edit.className);
}

type ClientRewrite = { start: number; end: number; className: string; kind: "stub" | "session" };

type ImportedBinding = { original: string; alias: string };

type ImportedFactories = {
  stubAliasToName: Map<string, ImportedBinding>;
  sessionAliasToName: Map<string, ImportedBinding>;
  typeAliasToName: Map<string, ImportedBinding>;
  namespaces: Set<string>;
};

function collectCapnwebImports(sourceFile: SourceFile): ImportedFactories {
  let stubAliasToName = new Map<string, ImportedBinding>();
  let sessionAliasToName = new Map<string, ImportedBinding>();
  let typeAliasToName = new Map<string, ImportedBinding>();
  let namespaces = new Set<string>();

  for (let statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause) continue;

    let isCapnweb = statement.moduleSpecifier.text === "capnweb";
    let named = statement.importClause.namedBindings;
    if (isCapnweb && named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
    if (!named || !ts.isNamedImports(named)) continue;

    for (let spec of named.elements) {
      let original = (spec.propertyName ?? spec.name).text;
      let alias = spec.name.text;
      typeAliasToName.set(alias, { original, alias });
      if (!isCapnweb) continue;
      if (STUB_FACTORY_NAMES.has(original)) {
        stubAliasToName.set(alias, { original, alias });
      } else if (original === SESSION_CONSTRUCTOR_NAME) {
        sessionAliasToName.set(alias, { original, alias });
      }
    }
  }

  return { stubAliasToName, sessionAliasToName, typeAliasToName, namespaces };
}

function findClientRewrites(
    sourceFile: SourceFile, knownClasses: Set<string>, imports: ImportedFactories): ClientRewrite[] {
  let edits: ClientRewrite[] = [];
  let visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && callsKnownStubFactory(node.expression, imports)) {
      let rewrite = rewriteForTypedExpression(node, knownClasses, imports, "stub");
      if (rewrite) edits.push(rewrite);
    } else if (ts.isNewExpression(node) && callsKnownSessionConstructor(node.expression, imports)) {
      let rewrite = rewriteForTypedExpression(node, knownClasses, imports, "session");
      if (rewrite) edits.push(rewrite);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edits;
}

function callsKnownStubFactory(expr: ts.Expression, imports: ImportedFactories): boolean {
  if (ts.isIdentifier(expr)) {
    return imports.stubAliasToName.has(expr.text) && !isShadowed(expr, expr.text);
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return imports.namespaces.has(expr.expression.text) && !isShadowed(expr.expression, expr.expression.text) &&
        STUB_FACTORY_NAMES.has(expr.name.text);
  }
  return false;
}

function callsKnownSessionConstructor(expr: ts.Expression, imports: ImportedFactories): boolean {
  if (ts.isIdentifier(expr)) {
    return imports.sessionAliasToName.has(expr.text) && !isShadowed(expr, expr.text);
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return imports.namespaces.has(expr.expression.text) && !isShadowed(expr.expression, expr.expression.text) &&
        expr.name.text === SESSION_CONSTRUCTOR_NAME;
  }
  return false;
}

function rewriteForTypedExpression(
    node: ts.CallExpression | ts.NewExpression, knownClasses: Set<string>,
    imports: ImportedFactories, kind: "stub" | "session"): ClientRewrite | undefined {
  let typeArg = node.typeArguments?.[0];
  if (!typeArg || !ts.isTypeReferenceNode(typeArg) || !ts.isIdentifier(typeArg.typeName)) return undefined;
  let typeName = typeArg.typeName.text;
  let importedType = imports.typeAliasToName.get(typeName);
  if (importedType) typeName = importedType.original;
  if (!/^[$A-Z_a-z][$\w]*$/.test(typeName) || !knownClasses.has(typeName)) return undefined;
  return { start: node.getStart(), end: node.getEnd(), className: typeName, kind };
}

function isShadowed(node: ts.Identifier, name: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if ((ts.isFunctionLike(current) || ts.isSourceFile(current)) && declaresName(current, name, node.pos)) return true;
    current = current.parent;
  }
  return false;
}

function declaresName(scope: ts.Node, name: string, before: number): boolean {
  let found = false;
  let visit = (node: ts.Node) => {
    if (found || node.pos > before) return;
    if (ts.isImportDeclaration(node)) return;
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      let id = "name" in node && node.name && ts.isIdentifier(node.name) ? node.name : undefined;
      if (id?.text === name) found = true;
    }
    if (node !== scope && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

function jsImportPath(path: string): string {
  let normalized = path.split(/[/\\]+/).join("/");
  let ext = extname(normalized);
  if (ext) normalized = normalized.slice(0, -ext.length) + ".js";
  if (!normalized.startsWith("./") && !normalized.startsWith("../")) normalized = "./" + normalized;
  return normalized;
}
