// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Lower resolved TypeScript service types into the transform's normal form
// (ServiceShape / TypeShape). Keeps checker-specific logic out of the rest.

import type ts from "typescript";

/** Normal form the rest of the transform consumes. */
export type ServiceShape = {
  /** User-visible name (the class name when known). */
  name: string;
  targetKind?: "workerEntrypoint";
  methods: MethodShape[];
  /** Platform-inherited methods excluded from the surface but still dispatchable on the wrapped target (e.g. WorkerEntrypoint `fetch`). */
  passthrough?: string[];
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
      /** Getter accessor: validated on property read, not call. `params` is empty. */
      isGetter?: boolean;
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
  | { kind: "map"; key: TypeShape; value: TypeShape }
  | { kind: "set"; element: TypeShape }
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
  // ----- pass-by-value built-in classes the validator understands -----
  | { kind: "date" }
  | { kind: "arrayBuffer" }
  | { kind: "dataView" }
  | { kind: "regexp" }
  | { kind: "bytes" } // Uint8Array
  | { kind: "typedArray"; name: TypedArrayName }
  | { kind: "error" } // Error & well-known subclasses
  | { kind: "blob" } // Blob
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
 * Resolve the service type at a marker call site to a {@link ServiceShape}.
 * Returns null if it is not a concrete object; callers raise a build error.
 */
export function resolveServiceShape(
  tsm: typeof ts,
  checker: ts.TypeChecker,
  type: ts.Type,
  generic?: GenericFallback,
  signatureType?: ts.Type | null,
  signatureMode: "sharpen" | "exact" = "sharpen"
): ServiceShape | null {
  let ctx = createResolveContext(tsm, checker, generic);
  if (!signatureType) return resolveServiceShapeInner(ctx, type);
  // `type` provides the runtime implementation. `signatureType` can either
  // sharpen matching members (`implements T`) or, for explicit
  // `@validateRpc<T>()`, also filter the exposed method set to T's names.
  let surfaceKinds = collectServiceSurfaceNames(ctx, type);
  let signature = resolveServiceShapeInner(
    ctx,
    signatureType,
    undefined,
    surfaceKinds
  );
  let overrides = signature
    ? new Map(signature.methods.map((method) => [method.name, method]))
    : undefined;
  let includeMethods = signatureMode === "exact"
    ? collectServiceSurfaceNames(ctx, signatureType)
    : undefined;
  return resolveServiceShapeInner(ctx, type, overrides, includeMethods);
}

// Resolve `type` into a ServiceShape. Two optional modes support the
// decorator's "class surface + signature source" split:
// - `methodOverrides`: replace a resolved member with a precomputed shape when
//   the names match. Used by the final class pass to adopt sharper signatures.
// - `includeMethods`: restrict resolution to these surface names (the signature
//   pass, or explicit `@validateRpc<T>()`), so members outside the active
//   surface never warn, error, or emit named shapes.
// Both modes bypass the service cache so the filtered/overridden shape is never
// observed by an unrelated resolution of the same `type`.
function resolveServiceShapeInner(
  ctx: ResolveContext,
  type: ts.Type,
  methodOverrides?: Map<string, MethodShape>,
  includeMethods?: Map<string, SurfaceMemberKind>
): ServiceShape | null {
  let existing = methodOverrides || includeMethods ? undefined : ctx.services.get(type);
  if (existing) return existing.resolving ? null : existing.shape;

  let tsm = ctx.tsm;
  let checker = ctx.checker;
  let name = typeName(type) ?? "<anonymous>";
  if (name === "__type" || name === "<anonymous>") {
    // Anonymous object type, which is fine, just less useful in error messages.
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
  if (!includeMethods) ctx.services.set(type, { shape: service, resolving: true });

  let passthrough: string[] = [];
  for (let prop of checker.getPropertiesOfType(type)) {
    let propName = prop.getName();
    if (isSymbolNamedProperty(prop)) continue;
    if (RPC_CAPABILITY_BRAND_NAMES.has(propName)) continue;
    let decl = prop.valueDeclaration ?? prop.declarations?.[0];
    // Platform/library base methods (WorkerEntrypoint, DurableObject, RpcTarget)
    // aren't the user's surface but still dispatch on the wrapped target, so
    // record them as pass-through. Detected by origin, not a name list.
    if (decl && isPlatformInheritedMember(decl)) {
      passthrough.push(propName);
      continue;
    }
    if (decl && isPrivateOrProtected(tsm, decl)) continue;
    if (propName.startsWith("#")) continue; // private fields
    if (propName === "constructor") continue;
    if (includeMethods && !includeMethods.has(propName)) continue;
    if (hasSkipRpcValidationDecorator(ctx, prop)) {
      service.methods.push({ name: prop.getName(), skipValidation: true });
      continue;
    }
    let propType = decl
      ? checker.getTypeOfSymbolAtLocation(prop, decl)
      : checker.getTypeOfSymbol(prop);
    // Strip the optional `undefined`: `m?(): T` is `(() => T) | undefined`,
    // and the union reports no call signatures, dropping the method.
    let callableType =
      prop.flags & tsm.SymbolFlags.Optional
        ? checker.getNonNullableType(propType)
        : propType;
    let sigs = callableType.getCallSignatures();
    let override = methodOverrides?.get(propName);
    if (sigs.length === 0) {
      // Cap'n Web exposes property reads as promise-like gets. Preserve declared
      // data properties from service interfaces and object literals as getter
      // specs; class instance fields stay excluded because RpcTarget blocks them.
      if (isRpcReadableProperty(ctx, type, prop, decl)) {
        if (override && !override.skipValidation && override.isGetter) {
          service.methods.push(override);
          continue;
        }
        service.methods.push({
          name: propName,
          params: [],
          returns: resolveReturnType(ctx, propType),
          isGetter: true,
        });
      }
      continue;
    }
    if (override && override.skipValidation) {
      service.methods.push(override);
      continue;
    }
    if (override && !override.isGetter) {
      service.methods.push(override);
      continue;
    }
    if (sigs.length > 1) {
      // Overloaded: validating one signature would reject the other overloads,
      // so pass through unvalidated and warn rather than break a legal call.
      // Signature-only overloads warn only when they apply to a callable member.
      let surfaceKind = includeMethods?.get(propName);
      if (decl && (!includeMethods || surfaceKind === "callable")) {
        warnOverloadedMethod(propName, decl);
      }
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
      if (
        tsm.isParameter(pDecl) &&
        (pDecl.questionToken || pDecl.initializer)
      ) {
        shape = withUndefined(shape);
      }
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

  if (passthrough.length) service.passthrough = passthrough;
  if (!includeMethods) ctx.services.set(type, { shape: service, resolving: false });
  return service;
}

// Member kind on the runtime surface, used to gate signature-source diagnostics.
type SurfaceMemberKind = "callable" | "getter";

// Names (and kinds) of the members `resolveServiceShapeInner` would emit for
// `type`. The inclusion filter below MUST mirror that loop's skip rules, or the
// signature pass and the surface pass disagree on which members exist.
function collectServiceSurfaceNames(
  ctx: ResolveContext,
  type: ts.Type
): Map<string, SurfaceMemberKind> {
  let names = new Map<string, SurfaceMemberKind>();
  let tsm = ctx.tsm;
  for (let prop of ctx.checker.getPropertiesOfType(type)) {
    let propName = prop.getName();
    if (isSymbolNamedProperty(prop)) continue;
    if (RPC_CAPABILITY_BRAND_NAMES.has(propName)) continue;
    let decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (decl && isPlatformInheritedMember(decl)) continue;
    if (decl && isPrivateOrProtected(tsm, decl)) continue;
    if (propName.startsWith("#")) continue;
    if (propName === "constructor") continue;
    if (hasSkipRpcValidationDecorator(ctx, prop)) continue;
    let propType = decl
      ? ctx.checker.getTypeOfSymbolAtLocation(prop, decl)
      : ctx.checker.getTypeOfSymbol(prop);
    let callableType =
      prop.flags & tsm.SymbolFlags.Optional
        ? ctx.checker.getNonNullableType(propType)
        : propType;
    if (callableType.getCallSignatures().length > 0) {
      names.set(propName, "callable");
    } else if (isRpcReadableProperty(ctx, type, prop, decl)) {
      names.set(propName, "getter");
    }
  }
  return names;
}

const MAX_RESOLVE_DEPTH = 64;

type ResolveEntry = {
  id: number;
  name?: string;
  resolving: boolean;
  referenced: boolean;
  shape?: TypeShape;
};

/**
 * How to handle an unconstrained generic parameter: "any" (decorator path on a
 * generic class) or "error" everywhere else. `used` fires when a default applies,
 * so the caller warns only when it matters.
 */
export type GenericFallback = { mode: "error" | "any"; used: boolean };

type ResolveContext = {
  tsm: typeof ts;
  checker: ts.TypeChecker;
  memo: WeakMap<ts.Type, ResolveEntry>;
  namedShapes: Map<number, TypeShape>;
  nextId: number;
  services: WeakMap<ts.Type, { shape: ServiceShape; resolving: boolean }>;
  generic: GenericFallback;
};

function createResolveContext(
  tsm: typeof ts,
  checker: ts.TypeChecker,
  generic: GenericFallback = { mode: "error", used: false }
): ResolveContext {
  return {
    tsm,
    checker,
    memo: new WeakMap(),
    namedShapes: new Map(),
    nextId: 0,
    services: new WeakMap(),
    generic,
  };
}

function isSymbolNamedProperty(sym: ts.Symbol): boolean {
  let name = sym.escapedName;
  return typeof name === "string" && name.startsWith("__@");
}

function isPrivateOrProtected(tsm: typeof ts, decl: ts.Declaration): boolean {
  // ts.canHaveModifiers / getModifiers are public API in TS 5+.
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

// Decorator and call-site paths resolve the same type, so dedup the warning on
// the declaration node (a watch rebuild produces fresh nodes).
const warnedOverloads = new WeakSet<ts.Declaration>();

function warnOverloadedMethod(name: string, decl: ts.Declaration): void {
  if (warnedOverloads.has(decl)) return;
  warnedOverloads.add(decl);
  let sf = decl.getSourceFile();
  let { line, character } = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
  console.warn(
    `${sf.fileName}:${line + 1}:${character + 1}: capnweb-validate: ` +
      `method \`${name}\` is overloaded; capnweb-validate checks one ` +
      `signature only, so it is passed through unvalidated. Use a single ` +
      `signature with union parameters to validate it, or @skipRpcValidation() ` +
      `to silence this.`
  );
}

function hasSkipRpcValidationDecorator(
  ctx: ResolveContext,
  prop: ts.Symbol
): boolean {
  for (let decl of prop.declarations ?? []) {
    let tsm = ctx.tsm;
    if (!tsm.canHaveDecorators?.(decl)) continue;
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
  // Gate on the global symbol so a user type named `Promise`/`PromiseLike` is
  // not unwrapped as if it were the standard awaitable.
  if (
    (name === "Promise" || name === "PromiseLike") &&
    sym &&
    isGlobalSymbol(tsm, sym)
  ) {
    let args = checker.getTypeArguments(type as ts.TypeReference);
    // Unwrap nested awaitables too (`Promise<Promise<T>>`).
    if (args.length === 1)
      return unwrapPromise(tsm, checker, args[0]!, depth + 1);
  }
  return type;
}

/**
 * Resolve a method's return type. capnweb awaits it, so unwrap `Promise<T>` to
 * `T`, including per-branch in a union like `Promise<T> | undefined`.
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

/** Pass-by-reference wire names. RpcTarget subclasses are found via base walk. */
const RPC_STUB_NAMES = new Set(["RpcStub", "RpcPromise"]);

const RPC_CAPABILITY_BRAND_NAMES = new Set([
  "__RPC_TARGET_BRAND",
  "__WORKER_ENTRYPOINT_BRAND",
  "__DURABLE_OBJECT_BRAND",
]);


type TypedArrayName =
  | "Int8Array"
  | "Uint8ClampedArray"
  | "Int16Array"
  | "Uint16Array"
  | "Int32Array"
  | "Uint32Array"
  | "Float32Array"
  | "Float64Array"
  | "BigInt64Array"
  | "BigUint64Array";

/**
 * Pass-by-value built-ins, mapping lib type name to emitted shape. Only honoured
 * for lib-declared symbols, so a user `class Date {}` is not hijacked.
 */
const BUILTIN_VALUE_TYPES: Record<string, TypeShape> = {
  Date: { kind: "date" },
  ArrayBuffer: { kind: "arrayBuffer" },
  DataView: { kind: "dataView" },
  RegExp: { kind: "regexp" },
  Uint8Array: { kind: "bytes" },
  Int8Array: { kind: "typedArray", name: "Int8Array" },
  Uint8ClampedArray: { kind: "typedArray", name: "Uint8ClampedArray" },
  Int16Array: { kind: "typedArray", name: "Int16Array" },
  Uint16Array: { kind: "typedArray", name: "Uint16Array" },
  Int32Array: { kind: "typedArray", name: "Int32Array" },
  Uint32Array: { kind: "typedArray", name: "Uint32Array" },
  Float32Array: { kind: "typedArray", name: "Float32Array" },
  Float64Array: { kind: "typedArray", name: "Float64Array" },
  BigInt64Array: { kind: "typedArray", name: "BigInt64Array" },
  BigUint64Array: { kind: "typedArray", name: "BigUint64Array" },
  // Error and its standard subclasses. User-defined Error subclasses fall
  // through to a base-type walk below.
  Error: { kind: "error" },
  EvalError: { kind: "error" },
  RangeError: { kind: "error" },
  ReferenceError: { kind: "error" },
  SyntaxError: { kind: "error" },
  TypeError: { kind: "error" },
  URIError: { kind: "error" },
  AggregateError: { kind: "error" },
  Blob: { kind: "blob" },
  ReadableStream: { kind: "readableStream" },
  WritableStream: { kind: "writableStream" },
  Headers: { kind: "headers" },
  Request: { kind: "request" },
  Response: { kind: "response" },
};

/**
 * Built-ins no supported RPC transport handles as values. Hitting one in a
 * signature is a build error instead of a deferred runtime failure.
 */
const BUILTIN_REJECTED_TYPES: Record<string, string | undefined> = {
  WeakMap: undefined,
  WeakSet: undefined,
  SharedArrayBuffer: undefined,
  // File is a Blob subclass, but this validator accepts Blob by exact prototype.
  // Send the bytes as a Blob or Uint8Array instead.
  File: "Use a Blob or Uint8Array; File is not a supported RPC validation type.",
};

const MAP_TYPES = new Set(["Map", "ReadonlyMap"]);
const SET_TYPES = new Set(["Set", "ReadonlySet"]);
const ARRAY_BUFFER_VIEW_TYPES = new Set([
  "DataView",
  "Uint8Array",
  "Int8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

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
    // literal shape only carries string/number/boolean, so validate the brand.
    return { kind: "bigint" };
  }
  if (flags & TypeFlags.BooleanLiteral) {
    // Boolean literal flag covers `true` / `false`. Their intrinsic name is
    // "true" / "false", so read it off the type to disambiguate.
    let name = (type as ts.Type & { intrinsicName?: string }).intrinsicName;
    if (name === "true") return { kind: "literal", value: true };
    if (name === "false") return { kind: "literal", value: false };
    return { kind: "boolean" };
  }
  // Template literals and string-mapping types are plain strings at runtime;
  // validate as `string` (the content pattern is not enforced).
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
  if (flags & TypeFlags.Never) {
    return { kind: "unsupported", reason: "the never type, which carries no value" };
  }
  if (flags & TypeFlags.NonPrimitive) {
    return {
      kind: "unsupported",
      reason: "the `object` keyword has no shape to validate",
      fixHint: "use a specific object type, `Record<string, T>`, or `unknown`",
    };
  }
  if (flags & TypeFlags.TypeParameter) {
    // A constrained parameter (`T extends Session`) validates against its
    // constraint; an implicit `unknown` bound falls through to unconstrained.
    let constraint = checker.getBaseConstraintOfType(type);
    if (constraint && constraint !== type) {
      let cf = constraint.getFlags();
      if (!(cf & (TypeFlags.Unknown | TypeFlags.Any))) {
        return resolveType(ctx, constraint, depth + 1);
      }
    }
    // Unconstrained: default to `any` (decorator path) or fail (see GenericFallback).
    if (ctx.generic.mode === "any") {
      ctx.generic.used = true;
      return { kind: "any" };
    }
    return {
      kind: "unsupported",
      reason: "an unresolved generic type parameter",
      fixHint: "constrain it (e.g. `<T extends string>`) or use a concrete type",
    };
  }

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
    // A branded primitive (`string & { __brand }`) is just the primitive on the
    // wire; collapse to it so a branded `UserId` validates as `string`.
    let wirePrimitive =
      TypeFlags.String |
      TypeFlags.Number |
      TypeFlags.Boolean |
      TypeFlags.BigInt |
      TypeFlags.StringLiteral |
      TypeFlags.NumberLiteral |
      TypeFlags.BooleanLiteral |
      TypeFlags.BigIntLiteral;
    let primitive = (type as ts.IntersectionType).types.find(
      (t) => t.getFlags() & wirePrimitive
    );
    if (primitive) return resolveType(ctx, primitive, depth + 1);

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
    // ts.ElementFlags: Required=1, Optional=2, Rest=4, Variadic=8. Used to emit a
    // variable-arity validator for optional (`[a, b?]`) and rest (`[a, ...b[]]`).
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
        // Rest or Variadic: `...number[]` carries the array element type.
        if (sawRest) {
          restNotLast = true;
          break;
        }
        sawRest = true;
        rest = shape.kind === "array" ? shape.element : shape;
      } else {
        // `[...a[], b]` cannot be expressed as head + tail; reject it.
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

    // Built-ins before generic walking, else we enumerate `Date.prototype` etc.
    let builtin = matchBuiltin(ctx, type, depth);
    if (builtin) return finishResolve(ctx, type, entry, builtin);

    // User `Error` subclasses validate as `v.error`. matchBuiltin only catches
    // the global `Error` by name, so walk the base chain for subclasses.
    if (extendsGlobalError(ctx, type)) {
      return finishResolve(ctx, type, entry, { kind: "error" });
    }

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

  if (flags & TypeFlags.Conditional) {
    return {
      kind: "unsupported",
      reason: "a conditional type that does not resolve to a concrete type",
      fixHint:
        "pass a concrete type argument (e.g. a non-generic method, or " +
        "@validateRpc<Service<ConcreteType>>()) so the type resolves",
    };
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
  // Generic object: enumerate properties (methods walk to `any`, not over-constrained).
  let properties: Record<string, TypeShape> = {};
  let name = typeName(type);
  // Numeric and string index signatures lower identically (keys cross the wire
  // as strings); arrays/tuples are handled above, so this is a real map.
  let indexType =
    checker.getIndexTypeOfType?.(type, tsm.IndexKind.String) ??
    checker.getIndexTypeOfType?.(type, tsm.IndexKind.Number);
  let index = indexType ? resolveType(ctx, indexType, depth + 1) : undefined;
  for (let prop of checker.getPropertiesOfType(type)) {
    if (isSymbolNamedProperty(prop)) continue;
    if (RPC_CAPABILITY_BRAND_NAMES.has(prop.getName())) continue;
    // Mapped-type members (`{ [K in U]: V }`) have no declaration; resolve from
    // the symbol directly, else we drop them and under-validate.
    let decl = prop.valueDeclaration ?? prop.declarations?.[0];
    let pType = decl
      ? checker.getTypeOfSymbolAtLocation(prop, decl)
      : checker.getTypeOfSymbol(prop);
    let shape = resolveType(ctx, pType, depth + 1);
    // Optional properties (`foo?: T`) widen to `T | undefined` so missing
    // keys validate cleanly.
    if (prop.getFlags() & tsm.SymbolFlags.Optional) {
      shape = withUndefined(shape);
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
    if (existing.shape) {
      // Repeat reference: hoist a named object/union to one shared validator;
      // primitives, arrays, and tuples inline cheaply.
      if (isHoistableShape(existing)) {
        existing.referenced = true;
        ctx.namedShapes.set(existing.id, existing.shape);
        return { kind: "ref", id: existing.id, name: existing.name };
      }
      return existing.shape;
    }
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

// Worth hoisting only for named objects/unions; anonymous shapes and the rest
// inline cheaply.
function isHoistableShape(entry: ResolveEntry): boolean {
  if (entry.name === undefined || entry.name === "__type") return false;
  let s = entry.shape;
  return s !== undefined && (s.kind === "object" || s.kind === "union");
}

/** Match `type` against the built-in catalogue. Null for non-built-ins or user shadows. */
function matchBuiltin(
  ctx: ResolveContext,
  type: ts.Type,
  depth: number
): TypeShape | null {
  let sym = type.getSymbol();
  if (!sym) return null;
  let name = sym.getName();
  if (!isGlobalSymbol(ctx.tsm, sym)) return null;
  if (MAP_TYPES.has(name)) {
    let args = ctx.checker.getTypeArguments(type as ts.TypeReference);
    return {
      kind: "map",
      key: args[0] ? resolveType(ctx, args[0], depth + 1) : { kind: "any" },
      value: args[1] ? resolveType(ctx, args[1], depth + 1) : { kind: "any" },
    };
  }
  if (SET_TYPES.has(name)) {
    let args = ctx.checker.getTypeArguments(type as ts.TypeReference);
    return {
      kind: "set",
      element: args[0] ? resolveType(ctx, args[0], depth + 1) : { kind: "any" },
    };
  }
  if (ARRAY_BUFFER_VIEW_TYPES.has(name)) {
    let unsupported = rejectSharedArrayBufferView(ctx, type, name);
    if (unsupported) return unsupported;
  }
  if (name in BUILTIN_REJECTED_TYPES) {
    let fixHint = BUILTIN_REJECTED_TYPES[name];
    return {
      kind: "unsupported",
      reason: "not a supported RPC validation type",
      typeExpr: rejectedTypeExpr(ctx, type, name),
      ...(fixHint ? { fixHint } : {}),
    };
  }
  let builtin = BUILTIN_VALUE_TYPES[name];
  if (builtin) return builtin;
  return null;
}

function rejectSharedArrayBufferView(
  ctx: ResolveContext,
  type: ts.Type,
  name: string
): TypeShape | null {
  let args = ctx.checker.getTypeArguments(type as ts.TypeReference);
  if (!args.some((arg) => containsSharedArrayBufferType(ctx, arg))) return null;
  return {
    kind: "unsupported",
    reason: "backed by SharedArrayBuffer",
    typeExpr: rejectedTypeExpr(ctx, type, name),
    fixHint: "Use an ArrayBuffer-backed view instead.",
  };
}

function containsSharedArrayBufferType(
  ctx: ResolveContext,
  type: ts.Type,
  seen = new Set<ts.Type>()
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  // Default typed-array declarations use ArrayBufferLike; keep accepting that
  // type and let runtime validation reject an actual SharedArrayBuffer backing.
  if (type.aliasSymbol?.getName() === "ArrayBufferLike") return false;
  if (isDirectSharedArrayBufferType(ctx, type)) return true;
  if (type.getFlags() & ctx.tsm.TypeFlags.TypeParameter) {
    let constraint = ctx.checker.getBaseConstraintOfType(type);
    return !!constraint && containsSharedArrayBufferType(ctx, constraint, seen);
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some((branch) =>
      containsSharedArrayBufferType(ctx, branch, seen)
    );
  }
  return false;
}

function isDirectSharedArrayBufferType(
  ctx: ResolveContext,
  type: ts.Type
): boolean {
  let sym = type.getSymbol();
  return (
    sym?.getName() === "SharedArrayBuffer" && isGlobalSymbol(ctx.tsm, sym)
  );
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

/** True for a TypeScript lib file (lib.*.d.ts); gates built-in matches. */
export function isTypeScriptLibFileName(fileName: string): boolean {
  return /[\\/]lib\.[\w.-]+\.d\.ts$/.test(fileName);
}

/**
 * True when `sym` is a global declaration of its name. Matching the global (not
 * file path or identity) maps every runtime's `Response` to one validator, since
 * `v.response` checks `instanceof globalThis.Response`; a module-scoped reuse
 * (e.g. `node-fetch`'s `Response`) validates structurally instead.
 */
function isGlobalSymbol(tsm: typeof ts, sym: ts.Symbol): boolean {
  for (let decl of sym.getDeclarations() ?? []) {
    let node: ts.Node | undefined = decl.parent;
    while (node) {
      if (tsm.isModuleDeclaration(node)) {
        // Only `declare global { ... }` re-enters global scope; other modules
        // and namespaces are scoped.
        return (node.flags & tsm.NodeFlags.GlobalAugmentation) !== 0;
      }
      if (tsm.isSourceFile(node)) {
        // A non-module (script) declaration file declares globals directly;
        // an external module's top-level declarations are module-scoped.
        return !tsm.isExternalModule(node);
      }
      node = node.parent;
    }
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
  // A deferred conditional (e.g. a generic `RpcStub<T>`) has a caller-determined
  // surface, so resolve it to a service-less stub when stub-branded: validate
  // the boundary, pass pipelined calls through. Reading the brand's `T` here
  // would yield an empty surface that wrongly rejects every pipelined call.
  if (flags & TypeFlags.Conditional) {
    return getProperty(ctx, type, "__RPC_STUB_BRAND") !== undefined ||
      hasRpcCapabilityBrand(ctx, type)
      ? {}
      : null;
  }
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

  // Walk base types for RpcTarget / WorkerEntrypoint (callers filtered to object-like).
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
  // Structural fallback for a Fetcher with an erased alias. Require fetch's
  // Response-returning signature so a user `{ fetch(); connect() }` is not misread.
  let props = ctx.checker.getPropertiesOfType(type);
  return (
    props.length === 2 &&
    hasFetcherMethods(ctx, type) &&
    fetchReturnsResponse(ctx, type)
  );
}

function fetchReturnsResponse(ctx: ResolveContext, type: ts.Type): boolean {
  let prop = getProperty(ctx, type, "fetch");
  let decl = prop?.valueDeclaration ?? prop?.declarations?.[0];
  if (!prop || !decl) return false;
  let fetchType = ctx.checker.getTypeOfSymbolAtLocation(prop, decl);
  let sigs = fetchType.getCallSignatures();
  if (sigs.length === 0) return false;
  let ret = ctx.checker.getReturnTypeOfSignature(sigs[0]!);
  let unwrapped = unwrapPromise(ctx.tsm, ctx.checker, ret);
  let retSym = unwrapped.getSymbol();
  // Gate on the global symbol so a user type merely named `Response` does not
  // make a plain object look like a pass-through Fetcher capability.
  return retSym?.getName() === "Response" && isGlobalSymbol(ctx.tsm, retSym);
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
  return ctx.checker.getPropertyOfType(type, name);
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

export function isCapnwebValidateSymbol(sym: ts.Symbol): boolean {
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
    // Installed capnweb and generated Workers types. Scoped to node_modules so a
    // project under a `capnweb` dir is not misdetected (specifier check is below).
    if (/[\\/]node_modules[\\/]capnweb[\\/]/.test(fileName)) return true;
    if (/[\\/]@cloudflare[\\/]workers-types[\\/]/.test(fileName)) return true;
  }
  // Ambient `declare module "capnweb" { ... }`, which covers test fixtures and any
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

// True when a member is declared on a platform/library RPC base class or
// interface (anything from capnweb / @cloudflare/workers-types / the
// cloudflare:workers module), i.e. inherited machinery rather than a method the
// user wrote. The declaring container is the member declaration's parent.
function isPlatformInheritedMember(decl: ts.Declaration): boolean {
  let container = decl.parent as ts.Node | undefined;
  if (!container) return false;
  let sym = (container as ts.Node & { symbol?: ts.Symbol }).symbol;
  return sym !== undefined && isRpcRuntimeSymbol(sym);
}

function isRpcReadableProperty(
  ctx: ResolveContext,
  serviceType: ts.Type,
  prop: ts.Symbol,
  decl: ts.Declaration | undefined
): boolean {
  if (prop.flags & ctx.tsm.SymbolFlags.GetAccessor) return true;
  if (!decl) return true;
  if (ctx.tsm.isPropertySignature(decl)) return true;
  if (ctx.tsm.isPropertyAssignment(decl)) return true;
  if (ctx.tsm.isShorthandPropertyAssignment(decl)) return true;
  return (
    !extendsRpcReferenceTarget(ctx.checker, serviceType) &&
    !ctx.tsm.isPropertyDeclaration(decl)
  );
}

// Lifecycle entrypoints the Workers runtime invokes directly, not over RPC.
// Matched by name because `connect` is not declared on either base type.
const WORKERS_LIFECYCLE_METHOD_NAME_FALLBACKS = ["fetch", "connect"] as const;

function isWorkersLifecycleBaseSymbol(sym: ts.Symbol): boolean {
  let name = sym.getName();
  return (
    (name === "WorkerEntrypoint" || name === "DurableObject") &&
    isRpcRuntimeSymbol(sym)
  );
}

// Platform-inherited method names of `type` (e.g. WorkerEntrypoint `fetch`).
export function collectPlatformMethodNames(
  checker: ts.TypeChecker,
  type: ts.Type
): string[] {
  let names = new Set<string>();
  let isWorkersPlatformTarget = false;
  let add = (prop: ts.Symbol): void => {
    if (isSymbolNamedProperty(prop)) return;
    if (RPC_CAPABILITY_BRAND_NAMES.has(prop.getName())) return;
    // Methods only: a platform data field (`ctx`/`env`) is not a hook.
    let decl = prop.valueDeclaration ?? prop.declarations?.[0];
    let pType = decl
      ? checker.getTypeOfSymbolAtLocation(prop, decl)
      : checker.getTypeOfSymbol(prop);
    if (checker.getNonNullableType(pType).getCallSignatures().length === 0) return;
    names.add(prop.getName());
  };
  for (let prop of checker.getPropertiesOfType(type)) {
    let decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (decl && isPlatformInheritedMember(decl)) add(prop);
  }
  // Walk platform base types directly, so a hook the subclass overrides (its
  // declaration now on the user class, e.g. `fetch`) is still recognized.
  let seen = new Set<ts.Type>();
  let walk = (t: ts.Type): void => {
    for (let base of (t as ts.InterfaceType).getBaseTypes?.() ?? []) {
      if (seen.has(base)) continue;
      seen.add(base);
      let sym = base.getSymbol();
      if (sym && isRpcRuntimeSymbol(sym)) {
        if (isWorkersLifecycleBaseSymbol(sym)) isWorkersPlatformTarget = true;
        for (let prop of checker.getPropertiesOfType(base)) add(prop);
      }
      walk(base);
    }
  };
  walk(type);
  if (isWorkersPlatformTarget) {
    // Catches overrides and undeclared hooks that the base-type walk misses.
    for (let name of WORKERS_LIFECYCLE_METHOD_NAME_FALLBACKS) {
      let prop = checker.getPropertyOfType(type, name);
      if (prop) add(prop);
    }
  }
  return [...names];
}

export function isWorkerEntrypointType(
  checker: ts.TypeChecker,
  type: ts.Type
): boolean {
  return extendsNamedRpcBase(checker, type, "WorkerEntrypoint");
}

// Bare RpcTarget/WorkerEntrypoint itself (not a user subclass): the base symbol
// with no RPC base in its own heritage chain.
function isBareRpcBaseType(checker: ts.TypeChecker, type: ts.Type): boolean {
  let sym = type.getSymbol();
  return (
    !!sym && isRpcBaseSymbol(sym) && !extendsRpcReferenceTarget(checker, type)
  );
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

// True when `type` is or extends the global `Error`, so it validates as `v.error`.
// The isGlobalSymbol gate keeps a user type merely named `Error` from matching.
function extendsGlobalError(ctx: ResolveContext, type: ts.Type): boolean {
  let seen = new Set<ts.Type>();
  function isErrorSymbol(t: ts.Type): boolean {
    let sym = t.getSymbol();
    if (!sym) return false;
    return (
      BUILTIN_VALUE_TYPES[sym.getName()]?.kind === "error" &&
      isGlobalSymbol(ctx.tsm, sym)
    );
  }
  function walk(t: ts.Type): boolean {
    if (seen.has(t)) return false;
    seen.add(t);
    if (isErrorSymbol(t)) return true;
    let bases = (t as ts.InterfaceType).getBaseTypes?.() ?? [];
    for (let b of bases) {
      if (walk(b)) return true;
    }
    return false;
  }
  return walk(type);
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

// Widen a shape to admit `undefined` for an optional property; left unchanged if
// it already admits undefined (or is `any`).
function withUndefined(shape: TypeShape): TypeShape {
  if (shape.kind === "undefined" || shape.kind === "any") return shape;
  if (
    shape.kind === "union" &&
    shape.branches.some((b) => b.kind === "undefined")
  ) {
    return shape;
  }
  return collapseUnion([shape, { kind: "undefined" }]);
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

/** Collect every `unsupported` leaf so the build error lists all offending fields. */
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
      case "map":
        walk(svc, methodName, appendSuffix(position, ".<key>"), shape.key);
        walk(svc, methodName, appendSuffix(position, ".<value>"), shape.value);
        return;
      case "set":
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
