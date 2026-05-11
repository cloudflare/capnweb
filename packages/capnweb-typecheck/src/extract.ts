// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Class discovery for the Cap'n Web typecheck codegen.
//
// We use `ts-morph` to find every class transitively extending `RpcTarget`
// across the reachable source graph, plus the names of each method's
// parameters. We deliberately do NOT lower type information here -- that
// job is now Typia's; we just hand it the user's types via synthesized
// `typia.createValidate<Parameters<...>>()` call sites and let the transformer
// inline the validators.

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  ClassDeclaration,
  MethodDeclaration,
  ModuleKind,
  ModuleResolutionKind,
  Node,
  ParameterDeclaration,
  Project,
  ScriptTarget,
  ts,
  Type,
  type SourceFile,
} from "ts-morph";

// Native types Typia would silently accept but the Cap'n Web wire
// serializer can't carry. We reject them at codegen so the user gets a clear
// build-time error instead of a confusing runtime failure.
const SERIALIZER_UNSUPPORTED = new Set([
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "RegExp",
  "Map", "ReadonlyMap", "Set", "ReadonlySet", "WeakMap", "WeakSet",
  "Uint8ClampedArray", "Uint16Array", "Uint32Array",
  "Int8Array", "Int16Array", "Int32Array",
  "BigUint64Array", "BigInt64Array",
  "Float32Array", "Float64Array",
]);

// Native/global types whose internal shape we deliberately don't walk during
// preflight. Validators treat these by `instanceof` identity, not by
// structural fields, so descending into `Error.cause: unknown` etc. would
// generate false positives.
const OPAQUE_NATIVES = new Set([
  "Date", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
  "TypeError", "URIError", "AggregateError",
  "ReadableStream", "WritableStream", "Request", "Response", "Headers",
  "Blob", "Uint8Array",
  // Cap'n Web identity types are reference values; their declared interface
  // is a proxy facade and shouldn't be walked structurally.
  "RpcStub", "RpcPromise", "RpcTarget",
]);

export type RpcMethodInfo = {
  /** Method name on the `RpcTarget` subclass. */
  name: string;
  /** Parameter names, in declaration order. Used to label argument-validation errors. */
  paramNames: readonly string[];
  /** Whether each parameter is optional (declared with `?` or with a default value). */
  paramOptional: readonly boolean[];
};

export type RpcClassInfo = {
  /** Name visible to generated code. `default` for anonymous default exports. */
  name: string;
  /** Identifier we import the class as in generated modules. */
  valueName: string;
  /** Whether the class was the default export of its source file. */
  isDefault: boolean;
  /** Absolute path of the source file the class is declared in. */
  sourcePath: string;
  methods: readonly RpcMethodInfo[];
};

export function createProject(inputAbs: string): Project {
  return new Project({
    tsConfigFilePath: findTsConfig(inputAbs),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: ScriptTarget.ES2023,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      allowJs: true,
      noEmit: true,
    },
  });
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

export function extractClasses(sourceFiles: SourceFile[]): RpcClassInfo[] {
  let candidates = sourceFiles.flatMap(sourceFile => sourceFile.getClasses());
  let rpcClasses = candidates.filter(isRpcTargetExtender);
  return rpcClasses.map((klass, index) => extractClass(klass, index));
}

function isRpcTargetExtender(klass: ClassDeclaration): boolean {
  let visited = new Set<ClassDeclaration>();
  let current: ClassDeclaration | undefined = klass;

  while (current && !visited.has(current)) {
    visited.add(current);
    let extendsExpr = current.getExtends();
    if (!extendsExpr) return false;

    let name = extendsExpr.getExpression().getText();
    if (name === "RpcTarget") return true;

    let symbol = extendsExpr.getExpression().getSymbol();
    if (symbol?.getAliasedSymbol()?.getName() === "RpcTarget") return true;
    if (symbol?.getName() === "RpcTarget") return true;

    current = extendsExpr.getExpression().getType().getSymbol()
        ?.getDeclarations()
        .find(Node.isClassDeclaration);
  }

  return false;
}

function extractClass(klass: ClassDeclaration, index: number): RpcClassInfo {
  let name = klass.getName();
  let isDefault = klass.isDefaultExport();
  if (!name) {
    throw new Error("Anonymous RpcTarget classes are not supported. Give the class a name " +
        "so generated validators can import and register it.");
  }
  if (!klass.isExported()) {
    throw new Error(`${name}: RpcTarget classes must be exported so generated validators ` +
        `can import and register their constructors.`);
  }

  return {
    name,
    valueName: isDefault ? `__capnweb_default_${index}` : name,
    isDefault,
    sourcePath: klass.getSourceFile().getFilePath(),
    methods: extractMethods(klass, name),
  };
}

function extractMethods(klass: ClassDeclaration, className: string): RpcMethodInfo[] {
  let methods: RpcMethodInfo[] = [];
  let seen = new Set<string>();
  for (let method of klass.getInstanceMethods()) {
    if (method.hasModifier(ts.SyntaxKind.PrivateKeyword) ||
        method.hasModifier(ts.SyntaxKind.ProtectedKeyword)) continue;

    let methodName = method.getName();
    if (seen.has(methodName)) {
      throw new Error(`${className}.${methodName}: overloaded RPC methods are not supported.`);
    }
    seen.add(methodName);

    let paramNames: string[] = [];
    let paramOptional: boolean[] = [];
    for (let param of method.getParameters()) {
      if (param.isRestParameter()) {
        throw new Error(`${className}.${methodName}: rest parameters are not supported.`);
      }
      preflightCheckType(param.getType(),
          `${className}.${methodName} parameter '${param.getName()}'`, param, new Set());
      paramNames.push(param.getName());
      paramOptional.push(param.isOptional() || param.hasInitializer());
    }
    preflightCheckType(method.getReturnType(),
        `${className}.${methodName} return`, method, new Set());
    methods.push({ name: methodName, paramNames, paramOptional });
  }
  return methods;
}

// Quick gate that throws on types Typia can't or won't catch for us at its
// own transform time: bare `any`/`unknown`, `symbol`, and native types whose
// wire format the Cap'n Web serializer doesn't support. We deliberately do
// NOT walk into structurally rich types -- we only check leaf type aliases,
// classes, and obvious wrappers (arrays, tuples, unions, promises, simple
// object props). Recursive types and complex mapped/conditional types are
// left for Typia.
function preflightCheckType(
    type: Type, location: string,
    node: ParameterDeclaration | MethodDeclaration, visiting: Set<unknown>): void {
  let id = type.compilerType;
  if (visiting.has(id)) return; // already walked; assume Typia handles
  visiting.add(id);
  try {
    if (type.isAny()) {
      throw new Error(`${location}: type 'any' cannot be validated; specify a concrete type.`);
    }
    if (type.isUnknown()) {
      throw new Error(`${location}: type 'unknown' cannot be validated; specify a concrete type or narrow it.`);
    }
    if (type.getText() === "symbol" || type.getText() === "unique symbol" ||
        (type.compilerType.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
      throw new Error(`${location}: Unsupported RPC type: symbol`);
    }

    if (type.isUnion()) {
      for (let variant of type.getUnionTypes()) {
        preflightCheckType(variant, location, node, visiting);
      }
      return;
    }
    if (type.isIntersection()) {
      for (let part of type.getIntersectionTypes()) {
        preflightCheckType(part, location, node, visiting);
      }
      return;
    }
    if (type.isArray()) {
      let element = type.getArrayElementType();
      if (element) preflightCheckType(element, location, node, visiting);
      return;
    }
    if (type.isTuple()) {
      for (let element of type.getTupleElements()) {
        preflightCheckType(element, location, node, visiting);
      }
      return;
    }

    let symbol = type.getAliasSymbol() ?? type.getSymbol();
    let symbolName = symbol?.getName();
    let typeArgs = type.getTypeArguments();

    if (symbolName && SERIALIZER_UNSUPPORTED.has(symbolName)) {
      throw new Error(`${location}: Unsupported RPC type: ${type.getText()}`);
    }
    if (symbolName && OPAQUE_NATIVES.has(symbolName)) {
      // Validated by `instanceof` -- we deliberately don't walk fields.
      return;
    }
    if (symbolName === "Promise" || symbolName === "PromiseLike") {
      if (typeArgs[0]) preflightCheckType(typeArgs[0], location, node, visiting);
      return;
    }
    if (symbolName === "Array" || symbolName === "ReadonlyArray") {
      if (typeArgs[0]) preflightCheckType(typeArgs[0], location, node, visiting);
      return;
    }

    // Walk property types. Limited to types that look like plain object
    // literals / interfaces -- types with a known native or class identity
    // are handled by their `instanceof` check at runtime.
    for (let prop of type.getProperties()) {
      let propDecl = prop.getValueDeclaration() ?? prop.getDeclarations()[0];
      if (!propDecl) continue;
      let propType = prop.getTypeAtLocation(propDecl);
      preflightCheckType(propType, `${location}: property '${prop.getName()}'`,
          node, visiting);
    }
  } finally {
    visiting.delete(id);
  }
}

export function collectReachableSourceFiles(entry: SourceFile): SourceFile[] {
  let result: SourceFile[] = [];
  let seen = new Set<string>();

  let visit = (file: SourceFile) => {
    let filePath = file.getFilePath();
    if (seen.has(filePath)) return;
    if (filePath.includes(`${sep}node_modules${sep}`)) return;
    if (!isTypeScriptSource(filePath)) return;
    seen.add(filePath);
    result.push(file);

    let visitModule = (target: SourceFile | undefined) => {
      if (target && isTypeScriptSource(target.getFilePath())) visit(target);
    };

    for (let importDecl of file.getImportDeclarations()) {
      visitModule(importDecl.getModuleSpecifierSourceFile());
    }
    for (let exportDecl of file.getExportDeclarations()) {
      if (exportDecl.getModuleSpecifierValue() !== undefined) {
        visitModule(exportDecl.getModuleSpecifierSourceFile());
      }
    }
  };

  visit(entry);
  return result;
}

function isTypeScriptSource(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path) &&
      !/\.d\.(?:ts|mts|cts)$/.test(path);
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
