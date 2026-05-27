// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Lower resolved TypeScript service types into the transform's normal form.
// Keep checker-specific logic here so the rest of the transform deals with
// `ServiceShape` and `TypeShape` only.

import type ts from "typescript";

/** Normal form the rest of the transform consumes. */
export type ServiceShape = {
  /** User-visible name (the class name when known). */
  name: string;
  methods: MethodShape[];
  /** Validator fragments that must be hoisted because refs point at them. */
  namedShapes: Map<number, TypeShape>;
};

export type MethodShape =
  | {
      name: string;
      skipValidation: true;
    }
  | {
      name: string;
      params: TypeShape[];
      rest?: TypeShape;
      /** Return type with `Promise<T>` already unwrapped. */
      returns: TypeShape;
      skipValidation?: false;
    };

export type TypeShape =
  // ----- pass-by-value primitives -----
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "bigint" }
  | { kind: "null" }
  | { kind: "undefined" }
  | { kind: "void" }
  | { kind: "any" }
  | { kind: "literal"; value: string | number | boolean }
  // ----- pass-by-value containers -----
  | { kind: "array"; id?: number; element: TypeShape }
  | { kind: "tuple"; id?: number; elements: TypeShape[] }
  | { kind: "object"; id?: number; name?: string; properties: Record<string, TypeShape>; index?: TypeShape }
  | { kind: "union"; id?: number; branches: TypeShape[] }
  | { kind: "ref"; id: number; name?: string }
  // ----- pass-by-value built-in classes the wire understands -----
  | { kind: "date" }
  | { kind: "bytes" }              // Uint8Array
  | { kind: "error" }              // Error & well-known subclasses
  | { kind: "blob" }               // Blob (and File, which extends Blob)
  | { kind: "readableStream" }
  | { kind: "writableStream" }
  | { kind: "headers" }
  | { kind: "request" }
  | { kind: "response" }
  // ----- pass-by-reference -----
  | { kind: "function" }           // plain functions
  | { kind: "stub"; service?: ServiceShape } // RpcStub<T>, RpcPromise<T>, RpcTarget subclasses
  // ----- rejected / unrepresentable -----
  | { kind: "unsupported"; reason: string };

/**
 * Resolve the service type at a marker call site to a normalized
 * {@link ServiceShape}. Returns `null` if the type cannot be resolved to a
 * concrete object - callers turn that into a build error pointing at the
 * call site.
 */
export function resolveServiceShape(
    tsm: typeof ts, checker: ts.TypeChecker, type: ts.Type,
): ServiceShape | null {
  let ctx = createResolveContext(tsm, checker);
  return resolveServiceShapeInner(ctx, type);
}

function resolveServiceShapeInner(
    ctx: ResolveContext, type: ts.Type): ServiceShape | null {
  let existing = ctx.services.get(type);
  if (existing) return existing.resolving ? null : existing.shape;

  let tsm = ctx.tsm;
  let checker = ctx.checker;
  let name = typeName(type) ?? "<anonymous>";
  if (name === "__type" || name === "<anonymous>") {
    // Anonymous object type - fine, just less useful in error messages.
    name = "Service";
  }
  let service: ServiceShape = {
    name,
    methods: [],
    namedShapes: ctx.namedShapes,
  };
  ctx.services.set(type, { shape: service, resolving: true });

  for (let prop of checker.getPropertiesOfType(type)) {
    let decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;
    let propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    let sigs = propType.getCallSignatures();
    if (sigs.length === 0) continue;          // not a method
    if (isPrivateOrProtected(tsm, decl)) continue;
    if (prop.getName().startsWith("#")) continue;     // private fields
    if (prop.getName() === "constructor") continue;
    // Use the first call signature; overloads are not represented separately.
    if (hasSkipRpcValidationDecorator(ctx, decl)) {
      service.methods.push({ name: prop.getName(), skipValidation: true });
      continue;
    }
    let sig = sigs[0]!;
    let params: TypeShape[] = [];
    let rest: TypeShape | undefined;
    for (let p of sig.getParameters()) {
      let pDecl = p.valueDeclaration ?? p.declarations?.[0];
      if (!pDecl) {
        params.push({ kind: "any" });
        continue;
      }
      let pType = checker.getTypeOfSymbolAtLocation(p, pDecl);
      let shape = resolveType(ctx, pType);
      if (tsm.isParameter(pDecl) && pDecl.dotDotDotToken) {
        if (shape.kind === "array") {
          rest = shape.element;
        } else if (shape.kind === "tuple") {
          params.push(...shape.elements);
        } else {
          rest = shape;
        }
      } else {
        params.push(shape);
      }
    }
    let returns = resolveType(ctx, unwrapPromise(tsm, checker, sig.getReturnType()));
    service.methods.push({ name: prop.getName(), params, rest, returns });
  }

  ctx.services.set(type, { shape: service, resolving: false });
  return service;
}

const MAX_RESOLVE_DEPTH = 64;

type ResolveEntry = {
  id: number;
  name?: string;
  resolving: boolean;
  referenced: boolean;
  shape?: TypeShape;
};

type ResolveContext = {
  tsm: typeof ts;
  checker: ts.TypeChecker;
  memo: WeakMap<ts.Type, ResolveEntry>;
  namedShapes: Map<number, TypeShape>;
  nextId: number;
  services: WeakMap<ts.Type, { shape: ServiceShape; resolving: boolean }>;
};

function createResolveContext(
    tsm: typeof ts, checker: ts.TypeChecker): ResolveContext {
  return {
    tsm,
    checker,
    memo: new WeakMap(),
    namedShapes: new Map(),
    nextId: 0,
    services: new WeakMap(),
  };
}

function isPrivateOrProtected(tsm: typeof ts, decl: ts.Declaration): boolean {
  // ts.canHaveModifiers / getModifiers - public API in TS 5+.
  if (tsm.canHaveModifiers(decl)) {
    let mods = tsm.getModifiers(decl);
    if (mods) {
      for (let m of mods) {
        if (m.kind === tsm.SyntaxKind.PrivateKeyword) return true;
        if (m.kind === tsm.SyntaxKind.ProtectedKeyword) return true;
      }
    }
  }
  return false;
}

function hasSkipRpcValidationDecorator(ctx: ResolveContext, decl: ts.Declaration): boolean {
  let tsm = ctx.tsm;
  if (!tsm.canHaveDecorators?.(decl)) return false;
  for (let decorator of tsm.getDecorators?.(decl) ?? []) {
    let expression = decorator.expression;
    if (tsm.isCallExpression(expression)) expression = expression.expression;
    if (!tsm.isIdentifier(expression)) continue;
    let sym = ctx.checker.getSymbolAtLocation(expression);
    if (sym && (sym.flags & tsm.SymbolFlags.Alias)) {
      sym = ctx.checker.getAliasedSymbol(sym);
    }
    if (sym?.getName() === "skipRpcValidation" && iscapnwebValidateSymbol(sym)) {
      return true;
    }
  }
  return false;
}

function unwrapPromise(
    tsm: typeof ts, checker: ts.TypeChecker, type: ts.Type): ts.Type {
  let sym = type.getSymbol();
  if (sym && sym.getName() === "Promise") {
    let args = checker.getTypeArguments(type as ts.TypeReference);
    if (args.length === 1) return args[0]!;
  }
  return type;
}

/**
 * Names the capnweb wire format passes by reference. User classes that extend
 * `RpcTarget` are detected via base-type walk, not by name.
 */
const CAPNWEB_STUB_NAMES = new Set(["RpcStub", "RpcPromise"]);

/**
 * Built-in classes the capnweb wire format passes by value. Each entry maps a
 * lib-declared type name to the shape we emit. The resolver only honours
 * matches whose declaration lives in a TypeScript lib file (lib.*.d.ts),
 * so a user-defined `class Date {}` does not get hijacked.
 */
const BUILTIN_VALUE_TYPES: Record<string, TypeShape["kind"]> = {
  Date: "date",
  Uint8Array: "bytes",
  // Error and its standard subclasses. User-defined Error subclasses fall
  // through to a base-type walk below.
  Error: "error",
  EvalError: "error",
  RangeError: "error",
  ReferenceError: "error",
  SyntaxError: "error",
  TypeError: "error",
  URIError: "error",
  AggregateError: "error",
  Blob: "blob",
  File: "blob",
  ReadableStream: "readableStream",
  WritableStream: "writableStream",
  Headers: "headers",
  Request: "request",
  Response: "response",
};

/**
 * Built-in classes capnweb intentionally rejects. Hitting one of these in a
 * service signature is a build error - users have to refactor their API.
 */
const BUILTIN_REJECTED_TYPES: Record<string, string> = {
  Map: "Map is not a capnweb wire type. Use a plain object or an array of entries instead.",
  Set: "Set is not a capnweb wire type. Use an array instead.",
  WeakMap: "WeakMap is not a capnweb wire type.",
  WeakSet: "WeakSet is not a capnweb wire type.",
  ArrayBuffer: "ArrayBuffer is not a capnweb wire type. Use Uint8Array instead.",
  SharedArrayBuffer: "SharedArrayBuffer is not a capnweb wire type.",
  Int8Array: "Int8Array is not a capnweb wire type. Use Uint8Array instead.",
  Uint8ClampedArray: "Uint8ClampedArray is not a capnweb wire type. Use Uint8Array instead.",
  Int16Array: "Int16Array is not a capnweb wire type. Use Uint8Array instead.",
  Uint16Array: "Uint16Array is not a capnweb wire type. Use Uint8Array instead.",
  Int32Array: "Int32Array is not a capnweb wire type. Use Uint8Array instead.",
  Uint32Array: "Uint32Array is not a capnweb wire type. Use Uint8Array instead.",
  Float32Array: "Float32Array is not a capnweb wire type. Use Uint8Array instead.",
  Float64Array: "Float64Array is not a capnweb wire type. Use Uint8Array instead.",
  BigInt64Array: "BigInt64Array is not a capnweb wire type. Use Uint8Array instead.",
  BigUint64Array: "BigUint64Array is not a capnweb wire type. Use Uint8Array instead.",
  RegExp: "RegExp is not a capnweb wire type.",
  DataView: "DataView is not a capnweb wire type. Use Uint8Array instead.",
};

function resolveType(ctx: ResolveContext, type: ts.Type, depth = 0): TypeShape {
  if (depth > MAX_RESOLVE_DEPTH) {
    return {
      kind: "unsupported",
      reason: `type exceeds maximum resolution depth (${MAX_RESOLVE_DEPTH})`,
    };
  }
  let tsm = ctx.tsm;
  let checker = ctx.checker;
  let flags = type.getFlags();
  let { TypeFlags } = tsm;

  if (flags & TypeFlags.StringLiteral) {
    return { kind: "literal", value: (type as ts.StringLiteralType).value };
  }
  if (flags & TypeFlags.NumberLiteral) {
    return { kind: "literal", value: (type as ts.NumberLiteralType).value };
  }
  if (flags & TypeFlags.BooleanLiteral) {
    // Boolean literal flag covers `true` / `false`. Their intrinsic name is
    // "true" / "false" - read it off the type to disambiguate.
    let name = (type as ts.Type & { intrinsicName?: string }).intrinsicName;
    if (name === "true") return { kind: "literal", value: true };
    if (name === "false") return { kind: "literal", value: false };
    return { kind: "boolean" };
  }
  if (flags & TypeFlags.String) return { kind: "string" };
  if (flags & TypeFlags.Number) return { kind: "number" };
  if (flags & TypeFlags.Boolean) return { kind: "boolean" };
  if (flags & TypeFlags.BigInt) return { kind: "bigint" };
  if (flags & TypeFlags.Null) return { kind: "null" };
  if (flags & TypeFlags.Undefined) return { kind: "undefined" };
  if (flags & TypeFlags.Void) return { kind: "void" };
  if (flags & TypeFlags.Any) return { kind: "any" };
  if (flags & TypeFlags.Unknown) return { kind: "any" };

  let stubServiceType = getStubServiceType(ctx, type);
  if (stubServiceType) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    let service = resolveStubServiceShape(ctx, stubServiceType);
    return finishResolve(ctx, type, entry, {
      kind: "stub",
      ...(service ? { service } : {}),
    });
  }

  if (flags & TypeFlags.Union) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    let branches = (type as ts.UnionType).types
      .map((t) => resolveType(ctx, t, depth + 1));
    let shape = collapseUnion(branches);
    if (shape.kind === "union") shape.id = entry.id;
    return finishResolve(ctx, type, entry, shape);
  }

  if (flags & TypeFlags.Intersection) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    return finishResolve(ctx, type, entry, resolveObjectShape(ctx, type, entry, depth));
  }

  if (checker.isTupleType?.(type)) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    let args = checker.getTypeArguments(type as ts.TypeReference);
    let elements = args.map((t) => resolveType(ctx, t, depth + 1));
    return finishResolve(ctx, type, entry, { kind: "tuple", id: entry.id, elements });
  }

  // Array detection. Use the checker's well-known helper symbol.
  if (checker.isArrayType?.(type)) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    let args = checker.getTypeArguments(type as ts.TypeReference);
    let element = args.length > 0
      ? resolveType(ctx, args[0]!, depth + 1)
      : { kind: "any" } as TypeShape;
    return finishResolve(ctx, type, entry, { kind: "array", id: entry.id, element });
  }

  if (flags & TypeFlags.Object) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;

    // Built-in wire types take precedence over generic object walking;
    // otherwise the resolver would try to enumerate `Date.prototype` etc.
    // and emit nonsense shapes.
    let builtin = matchBuiltin(type);
    if (builtin) return finishResolve(ctx, type, entry, builtin);

    // Pure function type (no own properties beyond call signatures).
    let props = checker.getPropertiesOfType(type);
    if (type.getCallSignatures().length > 0 && props.length === 0) {
      return finishResolve(ctx, type, entry, { kind: "function" });
    }

    return finishResolve(ctx, type, entry, resolveObjectShape(ctx, type, entry, depth));
  }

  return { kind: "unsupported", reason: `unsupported type (flags=${flags})` };
}

function resolveObjectShape(
    ctx: ResolveContext, type: ts.Type, entry: ResolveEntry,
    depth: number): TypeShape {
  let tsm = ctx.tsm;
  let checker = ctx.checker;
  // Generic object: enumerate properties. Methods declared on the type are
  // intentionally walked too. For a plain-object property type we treat
  // methods as `any` so the validator does not over-constrain.
  let properties: Record<string, TypeShape> = {};
  let name = typeName(type);
  let indexType = checker.getIndexTypeOfType?.(type, tsm.IndexKind.String);
  let index = indexType ? resolveType(ctx, indexType, depth + 1) : undefined;
  for (let prop of checker.getPropertiesOfType(type)) {
    let decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;
    let pType = checker.getTypeOfSymbolAtLocation(prop, decl);
    let shape = resolveType(ctx, pType, depth + 1);
    // Optional properties (`foo?: T`) widen to `T | undefined` so missing
    // keys validate cleanly.
    if (prop.getFlags() & tsm.SymbolFlags.Optional) {
      shape = collapseUnion([shape, { kind: "undefined" }]);
    }
    properties[prop.getName()] = shape;
  }
  return {
    kind: "object",
    id: entry.id,
    name: name && name !== "__type" ? name : undefined,
    properties,
    index,
  };
}

function beginResolve(ctx: ResolveContext, type: ts.Type): ResolveEntry | TypeShape {
  let existing = ctx.memo.get(type);
  if (existing) {
    if (existing.resolving) {
      existing.referenced = true;
      return { kind: "ref", id: existing.id, name: existing.name };
    }
    if (existing.shape) return existing.shape;
  }
  let entry: ResolveEntry = {
    id: ctx.nextId++,
    name: typeName(type),
    resolving: true,
    referenced: false,
  };
  ctx.memo.set(type, entry);
  return entry;
}

function isResolveEntry(value: ResolveEntry | TypeShape): value is ResolveEntry {
  return !("kind" in value);
}

function typeName(type: ts.Type): string | undefined {
  let name = type.getSymbol()?.getName();
  if (name && name !== "__type") return name;
  return type.aliasSymbol?.getName() ?? name;
}

function finishResolve(
    ctx: ResolveContext, type: ts.Type, entry: ResolveEntry,
    shape: TypeShape): TypeShape {
  entry.resolving = false;
  entry.shape = shape;
  ctx.memo.set(type, entry);
  if (entry.referenced) ctx.namedShapes.set(entry.id, shape);
  return shape;
}

/**
 * Match `type` against the wire's built-in catalogue. Returns null if the
 * type is not a recognised built-in, or if a symbol named like a built-in is
 * declared somewhere other than a TypeScript lib file (user code shadowing).
 */
function matchBuiltin(type: ts.Type): TypeShape | null {
  let sym = type.getSymbol();
  if (!sym) return null;
  let name = sym.getName();
  if (!isLibSymbol(sym)) return null;
  if (name in BUILTIN_REJECTED_TYPES) {
    return { kind: "unsupported", reason: BUILTIN_REJECTED_TYPES[name]! };
  }
  let kind = BUILTIN_VALUE_TYPES[name];
  if (kind) return { kind } as TypeShape;
  return null;
}

/**
 * True when `sym`'s declaration lives in a TypeScript-shipped lib file
 * (lib.es5.d.ts, lib.dom.d.ts, etc.). Used to gate built-in matches against
 * user code that happens to reuse a global name.
 */
export function isTypeScriptLibFileName(fileName: string): boolean {
  return /[\\/]lib\.[\w.-]+\.d\.ts$/.test(fileName);
}

function isLibSymbol(sym: ts.Symbol): boolean {
  for (let decl of sym.getDeclarations() ?? []) {
    if (isTypeScriptLibFileName(decl.getSourceFile().fileName)) return true;
  }
  return false;
}

function getStubServiceType(ctx: ResolveContext, type: ts.Type): ts.Type | null {
  let checker = ctx.checker;
  let flags = type.getFlags();
  let { TypeFlags } = ctx.tsm;
  if (!(flags & TypeFlags.Object) && !(flags & TypeFlags.Intersection)) {
    return null;
  }

  let sym = type.getSymbol();
  let name = sym?.getName();
  if (name && CAPNWEB_STUB_NAMES.has(name) && isCapnwebSymbol(sym!)) {
    let args = checker.getTypeArguments(type as ts.TypeReference);
    if (args.length === 1) return args[0]!;
  }

  let brand = checker.getPropertiesOfType(type)
    .find((prop) => prop.getName() === "__RPC_STUB_BRAND");
  let decl = brand?.valueDeclaration ?? brand?.declarations?.[0];
  if (brand && decl) {
    return checker.getTypeOfSymbolAtLocation(brand, decl);
  }

  // Walk base types looking for RpcTarget. `getBaseTypes` is only defined on
  // interface/class types; the cast is safe because callers filtered to
  // object-like types upstream.
  if (extendsRpcTarget(checker, type)) return type;
  return null;
}


function resolveStubServiceShape(
    ctx: ResolveContext, type: ts.Type): ServiceShape | undefined {
  let flags = type.getFlags();
  let { TypeFlags } = ctx.tsm;
  if (flags & TypeFlags.TypeParameter) return undefined;
  if (flags & TypeFlags.Any) return undefined;
  if (flags & TypeFlags.Unknown) return undefined;
  if (flags & TypeFlags.Never) return undefined;
  if (type.getSymbol()?.getName() === "RpcTarget") return undefined;
  return resolveServiceShapeInner(ctx, type) ?? undefined;
}

function iscapnwebValidateSymbol(sym: ts.Symbol): boolean {
  for (let decl of sym.getDeclarations() ?? []) {
    let fileName = decl.getSourceFile().fileName;
    if (/[\\/]capnweb-validate[\\/]/.test(fileName)) return true;
  }
  let parent = (sym as ts.Symbol & { parent?: ts.Symbol }).parent;
  return parent !== undefined && (parent.escapedName as string) === '"capnweb-validate"';
}

function isCapnwebSymbol(sym: ts.Symbol): boolean {
  for (let decl of sym.getDeclarations() ?? []) {
    let fileName = decl.getSourceFile().fileName;
    // Fast path: published package (`node_modules/capnweb/...`) and the
    // workspace symlink (`packages/capnweb/...`) both put a `capnweb` segment
    // in the path.
    if (/[\\/]capnweb[\\/]/.test(fileName)) return true;
  }
  // Ambient `declare module "capnweb" { ... }` - covers test fixtures and any
  // user augmentation. Module symbols' `escapedName` is the quoted specifier.
  let parent = (sym as ts.Symbol & { parent?: ts.Symbol }).parent;
  if (parent && (parent.escapedName as string) === '"capnweb"') return true;
  return false;
}

function extendsRpcTarget(checker: ts.TypeChecker, type: ts.Type): boolean {
  let seen = new Set<ts.Type>();
  function walk(t: ts.Type): boolean {
    if (seen.has(t)) return false;
    seen.add(t);
    let sym = t.getSymbol();
    if (sym && sym.getName() === "RpcTarget" && isCapnwebSymbol(sym)) {
      return true;
    }
    let bases = (t as ts.InterfaceType).getBaseTypes?.() ?? [];
    for (let b of bases) {
      if (walk(b)) return true;
    }
    return false;
  }
  // Don't treat `RpcTarget` itself as stub-like - that's used as the marker
  // class on the server side and resolveServiceShape needs to enumerate it.
  // The check at the call site (`isTooGeneric`) already rejects bare
  // `RpcTarget`. Here we only flag *subclasses*.
  let bases = (type as ts.InterfaceType).getBaseTypes?.() ?? [];
  for (let b of bases) {
    if (walk(b)) return true;
  }
  return false;
}

function collapseUnion(branches: TypeShape[]): TypeShape {
  if (branches.length === 0) return { kind: "unsupported", reason: "empty union" };
  if (branches.length === 1) return branches[0]!;
  return { kind: "union", branches };
}

/**
 * Walk a resolved service shape collecting `{ path, reason }` entries for
 * every `unsupported` leaf. Callers turn the list into a build error so the
 * user sees every offending field at once, with a JSON-pointer-style path.
 */
export function collectUnsupported(
    service: ServiceShape): { path: string; reason: string }[] {
  let out: { path: string; reason: string }[] = [];
  let seenServices = new Set<ServiceShape>();
  walkService(service, "");
  return out;

  function walkService(svc: ServiceShape, prefix: string): void {
    if (seenServices.has(svc)) return;
    seenServices.add(svc);
    for (let m of svc.methods) {
      if (m.skipValidation) continue;
      let base = prefix ? `${prefix}.${m.name}` : m.name;
      m.params.forEach((p, i) => walk(p, `${base}.args[${i}]`));
      if (m.rest) walk(m.rest, `${base}.args[*]`);
      walk(m.returns, `${base}.return`);
    }
  }

  function walk(shape: TypeShape, path: string): void {
    switch (shape.kind) {
      case "unsupported":
        out.push({ path, reason: shape.reason });
        return;
      case "array":
        walk(shape.element, `${path}[*]`);
        return;
      case "tuple":
        shape.elements.forEach((e, i) => walk(e, `${path}[${i}]`));
        return;
      case "union":
        shape.branches.forEach((b, i) => walk(b, `${path}|${i}`));
        return;
      case "ref":
        return;
      case "stub":
        if (shape.service) walkService(shape.service, path);
        return;
      case "object":
        if (shape.index) walk(shape.index, `${path}.*`);
        for (let [k, v] of Object.entries(shape.properties)) {
          walk(v, `${path}.${k}`);
        }
        return;
      default:
        return;
    }
  }
}
