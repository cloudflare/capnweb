// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import * as fs from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import {
  CallExpression,
  NewExpression,
  Node,
  Project,
  ScriptTarget,
  ts,
  type SourceFile,
} from "ts-morph";
/**
 * Names of the wrap-factory functions the rewriter calls. Each is exported
 * from the generated `clients.ts`; the rewriter chooses one per typed factory
 * call in user source. Kept in sync with the matching emit in `generate.ts`.
 *
 * Two flavors:
 *   - `__capnweb_wrap_<ClassName>` accepts an `RpcStub<T>` and binds return
 *     validators directly on it. Used for the three stub-returning helpers.
 *   - `__capnweb_wrap_RpcSession_<ClassName>` accepts an `RpcSession<T>`,
 *     binds validators on `session.getRemoteMain()`, and returns the session
 *     unchanged so the caller still has `getRemoteMain`, `drain`, etc.
 */
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
    let originalPath = file.getFilePath();
    let relativePath = relative(commonRoot, originalPath);
    let shadowPath = join(shadowRoot, relativePath);
    fs.mkdirSync(dirname(shadowPath), { recursive: true });

    let clientsImport = jsImportPath(
        relative(dirname(shadowPath), join(outAbs, "clients.ts")));
    let transformed = transformClientCalls(file, classSet, clientsImport);
    fs.writeFileSync(shadowPath, transformed);
    copyRelativeAssets(file, shadowPath, shadowRoot);

    if (originalPath === entry.getFilePath()) {
      entryShadow = shadowPath;
    }
  }

  return entryShadow || entry.getFilePath();
}

function copyRelativeAssets(file: SourceFile, shadowPath: string, shadowRoot: string): void {
  let copySpecifier = (specifier: string, target: SourceFile | undefined) => {
    if (!specifier.startsWith(".")) return;
    if (target && isTypeScriptSource(target.getFilePath())) return;

    let assetSpecifier = specifier.split(/[?#]/, 1)[0];
    let sourcePath = target?.getFilePath() ?? resolve(dirname(file.getFilePath()), assetSpecifier);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`Cannot copy relative asset import ${JSON.stringify(specifier)} ` +
          `from ${file.getFilePath()}.`);
    }

    let destPath = resolve(dirname(shadowPath), assetSpecifier);
    if (!isPathInside(shadowRoot, destPath)) {
      throw new Error(`Relative asset import ${JSON.stringify(specifier)} from ` +
          `${file.getFilePath()} would escape the generated shadow source tree.`);
    }
    fs.mkdirSync(dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
  };

  for (let importDecl of file.getImportDeclarations()) {
    copySpecifier(importDecl.getModuleSpecifierValue(), importDecl.getModuleSpecifierSourceFile());
  }
  for (let exportDecl of file.getExportDeclarations()) {
    let specifier = exportDecl.getModuleSpecifierValue();
    if (specifier !== undefined) copySpecifier(specifier, exportDecl.getModuleSpecifierSourceFile());
  }
}

function isTypeScriptSource(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path) &&
      !/\.d\.(?:ts|mts|cts)$/.test(path);
}

function isPathInside(parent: string, child: string): boolean {
  let rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(rel));
}

/**
 * Rewrite typed RPC session creations so the returned stub or session gets
 * its return-value validators bound to it.
 *
 * Two shapes are recognized:
 *   - `newHttpBatchRpcSession<Api>(...)` / `newWebSocketRpcSession<Api>(...)` /
 *     `newMessagePortRpcSession<Api>(...)` -- the call returns an `RpcStub<Api>`;
 *     wrap with `__capnweb_wrap_Api(...)`, which binds validators on it.
 *   - `new RpcSession<Api>(transport, ...)` -- the constructor returns an
 *     `RpcSession<Api>` whose `getRemoteMain()` is the stub we care about;
 *     wrap with `__capnweb_wrap_RpcSession_Api(...)`, which calls
 *     `session.getRemoteMain()` once, binds validators on that stub, and
 *     returns the session unchanged so the caller still has `getRemoteMain`,
 *     `getStats`, `drain`, etc.
 *
 * Calls without a type argument, or with a type argument that isn't a known
 * RpcTarget class, are left alone. The TypeScript caller "opted out" of
 * typing, so we opt out of runtime validation in the same place.
 */
export function transformClientCalls(
    source: string | SourceFile, knownClasses: Set<string>,
    clientsImport: string, fileName = "capnweb-rewrite-input.ts"): string {
  let sourceFile = typeof source === "string" ? parseSource(source, fileName) : source;
  let code = sourceFile.getFullText();
  let imports = collectCapnwebImports(sourceFile);
  let rewrites = findClientRewrites(sourceFile, knownClasses, imports);
  if (rewrites.length === 0) return code;

  // Collect the exact set of wrap names actually used so we only import what
  // the file references. Separate stub-shape and session-shape so option-A
  // dispatch stays statically typed.
  let usedNames = new Set<string>();
  for (let edit of rewrites) usedNames.add(nameForRewrite(edit));

  rewrites.sort((a, b) => b.start - a.start);
  let result = code;
  for (let edit of rewrites) {
    let original = result.slice(edit.start, edit.end);
    result = result.slice(0, edit.start) +
        `${nameForRewrite(edit)}(${original})` +
        result.slice(edit.end);
  }

  let importsList = [...usedNames].sort().join(", ");
  return `import { ${importsList} } from ${JSON.stringify(clientsImport)};\n` + result;
}

function nameForRewrite(edit: ClientRewrite): string {
  return edit.kind === "session"
      ? wrapSessionFunctionName(edit.className)
      : wrapFunctionName(edit.className);
}

function parseSource(code: string, fileName: string): SourceFile {
  let project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX },
  });
  return project.createSourceFile(fileName, code);
}

type ClientRewrite = {
  start: number;
  end: number;
  className: string;
  // "stub": typed call to a stub-returning helper, wrap is bound directly on
  //   the returned RpcStub.
  // "session": typed `new RpcSession<T>(...)`, wrap walks the session to its
  //   cached `getRemoteMain()` stub and binds there.
  kind: "stub" | "session";
};

type ImportedBinding = { original: string, binding: Node };

type ImportedFactories = {
  // Alias -> original capnweb stub-returning helper name (e.g. "connect" -> "newHttpBatchRpcSession").
  stubAliasToName: Map<string, ImportedBinding>;
  // Alias -> "RpcSession" if the user imported RpcSession (possibly renamed).
  sessionAliasToName: Map<string, ImportedBinding>;
  // Any imported name -> its original name. Used to resolve `import type { Api as RemoteApi }`.
  typeAliasToName: Map<string, ImportedBinding>;
  // Identifiers bound via `import * as ns from "capnweb"`.
  namespaces: Map<string, Node>;
};

function collectCapnwebImports(sourceFile: SourceFile): ImportedFactories {
  let stubAliasToName = new Map<string, ImportedBinding>();
  let sessionAliasToName = new Map<string, ImportedBinding>();
  let typeAliasToName = new Map<string, ImportedBinding>();
  let namespaces = new Map<string, Node>();

  for (let importDecl of sourceFile.getImportDeclarations()) {
    let isCapnweb = importDecl.getModuleSpecifierValue() === "capnweb";

    if (isCapnweb) {
      let namespaceImport = importDecl.getNamespaceImport();
      if (namespaceImport) namespaces.set(namespaceImport.getText(), namespaceImport);
    }

    for (let spec of importDecl.getNamedImports()) {
      let original = spec.getName();
      let alias = spec.getAliasNode()?.getText() ?? original;
      let binding = { original, binding: spec };
      typeAliasToName.set(alias, binding);
      if (!isCapnweb) continue;
      if (STUB_FACTORY_NAMES.has(original)) {
        stubAliasToName.set(alias, binding);
      } else if (original === SESSION_CONSTRUCTOR_NAME) {
        sessionAliasToName.set(alias, binding);
      }
    }
  }

  return { stubAliasToName, sessionAliasToName, typeAliasToName, namespaces };
}

function findClientRewrites(
    sourceFile: SourceFile, knownClasses: Set<string>, imports: ImportedFactories): ClientRewrite[] {
  let edits: ClientRewrite[] = [];

  for (let node of sourceFile.getDescendants()) {
    if (Node.isCallExpression(node)) {
      let rewrite = rewriteForCall(node, knownClasses, imports);
      if (rewrite) edits.push(rewrite);
    } else if (Node.isNewExpression(node)) {
      let rewrite = rewriteForNew(node, knownClasses, imports);
      if (rewrite) edits.push(rewrite);
    }
  }

  return edits;
}

function rewriteForCall(
    node: CallExpression, knownClasses: Set<string>, imports: ImportedFactories): ClientRewrite | undefined {
  if (!callsKnownStubFactory(node.getExpression(), imports)) return undefined;
  return rewriteForTypedExpression(node, knownClasses, imports, "stub");
}

function rewriteForNew(
    node: NewExpression, knownClasses: Set<string>, imports: ImportedFactories): ClientRewrite | undefined {
  if (!callsKnownSessionConstructor(node.getExpression(), imports)) return undefined;
  return rewriteForTypedExpression(node, knownClasses, imports, "session");
}

function callsKnownStubFactory(expr: Node, imports: ImportedFactories): boolean {
  if (Node.isIdentifier(expr)) {
    let imported = imports.stubAliasToName.get(expr.getText());
    return imported !== undefined && symbolMatches(expr, imported.binding);
  }
  if (Node.isPropertyAccessExpression(expr)) {
    let namespaceExpr = expr.getExpression();
    if (!Node.isIdentifier(namespaceExpr)) return false;
    let namespace = namespaceExpr.getText();
    let name = expr.getName();
    let imported = imports.namespaces.get(namespace);
    return imported !== undefined && symbolMatches(namespaceExpr, imported) &&
        STUB_FACTORY_NAMES.has(name);
  }
  return false;
}

function callsKnownSessionConstructor(expr: Node, imports: ImportedFactories): boolean {
  if (Node.isIdentifier(expr)) {
    let imported = imports.sessionAliasToName.get(expr.getText());
    return imported !== undefined && symbolMatches(expr, imported.binding);
  }
  if (Node.isPropertyAccessExpression(expr)) {
    let namespaceExpr = expr.getExpression();
    if (!Node.isIdentifier(namespaceExpr)) return false;
    let namespace = namespaceExpr.getText();
    let name = expr.getName();
    let imported = imports.namespaces.get(namespace);
    return imported !== undefined && symbolMatches(namespaceExpr, imported) &&
        name === SESSION_CONSTRUCTOR_NAME;
  }
  return false;
}

function rewriteForTypedExpression(
    node: CallExpression | NewExpression, knownClasses: Set<string>,
    imports: ImportedFactories, kind: "stub" | "session"): ClientRewrite | undefined {
  let typeArg = node.getTypeArguments()[0];
  if (!typeArg || !Node.isTypeReference(typeArg)) return undefined;

  let typeNameNode = typeArg.getTypeName();
  let typeName = typeNameNode.getText();
  let importedType = imports.typeAliasToName.get(typeName);
  if (importedType && Node.isIdentifier(typeNameNode) && symbolMatches(typeNameNode, importedType.binding)) {
    typeName = importedType.original;
  }
  if (!/^[$A-Z_a-z][$\w]*$/.test(typeName)) return undefined;
  if (!knownClasses.has(typeName)) return undefined;

  return {
    start: node.getStart(),
    end: node.getEnd(),
    className: typeName,
    kind,
  };
}

function symbolMatches(use: Node, declaration: Node): boolean {
  let symbol = use.getSymbol();
  return symbol?.getDeclarations().some(candidate =>
      candidate.getSourceFile().getFilePath() === declaration.getSourceFile().getFilePath() &&
      rangesOverlap(candidate, declaration)) ?? false;
}

function rangesOverlap(a: Node, b: Node): boolean {
  return a.getStart() <= b.getEnd() && b.getStart() <= a.getEnd();
}

function jsImportPath(path: string): string {
  let normalized = path.split(/[/\\]+/).join("/");
  let ext = extname(normalized);
  if (ext) normalized = normalized.slice(0, -ext.length) + ".js";
  if (!normalized.startsWith("./") && !normalized.startsWith("../")) normalized = "./" + normalized;
  return normalized;
}
