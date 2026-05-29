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
  targetKind?: "workerEntrypoint";
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
  | {
      kind: "tuple";
      id?: number;
      elements: TypeShape[];
      /** Number of required leading elements (`[a, b?]` -> 1). */
      minLength?: number;
      /** Variadic tail element type for `[a, ...b[]]`. */
      rest?: TypeShape;
    }
  | {
      kind: "object";
      id?: number;
      name?: string;
      properties: Record<string, TypeShape>;
      index?: TypeShape;
    }
  | { kind: "union"; id?: number; branches: TypeShape[] }
  | { kind: "ref"; id: number; name?: string }
  // ----- pass-by-value built-in classes the wire understands -----
  | { kind: "date" }
  | { kind: "bytes" } // Uint8Array
  | { kind: "error" } // Error & well-known subclasses
  | { kind: "blob" } // Blob (and File, which extends Blob)
  | { kind: "readableStream" }
  | { kind: "writableStream" }
  | { kind: "headers" }
  | { kind: "request" }
  | { kind: "response" }
  // ----- pass-by-reference -----
  | { kind: "function" } // plain functions
  | { kind: "stub"; service?: ServiceShape } // RpcStub<T>, RpcPromise<T>, Fetcher<T>
  // ----- rejected / unrepresentable -----
  | {
      kind: "unsupported";
      reason: string;
      typeExpr?: string;
      fixHint?: string;
    };

/**
 * Resolve the service type at a marker call site to a normalized
 * {@link ServiceShape}. Returns `null` if the type cannot be resolved to a
 * concrete object - callers turn that into a build error pointing at the
 * call site.
 */
export function resolveServiceShape(
  tsm: typeof ts,
  checker: ts.TypeChecker,
  type: ts.Type
): ServiceShape | null {
  let ctx = createResolveContext(tsm, checker);
  return resolveServiceShapeInner(ctx, type);
}

function resolveServiceShapeInner(
  ctx: ResolveContext,
  type: ts.Type
): ServiceShape | null {
  let existing = ctx.services.get(type);
  if (existing) return existing.resolving ? null : existing.shape;

  let tsm = ctx.tsm;
  let checker = ctx.checker;
  let name = typeName(type) ?? "<anonymous>";
  if (name === "__type" || name === "<anonymous>") {
    // Anonymous object type - fine, just less useful in error messages.
    name = "Service";
  }
  let targetKind: "workerEntrypoint" | undefined = isWorkerEntrypointType(
    checker,
    type
  )
    ? "workerEntrypoint"
    : undefined;
  let service: ServiceShape = {
    name,
    ...(targetKind ? { targetKind } : {}),
    methods: [],
    namedShapes: ctx.namedShapes,
  };
  ctx.services.set(type, { shape: service, resolving: true });

  for (let prop of checker.getPropertiesOfType(type)) {
    let propName = prop.getName();
    if (isSymbolNamedProperty(prop)) continue;
    if (RPC_CAPABILITY_BRAND_NAMES.has(propName)) continue;
    if (
      targetKind === "workerEntrypoint" &&
      WORKER_ENTRYPOINT_LIFECYCLE.has(propName)
    ) {
      continue;
    }
    let decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;
    let propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    let sigs = propType.getCallSignatures();
    if (sigs.length === 0) continue; // not a method
    if (isPrivateOrProtected(tsm, decl)) continue;
    if (prop.getName().startsWith("#")) continue; // private fields
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
          if (shape.rest) rest = shape.rest;
        } else {
          rest = shape;
        }
      } else {
        params.push(shape);
      }
    }
    let returns = resolveReturnType(ctx, sig.getReturnType());
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
  tsm: typeof ts,
  checker: ts.TypeChecker
): ResolveContext {
  return {
    tsm,
    checker,
    memo: new WeakMap(),
    namedShapes: new Map(),
    nextId: 0,
    services: new WeakMap(),
  };
}

function isSymbolNamedProperty(sym: ts.Symbol): boolean {
  let name = sym.escapedName;
  return typeof name === "string" && name.startsWith("__@");
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

function hasSkipRpcValidationDecorator(
  ctx: ResolveContext,
  decl: ts.Declaration
): boolean {
  let tsm = ctx.tsm;
  if (!tsm.canHaveDecorators?.(decl)) return false;
  for (let decorator of tsm.getDecorators?.(decl) ?? []) {
    let expression = decorator.expression;
    if (tsm.isCallExpression(expression)) expression = expression.expression;
    if (!tsm.isIdentifier(expression)) continue;
    let sym = ctx.checker.getSymbolAtLocation(expression);
    if (sym && sym.flags & tsm.SymbolFlags.Alias) {
      sym = ctx.checker.getAliasedSymbol(sym);
    }
    if (
      sym?.getName() === "skipRpcValidation" &&
      isCapnwebValidateSymbol(sym)
    ) {
      return true;
    }
  }
  return false;
}

function unwrapPromise(
  tsm: typeof ts,
  checker: ts.TypeChecker,
  type: ts.Type,
  depth = 0
): ts.Type {
  if (depth > MAX_RESOLVE_DEPTH) return type;
  let sym = type.getSymbol() ?? type.aliasSymbol;
  let name = sym?.getName();
  if (name === "Promise" || name === "PromiseLike") {
    let args = checker.getTypeArguments(type as ts.TypeReference);
    // Unwrap nested awaitables too (`Promise<Promise<T>>`).
    if (args.length === 1)
      return unwrapPromise(tsm, checker, args[0]!, depth + 1);
  }
  return type;
}

/**
 * Resolve a method's return type, accounting for the fact that capnweb awaits
 * the return value before delivering it. A bare `Promise<T>` / `PromiseLike<T>`
 * is unwrapped to `T`; a union that *contains* an awaitable (e.g.
 * `Promise<T> | undefined`) has each awaitable branch unwrapped so the emitted
 * validator matches the resolved value rather than the thenable object (which
 * would reject every successful call).
 */
function resolveReturnType(ctx: ResolveContext, type: ts.Type): TypeShape {
  let { tsm, checker } = ctx;
  let unwrapped = unwrapPromise(tsm, checker, type);
  if (unwrapped !== type) return resolveType(ctx, unwrapped);
  if (type.getFlags() & tsm.TypeFlags.Union) {
    let union = type as ts.UnionType;
    let hasAwaitable = union.types.some(
      (t) => unwrapPromise(tsm, checker, t) !== t
    );
    if (hasAwaitable) {
      let branches = union.types.map((t) =>
        resolveType(ctx, unwrapPromise(tsm, checker, t))
      );
      return collapseUnion(branches);
    }
  }
  return resolveType(ctx, type);
}

/**
 * Names the capnweb wire format passes by reference. User classes that extend
 * `RpcTarget` are detected via base-type walk, not by name.
 */
const RPC_STUB_NAMES = new Set(["RpcStub", "RpcPromise"]);

const RPC_CAPABILITY_BRAND_NAMES = new Set([
  "__RPC_TARGET_BRAND",
  "__WORKER_ENTRYPOINT_BRAND",
]);

const WORKER_ENTRYPOINT_LIFECYCLE = new Set([
  "fetch",
  "connect",
  "email",
  "queue",
  "scheduled",
  "tail",
  "tailStream",
  "trace",
  "test",
]);

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
const BUILTIN_REJECTED_TYPES: Record<string, string | undefined> = {
  Map: "Use a plain object or an array of entries instead.",
  Set: "Use an array instead.",
  WeakMap: undefined,
  WeakSet: undefined,
  ArrayBuffer: "Use Uint8Array instead.",
  SharedArrayBuffer: undefined,
  Int8Array: "Use Uint8Array instead.",
  Uint8ClampedArray: "Use Uint8Array instead.",
  Int16Array: "Use Uint8Array instead.",
  Uint16Array: "Use Uint8Array instead.",
  Int32Array: "Use Uint8Array instead.",
  Uint32Array: "Use Uint8Array instead.",
  Float32Array: "Use Uint8Array instead.",
  Float64Array: "Use Uint8Array instead.",
  BigInt64Array: "Use Uint8Array instead.",
  BigUint64Array: "Use Uint8Array instead.",
  RegExp: undefined,
  DataView: "Use Uint8Array instead.",
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
  if (flags & TypeFlags.BigIntLiteral) {
    // capnweb transports bigint by value, but the literal machinery only
    // carries string/number/boolean. Validate the bigint brand, not the value.
    return { kind: "bigint" };
  }
  if (flags & TypeFlags.BooleanLiteral) {
    // Boolean literal flag covers `true` / `false`. Their intrinsic name is
    // "true" / "false" - read it off the type to disambiguate.
    let name = (type as ts.Type & { intrinsicName?: string }).intrinsicName;
    if (name === "true") return { kind: "literal", value: true };
    if (name === "false") return { kind: "literal", value: false };
    return { kind: "boolean" };
  }
  // Template literal (`user_${string}`) and intrinsic string-mapping
  // (`Uppercase<T>`, `Lowercase<T>`, ...) types are plain strings at runtime;
  // capnweb transports them as strings. Validate as `string`. The content
  // pattern is not enforced - same looseness as any other string-internal
  // constraint, consistent with not checking length/format.
  if (flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping))
    return { kind: "string" };
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
    let service = stubServiceType.type
      ? resolveStubServiceShape(ctx, stubServiceType.type)
      : undefined;
    return finishResolve(ctx, type, entry, {
      kind: "stub",
      ...(service ? { service } : {}),
    });
  }

  if (flags & TypeFlags.Union) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    let branches = (type as ts.UnionType).types.map((t) =>
      resolveType(ctx, t, depth + 1)
    );
    let shape = collapseUnion(branches);
    if (shape.kind === "union") shape.id = entry.id;
    return finishResolve(ctx, type, entry, shape);
  }

  if (flags & TypeFlags.Intersection) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    return finishResolve(
      ctx,
      type,
      entry,
      resolveObjectShape(ctx, type, entry, depth)
    );
  }

  if (checker.isTupleType?.(type)) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    let args = checker.getTypeArguments(type as ts.TypeReference);
    // ts.ElementFlags: Required=1, Optional=2, Rest=4, Variadic=8. Read them off
    // the tuple target so optional (`[a, b?]`) and rest (`[a, ...b[]]`) elements
    // become a variable-arity validator instead of a fixed-length one.
    let target = (type as ts.TypeReference).target as ts.TupleType | undefined;
    let elementFlags = target?.elementFlags ?? [];
    let head: TypeShape[] = [];
    let minLength = 0;
    let rest: TypeShape | undefined;
    let sawRest = false;
    let restNotLast = false;
    for (let i = 0; i < args.length; i++) {
      let flag = elementFlags[i] ?? 1;
      let shape = resolveType(ctx, args[i]!, depth + 1);
      if (flag & (4 | 8)) {
        // Rest or Variadic. `...number[]` carries the array element type; a
        // bare element type is used directly.
        if (sawRest) {
          restNotLast = true;
          break;
        }
        sawRest = true;
        rest = shape.kind === "array" ? shape.element : shape;
      } else {
        // A fixed/optional element after a rest element (`[...a[], b]`) cannot
        // be expressed as head + tail, so reject it at build time rather than
        // emit a silently-wrong validator.
        if (sawRest) {
          restNotLast = true;
          break;
        }
        head.push(shape);
        if (!(flag & 2)) minLength = head.length;
      }
    }
    if (restNotLast) {
      return finishResolve(ctx, type, entry, {
        kind: "unsupported",
        reason: "tuple with a rest element before a fixed element",
        typeExpr: checker.typeToString(type),
        fixHint: "place the rest element last, e.g. `[a, ...b[]]`",
      });
    }
    return finishResolve(ctx, type, entry, {
      kind: "tuple",
      id: entry.id,
      elements: head,
      ...(minLength !== head.length ? { minLength } : {}),
      ...(rest ? { rest } : {}),
    });
  }

  // Array detection. Use the checker's well-known helper symbol.
  if (checker.isArrayType?.(type)) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;
    let args = checker.getTypeArguments(type as ts.TypeReference);
    let element =
      args.length > 0
        ? resolveType(ctx, args[0]!, depth + 1)
        : ({ kind: "any" } as TypeShape);
    return finishResolve(ctx, type, entry, {
      kind: "array",
      id: entry.id,
      element,
    });
  }

  if (flags & TypeFlags.Object) {
    let entryOrShape = beginResolve(ctx, type);
    if (!isResolveEntry(entryOrShape)) return entryOrShape;
    let entry = entryOrShape;

    // Built-in wire types take precedence over generic object walking;
    // otherwise the resolver would try to enumerate `Date.prototype` etc.
    // and emit nonsense shapes.
    let builtin = matchBuiltin(ctx, type);
    if (builtin) return finishResolve(ctx, type, entry, builtin);

    // Pure function type (no own properties beyond call signatures).
    let props = checker.getPropertiesOfType(type);
    if (type.getCallSignatures().length > 0 && props.length === 0) {
      return finishResolve(ctx, type, entry, { kind: "function" });
    }

    return finishResolve(
      ctx,
      type,
      entry,
      resolveObjectShape(ctx, type, entry, depth)
    );
  }

  return { kind: "unsupported", reason: `unsupported type (flags=${flags})` };
}

function resolveObjectShape(
  ctx: ResolveContext,
  type: ts.Type,
  entry: ResolveEntry,
  depth: number
): TypeShape {
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
    if (isSymbolNamedProperty(prop)) continue;
    if (RPC_CAPABILITY_BRAND_NAMES.has(prop.getName())) continue;
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

function beginResolve(
  ctx: ResolveContext,
  type: ts.Type
): ResolveEntry | TypeShape {
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

function isResolveEntry(
  value: ResolveEntry | TypeShape
): value is ResolveEntry {
  return !("kind" in value);
}

function typeName(type: ts.Type): string | undefined {
  let name = type.getSymbol()?.getName();
  if (name && name !== "__type") return name;
  return type.aliasSymbol?.getName() ?? name;
}

function finishResolve(
  ctx: ResolveContext,
  type: ts.Type,
  entry: ResolveEntry,
  shape: TypeShape
): TypeShape {
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
function matchBuiltin(ctx: ResolveContext, type: ts.Type): TypeShape | null {
  let sym = type.getSymbol();
  if (!sym) return null;
  let name = sym.getName();
  if (!isLibSymbol(sym)) return null;
  if (name in BUILTIN_REJECTED_TYPES) {
    let fixHint = BUILTIN_REJECTED_TYPES[name];
    return {
      kind: "unsupported",
      reason: "not a capnweb wire type",
      typeExpr: rejectedTypeExpr(ctx, type, name),
      ...(fixHint ? { fixHint } : {}),
    };
  }
  let kind = BUILTIN_VALUE_TYPES[name];
  if (kind) return { kind } as TypeShape;
  return null;
}

function rejectedTypeExpr(
  ctx: ResolveContext,
  type: ts.Type,
  builtinName: string
): string {
  let expr = ctx.checker.typeToString(
    type,
    undefined,
    ctx.tsm.TypeFormatFlags.NoTruncation
  );
  return expr === `${builtinName}<ArrayBufferLike>` ? builtinName : expr;
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

type StubServiceType = { type?: ts.Type };

function getStubServiceType(
  ctx: ResolveContext,
  type: ts.Type
): StubServiceType | null {
  let checker = ctx.checker;
  let flags = type.getFlags();
  let { TypeFlags } = ctx.tsm;
  if (!(flags & TypeFlags.Object) && !(flags & TypeFlags.Intersection)) {
    return null;
  }

  let fetcherServiceType = getFetcherServiceType(ctx, type);
  if (fetcherServiceType !== null) {
    return fetcherServiceType ? { type: fetcherServiceType } : {};
  }

  let sym = type.getSymbol();
  let name = sym?.getName();
  if (name && RPC_STUB_NAMES.has(name) && isRpcRuntimeSymbol(sym!)) {
    let args = checker.getTypeArguments(type as ts.TypeReference);
    return args.length === 1 ? { type: args[0]! } : {};
  }

  let brand = getProperty(ctx, type, "__RPC_STUB_BRAND");
  let decl = brand?.valueDeclaration ?? brand?.declarations?.[0];
  if (brand && decl) {
    return { type: checker.getTypeOfSymbolAtLocation(brand, decl) };
  }

  if (hasRpcCapabilityBrand(ctx, type)) return { type };

  // Walk base types looking for RpcTarget / WorkerEntrypoint. `getBaseTypes`
  // is only defined on interface/class types; the cast is safe because callers
  // filtered to object-like types upstream.
  if (extendsRpcReferenceTarget(checker, type)) return { type };
  return null;
}

function getFetcherServiceType(
  ctx: ResolveContext,
  type: ts.Type
): ts.Type | undefined | null {
  if (!isFetcherLikeType(ctx, type)) return null;
  let args = type.aliasTypeArguments ?? [];
  let serviceType = args[0];
  if (!serviceType) return undefined;
  return isUndefinedType(ctx, serviceType) ? undefined : serviceType;
}

function isFetcherLikeType(ctx: ResolveContext, type: ts.Type): boolean {
  if (
    type.aliasSymbol?.getName() === "Fetcher" &&
    hasFetcherMethods(ctx, type)
  ) {
    return true;
  }
  // Structural fallback: exactly `fetch` + `connect`, both methods. Without
  // the call-signature check, a `{ fetch: string; connect: number }` value
  // would be misread as a Fetcher stub and skip field validation.
  let props = ctx.checker.getPropertiesOfType(type);
  return props.length === 2 && hasFetcherMethods(ctx, type);
}

function hasFetcherMethods(ctx: ResolveContext, type: ts.Type): boolean {
  return isMethodProp(ctx, type, "fetch") && isMethodProp(ctx, type, "connect");
}

function isMethodProp(
  ctx: ResolveContext,
  type: ts.Type,
  name: string
): boolean {
  let prop = getProperty(ctx, type, name);
  if (!prop) return false;
  let decl = prop.valueDeclaration ?? prop.declarations?.[0];
  if (!decl) return false;
  return (
    ctx.checker.getTypeOfSymbolAtLocation(prop, decl).getCallSignatures()
      .length > 0
  );
}

function hasRpcCapabilityBrand(ctx: ResolveContext, type: ts.Type): boolean {
  for (let name of RPC_CAPABILITY_BRAND_NAMES) {
    if (getProperty(ctx, type, name)) return true;
  }
  return false;
}

function getProperty(
  ctx: ResolveContext,
  type: ts.Type,
  name: string
): ts.Symbol | undefined {
  return ctx.checker
    .getPropertiesOfType(type)
    .find((prop) => prop.getName() === name);
}

function isUndefinedType(ctx: ResolveContext, type: ts.Type): boolean {
  return (type.getFlags() & ctx.tsm.TypeFlags.Undefined) !== 0;
}

function resolveStubServiceShape(
  ctx: ResolveContext,
  type: ts.Type
): ServiceShape | undefined {
  let flags = type.getFlags();
  let { TypeFlags } = ctx.tsm;
  if (flags & TypeFlags.TypeParameter) return undefined;
  if (flags & TypeFlags.Any) return undefined;
  if (flags & TypeFlags.Unknown) return undefined;
  if (flags & TypeFlags.Never) return undefined;
  if (flags & TypeFlags.Undefined) return undefined;
  if (isBareRpcBaseType(ctx.checker, type)) return undefined;
  return resolveServiceShapeInner(ctx, type) ?? undefined;
}

function isCapnwebValidateSymbol(sym: ts.Symbol): boolean {
  for (let decl of sym.getDeclarations() ?? []) {
    let fileName = decl.getSourceFile().fileName;
    if (/[\\/]capnweb-validate[\\/]/.test(fileName)) return true;
  }
  let parent = (sym as ts.Symbol & { parent?: ts.Symbol }).parent;
  if (!parent) return false;
  let name = parent.escapedName as string;
  return name === '"capnweb-validate"' || name === '"capnweb-validate/capnweb"';
}

function isRpcRuntimeSymbol(sym: ts.Symbol): boolean {
  for (let decl of sym.getDeclarations() ?? []) {
    let fileName = decl.getSourceFile().fileName;
    // Installed capnweb, and generated Workers types that back
    // `cloudflare:workers`. Scoped to node_modules so a user project that
    // merely lives under a directory named `capnweb` is not misdetected;
    // source/workspace layouts resolve via the module-specifier check below.
    if (/[\\/]node_modules[\\/]capnweb[\\/]/.test(fileName)) return true;
    if (/[\\/]@cloudflare[\\/]workers-types[\\/]/.test(fileName)) return true;
  }
  // Ambient `declare module "capnweb" { ... }` - covers test fixtures and any
  // user augmentation. Module symbols' `escapedName` is the quoted specifier.
  let parent = (sym as ts.Symbol & { parent?: ts.Symbol }).parent;
  if (parent && (parent.escapedName as string) === '"capnweb"') return true;
  if (parent && (parent.escapedName as string) === '"cloudflare:workers"')
    return true;
  if (parent && (parent.escapedName as string) === "CloudflareWorkersModule")
    return true;
  return false;
}

function isRpcBaseSymbol(sym: ts.Symbol): boolean {
  let name = sym.getName();
  return (
    (name === "RpcTarget" || name === "WorkerEntrypoint") &&
    isRpcRuntimeSymbol(sym)
  );
}

export function isWorkerEntrypointType(
  checker: ts.TypeChecker,
  type: ts.Type
): boolean {
  return extendsNamedRpcBase(checker, type, "WorkerEntrypoint");
}

function isBareRpcBaseType(checker: ts.TypeChecker, type: ts.Type): boolean {
  let sym = type.getSymbol();
  return !!sym && isRpcBaseSymbol(sym) && !hasOwnRpcBaseSubclass(checker, type);
}

function extendsRpcReferenceTarget(
  checker: ts.TypeChecker,
  type: ts.Type
): boolean {
  return (
    extendsNamedRpcBase(checker, type, "RpcTarget") ||
    extendsNamedRpcBase(checker, type, "WorkerEntrypoint")
  );
}

function hasOwnRpcBaseSubclass(
  checker: ts.TypeChecker,
  type: ts.Type
): boolean {
  return extendsRpcReferenceTarget(checker, type);
}

function extendsNamedRpcBase(
  _checker: ts.TypeChecker,
  type: ts.Type,
  baseName: "RpcTarget" | "WorkerEntrypoint"
): boolean {
  let seen = new Set<ts.Type>();
  function walk(t: ts.Type): boolean {
    if (seen.has(t)) return false;
    seen.add(t);
    let sym = t.getSymbol();
    if (sym && sym.getName() === baseName && isRpcRuntimeSymbol(sym))
      return true;
    let bases = (t as ts.InterfaceType).getBaseTypes?.() ?? [];
    for (let b of bases) {
      if (walk(b)) return true;
    }
    return false;
  }
  let bases = (type as ts.InterfaceType).getBaseTypes?.() ?? [];
  for (let b of bases) {
    if (walk(b)) return true;
  }
  return false;
}

function collapseUnion(branches: TypeShape[]): TypeShape {
  if (branches.length === 0)
    return { kind: "unsupported", reason: "empty union" };
  if (branches.length === 1) return branches[0]!;
  return { kind: "union", branches };
}

export type UnsupportedPosition =
  | { kind: "arg"; index: number; suffix: string }
  | { kind: "rest"; suffix: string }
  | { kind: "return"; suffix: string };

export type UnsupportedTypeIssue = {
  serviceName: string;
  methodName: string;
  position: UnsupportedPosition;
  reason: string;
  typeExpr?: string;
  fixHint?: string;
};

/**
 * Walk a resolved service shape collecting every `unsupported` leaf. Callers
 * turn the list into a build error so the user sees every offending field at
 * once.
 */
export function collectUnsupported(
  service: ServiceShape
): UnsupportedTypeIssue[] {
  let out: UnsupportedTypeIssue[] = [];
  let seenServices = new Set<ServiceShape>();
  walkService(service);
  return out;

  function walkService(svc: ServiceShape): void {
    if (seenServices.has(svc)) return;
    seenServices.add(svc);
    for (let m of svc.methods) {
      if (m.skipValidation) continue;
      m.params.forEach((p, i) =>
        walk(svc, m.name, { kind: "arg", index: i + 1, suffix: "" }, p)
      );
      if (m.rest) walk(svc, m.name, { kind: "rest", suffix: "" }, m.rest);
      walk(svc, m.name, { kind: "return", suffix: "" }, m.returns);
    }
  }

  function walk(
    svc: ServiceShape,
    methodName: string,
    position: UnsupportedPosition,
    shape: TypeShape
  ): void {
    switch (shape.kind) {
      case "unsupported":
        out.push({
          serviceName: svc.name,
          methodName,
          position,
          reason: shape.reason,
          ...(shape.typeExpr ? { typeExpr: shape.typeExpr } : {}),
          ...(shape.fixHint ? { fixHint: shape.fixHint } : {}),
        });
        return;
      case "array":
        walk(svc, methodName, appendSuffix(position, "[*]"), shape.element);
        return;
      case "tuple":
        shape.elements.forEach((e, i) =>
          walk(svc, methodName, appendSuffix(position, `[${i}]`), e)
        );
        if (shape.rest)
          walk(svc, methodName, appendSuffix(position, "[*]"), shape.rest);
        return;
      case "union":
        shape.branches.forEach((b, i) =>
          walk(svc, methodName, appendSuffix(position, `|${i}`), b)
        );
        return;
      case "ref":
        return;
      case "stub":
        if (shape.service) walkService(shape.service);
        return;
      case "object":
        if (shape.index)
          walk(svc, methodName, appendSuffix(position, ".*"), shape.index);
        for (let [k, v] of Object.entries(shape.properties)) {
          walk(svc, methodName, appendSuffix(position, `.${k}`), v);
        }
        return;
      default:
        return;
    }
  }
}

function appendSuffix(
  position: UnsupportedPosition,
  suffix: string
): UnsupportedPosition {
  return { ...position, suffix: position.suffix + suffix };
}
