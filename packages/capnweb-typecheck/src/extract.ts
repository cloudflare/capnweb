// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import * as ts from "typescript";
import type { ClassSpec, MethodSpec, ParamSpec, TypeSpec } from "./types.js";

const SERIALIZER_UNSUPPORTED = new Set([
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "RegExp",
  "Map", "ReadonlyMap", "Set", "ReadonlySet", "WeakMap", "WeakSet",
  "Uint8ClampedArray", "Uint16Array", "Uint32Array",
  "Int8Array", "Int16Array", "Int32Array",
  "BigUint64Array", "BigInt64Array",
  "Float32Array", "Float64Array",
]);

const OPAQUE_NATIVES = new Set([
  "Date", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
  "TypeError", "URIError", "AggregateError",
  "ReadableStream", "WritableStream", "Request", "Response", "Headers",
  "Blob", "Uint8Array",
]);

export type SourceFile = ts.SourceFile;

export type TypecheckProject = {
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
};

export function createProject(inputAbs: string): TypecheckProject {
  let configPath = findTsConfig(inputAbs);
  let options = configPath ? readCompilerOptions(configPath) : {};
  options = {
    ...options,
    target: options.target ?? ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    allowJs: true,
    noEmit: true,
  };
  let program = ts.createProgram({ rootNames: [resolve(inputAbs)], options });
  let sourceFile = program.getSourceFile(resolve(inputAbs));
  if (!sourceFile) throw new Error(`Input file does not exist: ${inputAbs}`);
  return { program, checker: program.getTypeChecker(), sourceFile };
}

export function findTsConfig(start: string): string | undefined {
  let dir = dirname(resolve(start));
  while (true) {
    let candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    let parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readCompilerOptions(configPath: string): ts.CompilerOptions {
  let config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options;
}

export function collectReachableSourceFiles(project: TypecheckProject): ts.SourceFile[] {
  let result: ts.SourceFile[] = [];
  let seen = new Set<string>();
  let options = project.program.getCompilerOptions();

  let visit = (file: ts.SourceFile) => {
    let filePath = file.fileName;
    if (seen.has(filePath)) return;
    if (filePath.includes(`${sep}node_modules${sep}`)) return;
    if (!isTypeScriptSource(filePath)) return;
    seen.add(filePath);
    result.push(file);

    let visitModule = (specifier: string) => {
      let resolved = ts.resolveModuleName(specifier, filePath, options, ts.sys)
          .resolvedModule?.resolvedFileName;
      if (!resolved) return;
      let target = project.program.getSourceFile(resolved);
      if (target) visit(target);
    };

    for (let statement of file.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        visitModule(statement.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)) {
        visitModule(statement.moduleSpecifier.text);
      }
    }
  };

  visit(project.sourceFile);
  return result;
}

export function extractClasses(project: TypecheckProject, sourceFiles: ts.SourceFile[]): ClassSpec[] {
  return sourceFiles.flatMap(sourceFile => sourceFile.statements.filter(ts.isClassDeclaration))
      .filter(klass => isRpcTargetExtender(project.checker, klass))
      .map((klass, index) => extractClass(project.checker, klass, index));
}

function isRpcTargetExtender(checker: ts.TypeChecker, klass: ts.ClassDeclaration): boolean {
  let visited = new Set<ts.ClassDeclaration>();
  let current: ts.ClassDeclaration | undefined = klass;
  while (current && !visited.has(current)) {
    visited.add(current);
    let heritage = current.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    let typeNode = heritage?.types[0];
    if (!typeNode) return false;

    if (typeNode.expression.getText() === "RpcTarget") return true;
    let symbol = checker.getSymbolAtLocation(typeNode.expression);
    let aliased = symbol && (symbol.flags & ts.SymbolFlags.Alias)
        ? checker.getAliasedSymbol(symbol) : symbol;
    if (aliased?.getName() === "RpcTarget") return true;

    current = checker.getTypeAtLocation(typeNode.expression).getSymbol()
        ?.declarations?.find(ts.isClassDeclaration);
  }
  return false;
}

function extractClass(checker: ts.TypeChecker, klass: ts.ClassDeclaration, index: number): ClassSpec {
  let name = klass.name?.text;
  if (!name) {
    throw new Error("Anonymous RpcTarget classes are not supported. Give the class a name " +
        "so generated validators can import and register it.");
  }
  if (!hasModifier(klass, ts.SyntaxKind.ExportKeyword)) {
    throw new Error(`${name}: RpcTarget classes must be exported so generated validators ` +
        `can import and register their constructors.`);
  }
  let isDefault = hasModifier(klass, ts.SyntaxKind.DefaultKeyword);
  return {
    name,
    valueName: isDefault ? `__capnweb_default_${index}` : name,
    isDefault,
    sourcePath: klass.getSourceFile().fileName,
    methods: extractMethods(checker, klass, name),
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === kind) === true;
}

function extractMethods(
    checker: ts.TypeChecker, klass: ts.ClassDeclaration, className: string): MethodSpec[] {
  let methods: MethodSpec[] = [];
  let seen = new Set<string>();
  for (let member of klass.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
        hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;

    let methodName = propertyNameText(member.name);
    if (methodName === undefined) throw new Error(`${className}: computed RPC method names are not supported.`);
    if (seen.has(methodName)) throw new Error(`${className}.${methodName}: overloaded RPC methods are not supported.`);
    seen.add(methodName);

    let params: ParamSpec[] = [];
    for (let param of member.parameters) {
      if (param.dotDotDotToken) throw new Error(`${className}.${methodName}: rest parameters are not supported.`);
      if (!ts.isIdentifier(param.name)) throw new Error(`${className}.${methodName}: destructured parameters are not supported.`);
      params.push({
        name: param.name.text,
        optional: param.questionToken !== undefined || param.initializer !== undefined,
        type: lowerType(checker, checker.getTypeAtLocation(param),
            `${className}.${methodName} parameter '${param.name.text}'`, new Set()),
      });
    }
    let signature = checker.getSignatureFromDeclaration(member);
    let returns = lowerType(checker, checker.getReturnTypeOfSignature(signature!),
        `${className}.${methodName} return`, new Set());
    methods.push({ name: methodName, params, returns });
  }
  return methods;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function lowerType(
    checker: ts.TypeChecker, type: ts.Type, location: string, visiting: Set<ts.Type>): TypeSpec {
  if (visiting.has(type)) return { kind: "any" };
  visiting.add(type);
  try {
    let text = checker.typeToString(type);
    if (type.flags & ts.TypeFlags.Any) throw new Error(`${location}: type 'any' cannot be validated; specify a concrete type.`);
    if (type.flags & ts.TypeFlags.Unknown) throw new Error(`${location}: type 'unknown' cannot be validated; specify a concrete type or narrow it.`);
    if (text === "symbol" || text === "unique symbol" || (type.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
      throw new Error(`${location}: Unsupported RPC type: symbol`);
    }
    if (type.flags & ts.TypeFlags.Never) return { kind: "never" };
    if (type.flags & ts.TypeFlags.String) return { kind: "primitive", name: "string" };
    if (type.flags & ts.TypeFlags.Number) return { kind: "primitive", name: "number" };
    if (type.flags & ts.TypeFlags.BigInt) return { kind: "primitive", name: "bigint" };
    if (type.flags & ts.TypeFlags.Boolean) return { kind: "primitive", name: "boolean" };
    if (type.flags & ts.TypeFlags.Undefined) return { kind: "primitive", name: "undefined" };
    if (type.flags & ts.TypeFlags.Null) return { kind: "primitive", name: "null" };
    if (type.flags & ts.TypeFlags.Void) return { kind: "primitive", name: "void" };
    if (type.isStringLiteral()) return { kind: "literal", value: type.value };
    if (type.isNumberLiteral()) return { kind: "literal", value: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { kind: "literal", value: text === "true" };
    if (type.isUnion()) {
      let variants = type.types.map(variant => lowerType(checker, variant, location, visiting));
      return variants.length === 1 ? variants[0] : { kind: "union", variants };
    }
    if (type.isIntersection()) return { kind: "object", props: objectProps(checker, type, location, visiting) };
    if (checker.isArrayType(type)) {
      let arg = checker.getTypeArguments(type as ts.TypeReference)[0];
      return { kind: "array", element: arg ? lowerType(checker, arg, location, visiting) : { kind: "any" } };
    }
    if (checker.isTupleType(type)) {
      return {
        kind: "tuple",
        elements: checker.getTypeArguments(type as ts.TypeReference)
            .map(element => lowerType(checker, element, location, visiting)),
      };
    }
    if (type.getCallSignatures().length > 0) return { kind: "function" };

    let symbol = type.aliasSymbol ?? type.getSymbol();
    let symbolName = symbol?.getName();
    let typeArgs = checker.getTypeArguments(type as ts.TypeReference);
    if (symbolName && SERIALIZER_UNSUPPORTED.has(symbolName)) throw new Error(`${location}: Unsupported RPC type: ${text}`);
    if (symbolName === "RpcStub" || symbolName === "RpcPromise") return { kind: "stub" };
    if (symbolName === "RpcTarget") return { kind: "rpcTarget" };
    if (symbolName && OPAQUE_NATIVES.has(symbolName)) return { kind: "instance", name: symbolName };
    if (symbolName === "Promise" || symbolName === "PromiseLike") {
      return typeArgs[0] ? lowerType(checker, typeArgs[0], location, visiting) : { kind: "any" };
    }
    if (symbolName === "Array" || symbolName === "ReadonlyArray") {
      return typeArgs[0] ? { kind: "array", element: lowerType(checker, typeArgs[0], location, visiting) }
          : { kind: "array", element: { kind: "any" } };
    }
    let declaration = symbol?.declarations?.find(ts.isClassDeclaration);
    if (declaration && isRpcTargetExtender(checker, declaration)) return { kind: "rpcTarget" };
    let index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (index) return { kind: "record", value: lowerType(checker, index, location, visiting) };
    return { kind: "object", props: objectProps(checker, type, location, visiting) };
  } finally {
    visiting.delete(type);
  }
}

function objectProps(
    checker: ts.TypeChecker, type: ts.Type, location: string, visiting: Set<ts.Type>) {
  return checker.getPropertiesOfType(type).flatMap(prop => {
    let propDecl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!propDecl) return [];
    let propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);
    return [{
      name: prop.getName(),
      optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
      type: lowerType(checker, propType, `${location}: property '${prop.getName()}'`, visiting),
    }];
  });
}

function isTypeScriptSource(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path) && !/\.d\.(?:ts|mts|cts)$/.test(path);
}

export function commonDir(paths: string[]): string {
  if (paths.length === 0) return process.cwd();
  let parts = paths.map(path => dirname(path).split(sep));
  let first = parts[0];
  let end = first.length;
  for (let other of parts.slice(1)) {
    let i = 0;
    while (i < end && i < other.length && first[i] === other[i]) i++;
    end = i;
  }
  return first.slice(0, end).join(sep) || sep;
}
