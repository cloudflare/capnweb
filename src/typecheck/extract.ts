// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import * as ts from "typescript";
import type { ExtractedClassSpec, MethodSpec, ParamSpec, TypeSpec } from "./types.js";

const OPAQUE_NATIVES = new Set([
  "Date", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
  "TypeError", "URIError", "AggregateError",
  "ReadableStream", "WritableStream", "Request", "Response", "Headers",
  "Blob", "Uint8Array",
]);

const SERIALIZER_UNSUPPORTED_NATIVES = new Set([
  "ArrayBuffer", "DataView", "RegExp", "Uint8ClampedArray", "Uint16Array",
  "Uint32Array", "Int8Array", "Int16Array", "Int32Array", "BigUint64Array",
  "BigInt64Array", "Float32Array", "Float64Array",
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

/**
 * Per-extraction state for type lowering. Threaded through `lowerType` so
 * recursive types can be detected and hoisted into named validators that
 * call themselves instead of being inlined infinitely.
 */
export type LowerContext = {
  /** Currently in-flight types. Value is the assigned id once recursion has been detected. */
  visiting: Map<ts.Type, string | undefined>;
  /** Types that have been finalized and hoisted. */
  named: Map<string, TypeSpec>;
  /** Stable id for every type that has been hoisted; reused on subsequent encounters. */
  typeToId: Map<ts.Type, string>;
  /** Monotonic counter for generating unique named ids. */
  nextNamedId: { value: number };
};

export function newLowerContext(): LowerContext {
  return {
    visiting: new Map(),
    named: new Map(),
    typeToId: new Map(),
    nextNamedId: { value: 0 },
  };
}

export type ExtractedClasses = {
  classes: ExtractedClassSpec[];
  named: Map<string, TypeSpec>;
};

export function extractClasses(project: TypecheckProject, sourceFiles: ts.SourceFile[]): ExtractedClasses {
  let ctx = newLowerContext();
  let classes = sourceFiles.flatMap(sourceFile => sourceFile.statements.filter(ts.isClassDeclaration))
      .filter(klass => isRpcTargetExtender(project.checker, klass))
      .map((klass, index) => extractClass(project.checker, klass, index, ctx));
  return { classes, named: ctx.named };
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

function extractClass(checker: ts.TypeChecker, klass: ts.ClassDeclaration, index: number, ctx: LowerContext): ExtractedClassSpec {
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
    methods: extractMethods(checker, klass, name, ctx),
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === kind) === true;
}

function extractMethods(
    checker: ts.TypeChecker, klass: ts.ClassDeclaration, className: string, ctx: LowerContext): MethodSpec[] {
  let methods: MethodSpec[] = [];
  let seen = new Set<string>();
  for (let member of klass.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
        hasModifier(member, ts.SyntaxKind.ProtectedKeyword) ||
        hasModifier(member, ts.SyntaxKind.StaticKeyword)) continue;

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
            `${className}.${methodName} parameter '${param.name.text}'`, ctx),
      });
    }
    let signature = checker.getSignatureFromDeclaration(member);
    let returns = lowerType(checker, checker.getReturnTypeOfSignature(signature!),
        `${className}.${methodName} return`, ctx);
    methods.push({ name: methodName, params, returns });
  }
  return methods;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function lowerType(
    checker: ts.TypeChecker, type: ts.Type, location: string, ctx: LowerContext): TypeSpec {
  // Already hoisted from an earlier encounter — emit a ref directly.
  let existingId = ctx.typeToId.get(type);
  if (existingId !== undefined) return { kind: "ref", id: existingId };

  // Currently being lowered (recursion). Assign an id and emit a ref;
  // the outer call will record the lowered shape in `named` below.
  if (ctx.visiting.has(type)) {
    let id = ctx.visiting.get(type);
    if (id === undefined) {
      id = makeNamedId(type, ctx);
      ctx.visiting.set(type, id);
      ctx.typeToId.set(type, id);
    }
    return { kind: "ref", id };
  }

  ctx.visiting.set(type, undefined);
  try {
    let spec = lowerTypeBody(checker, type, location, ctx);
    let assignedId = ctx.visiting.get(type);
    if (assignedId !== undefined) {
      // Self-referenced during lowering: hoist the body under the id and
      // return a ref so the outer site emits the same call as inner ones.
      ctx.named.set(assignedId, spec);
      return { kind: "ref", id: assignedId };
    }
    return spec;
  } finally {
    ctx.visiting.delete(type);
  }
}

function makeNamedId(type: ts.Type, ctx: LowerContext): string {
  let symbol = type.aliasSymbol ?? type.getSymbol();
  let base = symbol?.getName().replace(/[^A-Za-z0-9_]/g, "_") || "Anon";
  return `${base}_${ctx.nextNamedId.value++}`;
}

function lowerTypeBody(
    checker: ts.TypeChecker, type: ts.Type, location: string, ctx: LowerContext): TypeSpec {
  let text = checker.typeToString(type);
  if (type.flags & ts.TypeFlags.Any) throw new Error(`${location}: type 'any' cannot be validated; specify a concrete type.`);
  if (type.flags & ts.TypeFlags.Unknown) throw new Error(`${location}: type 'unknown' cannot be validated; specify a concrete type or narrow it.`);
  if (text === "symbol" || text === "unique symbol" || (type.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    throw new Error(`${location}: Unsupported RPC type: symbol`);
  }
  if (type.flags & ts.TypeFlags.Never) return { kind: "never" };
  if (type.flags & ts.TypeFlags.String) return { kind: "primitive", name: "string" };
  if (type.flags & ts.TypeFlags.Number) return { kind: "primitive", name: "number" };
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    throw new Error(`${location}: bigint literal types are not supported by capnweb typecheck yet.`);
  }
  if (type.flags & ts.TypeFlags.BigInt) return { kind: "primitive", name: "bigint" };
  if (type.flags & ts.TypeFlags.Boolean) return { kind: "primitive", name: "boolean" };
  if (type.flags & ts.TypeFlags.Undefined) return { kind: "primitive", name: "undefined" };
  if (type.flags & ts.TypeFlags.Null) return { kind: "primitive", name: "null" };
  if (type.flags & ts.TypeFlags.Void) return { kind: "primitive", name: "void" };
  if (type.isStringLiteral()) return { kind: "literal", value: type.value };
  if (type.isNumberLiteral()) return { kind: "literal", value: type.value };
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { kind: "literal", value: text === "true" };
  if (type.isUnion()) {
    let variants = type.types.map(variant => lowerType(checker, variant, location, ctx));
    return variants.length === 1 ? variants[0] : { kind: "union", variants };
  }
  if (type.isIntersection()) return { kind: "object", props: objectProps(checker, type, location, ctx) };
  if (checker.isTupleType(type)) {
    let tupleTarget = (type as ts.TypeReference).target as ts.TupleType | undefined;
    let elementFlags = tupleTarget?.elementFlags ?? [];
    if (elementFlags.some(flag =>
        (flag & (ts.ElementFlags.Optional | ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0)) {
      throw new Error(`${location}: optional and rest tuple elements are not supported by capnweb typecheck yet.`);
    }
    return {
      kind: "tuple",
      elements: checker.getTypeArguments(type as ts.TypeReference)
          .map(element => lowerType(checker, element, location, ctx)),
    };
  }
  if (checker.isArrayType(type)) {
    let arg = checker.getTypeArguments(type as ts.TypeReference)[0];
    return { kind: "array", element: arg ? lowerType(checker, arg, location, ctx) : { kind: "any" } };
  }
  if (type.getCallSignatures().length > 0) return { kind: "function" };

  let symbol = type.aliasSymbol ?? type.getSymbol();
  let symbolName = symbol?.getName();
  let typeArgs = checker.getTypeArguments(type as ts.TypeReference);
  if (symbolName === "RpcStub" || symbolName === "RpcPromise") return { kind: "stub" };
  if (symbolName === "RpcTarget") return { kind: "rpcTarget" };
  if (symbolName === "Map" || symbolName === "ReadonlyMap") {
    return {
      kind: "map",
      key: typeArgs[0] ? lowerType(checker, typeArgs[0], location, ctx) : { kind: "any" },
      value: typeArgs[1] ? lowerType(checker, typeArgs[1], location, ctx) : { kind: "any" },
    };
  }
  if (symbolName === "Set" || symbolName === "ReadonlySet") {
    return {
      kind: "set",
      value: typeArgs[0] ? lowerType(checker, typeArgs[0], location, ctx) : { kind: "any" },
    };
  }
  if (symbolName && SERIALIZER_UNSUPPORTED_NATIVES.has(symbolName)) {
    throw new Error(`${location}: Unsupported RPC type: ${symbolName}`);
  }
  if (symbolName && OPAQUE_NATIVES.has(symbolName)) return { kind: "instance", name: symbolName };
  if (symbolName === "Promise" || symbolName === "PromiseLike") {
    return typeArgs[0] ? lowerType(checker, typeArgs[0], location, ctx) : { kind: "any" };
  }
  if (symbolName === "Array" || symbolName === "ReadonlyArray") {
    return typeArgs[0] ? { kind: "array", element: lowerType(checker, typeArgs[0], location, ctx) }
        : { kind: "array", element: { kind: "any" } };
  }
  let declaration = symbol?.declarations?.find(ts.isClassDeclaration);
  if (declaration && isRpcTargetExtender(checker, declaration)) return { kind: "rpcTarget" };
  let index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (index) {
    let props = checker.getPropertiesOfType(type);
    if (props.length > 0) {
      throw new Error(`${location}: object types with both string index signatures and named properties are not supported by capnweb typecheck yet.`);
    }
    return { kind: "record", value: lowerType(checker, index, location, ctx) };
  }
  return { kind: "object", props: objectProps(checker, type, location, ctx) };
}

function objectProps(
    checker: ts.TypeChecker, type: ts.Type, location: string, ctx: LowerContext) {
  return checker.getPropertiesOfType(type).flatMap(prop => {
    let propDecl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!propDecl) return [];
    let propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);
    return [{
      name: prop.getName(),
      optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
      type: lowerType(checker, propType, `${location}: property '${prop.getName()}'`, ctx),
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
