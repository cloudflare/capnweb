// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Core runtime helpers called by transformed user code. No capnweb dependency, so this also works with native Workers RPC.

import { RpcValidationError, type PropertyPath } from "../error.js";

type ValidationOptions = {
  allowDeferred?: boolean;
};

type RuntimeShape =
  | { kind: "array"; element: Validator }
  | { kind: "tuple"; elements: Validator[]; rest?: Validator }
  | { kind: "object"; properties: Record<string, Validator>; index?: Validator }
  | { kind: "union"; branches: Validator[] }
  | { kind: "lazy"; thunk: () => Validator }
  | { kind: "stub"; service?: ServiceValidator };

const VALIDATOR_SHAPE = Symbol("capnweb-validate.validatorShape");

export type Validator = ((
  value: unknown,
  path: PropertyPath,
  options?: ValidationOptions
) => void) & { [VALIDATOR_SHAPE]?: RuntimeShape };

export type MethodSpec =
  | { unchecked: true }
  | {
      args: Validator[];
      rest?: Validator;
      returns: Validator;
      unchecked?: false;
      /** Getter accessor: validated on read, not call. `args` empty, `returns` validates the read value. */
      isGetter?: boolean;
    };

export type ValidationMode = "throw" | "warn";

export type ServiceValidator = {
  serviceName: string;
  targetKind?: "workerEntrypoint";
  /** How a failed check is reported. "throw" (default) raises; "warn" logs and lets the value through. */
  mode?: ValidationMode;
  methods: Record<string, MethodSpec>;
};

type WrapSide = "server" | "client";

function fail(path: PropertyPath, expected: string, value: unknown): never {
  let actual = describe(value);
  throw new RpcValidationError(
    `capnweb-validate: at ${formatPath(
      path
    )}: expected ${expected}, got ${actual}`,
    { path, expected, actual, value }
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatPath(path: PropertyPath): string {
  if (path.length === 0) return "<root>";
  return path
    .map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`))
    .join("")
    .replace(/^\./, "");
}

function withShape(validator: Validator, shape: RuntimeShape): Validator {
  Object.defineProperty(validator, VALIDATOR_SHAPE, { value: shape });
  return validator;
}

function shapeOf(validator: Validator): RuntimeShape | undefined {
  return validator[VALIDATOR_SHAPE];
}

function validateStubBrand(
  value: unknown,
  path: PropertyPath,
  options?: ValidationOptions
): void {
  if (isDeferredValidationValue(value, options)) return;
  let valueType = typeof value;
  if (value === null || (valueType !== "object" && valueType !== "function")) {
    fail(path, "stub", value);
  }
}

/** Validator primitives. The transform emits references like `v.string`, `v.array(v.string)` when building service validators. */
export const v = {
  string(
    value: unknown,
    path: PropertyPath,
    options?: ValidationOptions
  ): void {
    if (isDeferredValidationValue(value, options)) return;
    if (typeof value !== "string") fail(path, "string", value);
  },
  number(
    value: unknown,
    path: PropertyPath,
    options?: ValidationOptions
  ): void {
    if (isDeferredValidationValue(value, options)) return;
    if (typeof value !== "number") fail(path, "number", value);
  },
  boolean(
    value: unknown,
    path: PropertyPath,
    options?: ValidationOptions
  ): void {
    if (isDeferredValidationValue(value, options)) return;
    if (typeof value !== "boolean") fail(path, "boolean", value);
  },
  bigint(
    value: unknown,
    path: PropertyPath,
    options?: ValidationOptions
  ): void {
    if (isDeferredValidationValue(value, options)) return;
    if (typeof value !== "bigint") fail(path, "bigint", value);
  },
  null_(value: unknown, path: PropertyPath, options?: ValidationOptions): void {
    if (isDeferredValidationValue(value, options)) return;
    if (value !== null) fail(path, "null", value);
  },
  undefined_(
    value: unknown,
    path: PropertyPath,
    options?: ValidationOptions
  ): void {
    if (isDeferredValidationValue(value, options)) return;
    if (value !== undefined) fail(path, "undefined", value);
  },
  any(_value: unknown, _path: PropertyPath): void {
    // any / unknown / void, permissive on purpose.
  },
  array(elem: Validator): Validator {
    return withShape(
      (value, path, options) => {
        if (isDeferredValidationValue(value, options)) return;
        if (!Array.isArray(value)) fail(path, "array", value);
        for (let i = 0; i < value.length; i++) {
          elem(value[i], [...path, i], options);
        }
      },
      { kind: "array", element: elem }
    );
  },
  tuple(
    elements: Validator[],
    opts?: { minLength?: number; rest?: Validator }
  ): Validator {
    let minLength = opts?.minLength ?? elements.length;
    let rest = opts?.rest;
    let label = `tuple(${elements.length})`;
    if (rest) label = `tuple(>=${minLength})`;
    else if (minLength !== elements.length)
      label = `tuple(${minLength}..${elements.length})`;
    return withShape(
      (value, path, options) => {
        if (isDeferredValidationValue(value, options)) return;
        if (!Array.isArray(value)) fail(path, "tuple", value);
        if (
          value.length < minLength ||
          (!rest && value.length > elements.length)
        )
          fail(path, label, value);
        for (let i = 0; i < value.length; i++) {
          let elem = i < elements.length ? elements[i]! : rest;
          if (elem) elem(value[i], [...path, i], options);
        }
      },
      rest ? { kind: "tuple", elements, rest } : { kind: "tuple", elements }
    );
  },
  object(
    shape: Record<string, Validator>,
    name?: string,
    index?: Validator
  ): Validator {
    let label = name ?? "object";
    let keys = Object.keys(shape);
    let fixed = new Set(keys);
    return withShape(
      (value, path, options) => {
        if (isDeferredValidationValue(value, options)) return;
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          fail(path, label, value);
        }
        let rec = value as Record<string, unknown>;
        for (let key of keys) {
          shape[key]!(rec[key], [...path, key], options);
        }
        if (index) {
          for (let key of Object.keys(rec)) {
            if (!fixed.has(key)) index(rec[key], [...path, key], options);
          }
        }
      },
      { kind: "object", properties: shape, ...(index ? { index } : {}) }
    );
  },
  union(branches: Validator[], name?: string): Validator {
    let label = name ?? "union";
    return withShape(
      (value, path, options) => {
        if (isDeferredValidationValue(value, options)) return;
        for (let branch of branches) {
          try {
            branch(value, path, options);
            return;
          } catch (err) {
            if (!(err instanceof RpcValidationError)) throw err;
          }
        }
        fail(path, label, value);
      },
      { kind: "union", branches }
    );
  },
  literal(
    expected: string | number | boolean | null,
    label?: string
  ): Validator {
    let display = label ?? JSON.stringify(expected);
    return (value, path, options) => {
      if (isDeferredValidationValue(value, options)) return;
      if (value !== expected) fail(path, display, value);
    };
  },
  lazy(thunk: () => Validator): Validator {
    let inner: Validator | undefined;
    return withShape(
      (value, path, options) => {
        if (isDeferredValidationValue(value, options)) return;
        inner ??= thunk();
        inner(value, path, options);
      },
      { kind: "lazy", thunk }
    );
  },
  // ---- Built-in pass-by-value brands. Matched by `instanceof`; constructor looked up lazily so a runtime missing one (e.g. Node without `Blob`) doesn't crash on import.
  // capnweb serializes these by exact prototype, so a subclass instance (e.g.
  // File extends Blob) is rejected at the wire and must be rejected here too.
  date: exactBrand("Date"),
  blob: exactBrand("Blob"),
  readableStream: exactBrand("ReadableStream"),
  writableStream: exactBrand("WritableStream"),
  headers: exactBrand("Headers"),
  request: exactBrand("Request"),
  response: exactBrand("Response"),
  // bytes and error are instanceof: capnweb accepts Buffer (a Uint8Array
  // subclass) for bytes, and matches any Error subclass for error.
  bytes(value: unknown, path: PropertyPath, options?: ValidationOptions): void {
    if (isDeferredValidationValue(value, options)) return;
    if (!(value instanceof Uint8Array)) {
      fail(path, "Uint8Array", value);
    }
  },
  error(value: unknown, path: PropertyPath, options?: ValidationOptions): void {
    if (isDeferredValidationValue(value, options)) return;
    if (!(value instanceof Error)) fail(path, "Error", value);
  },
  // ---- Pass-by-reference brands. Method shape is enforced statically by TS; at runtime only confirm the receiver is callable / an object to catch accidental primitives.
  func(value: unknown, path: PropertyPath, options?: ValidationOptions): void {
    if (isDeferredValidationValue(value, options)) return;
    if (typeof value !== "function") fail(path, "function", value);
  },
  stub: withShape(
    function stub(
      value: unknown,
      path: PropertyPath,
      options?: ValidationOptions
    ): void {
      validateStubBrand(value, path, options);
    },
    { kind: "stub" }
  ),
  stubOf(service: ServiceValidator): Validator {
    return withShape(
      function stubOf(
        value: unknown,
        path: PropertyPath,
        options?: ValidationOptions
      ): void {
        validateStubBrand(value, path, options);
      },
      { kind: "stub", service }
    );
  },
};

function isDeferredValidationValue(
  value: unknown,
  options: ValidationOptions | undefined
): boolean {
  // Client args may hold RpcPromise placeholders for pipelining; the concrete value is checked at the server boundary.
  return options?.allowDeferred === true && isRpcPromiseLike(value);
}

/** Exact-prototype brand for a possibly-absent global constructor (e.g. `Blob` outside Workers). Matches capnweb's serializer, which keys on the exact prototype, so a subclass instance (File extends Blob) is rejected. A missing constructor fails like a wrong-type value, since the user can't satisfy the type. */
function exactBrand(name: string): Validator {
  return (value, path, options) => {
    if (isDeferredValidationValue(value, options)) return;
    let ctor = (globalThis as Record<string, unknown>)[name] as
      | { prototype: unknown }
      | undefined;
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null ||
      typeof ctor !== "function" ||
      Object.getPrototypeOf(value) !== ctor.prototype
    ) {
      fail(path, name, value);
    }
  };
}

// ---------------------------------------------------------------------------
// Server-side wrapping.
//
// The transform rewrites server boundary call sites to pass a generated
// `__validator`; the helper wraps the target in a Proxy that validates each
// method's incoming args and return value before delegating.
// ---------------------------------------------------------------------------

function isUncheckedMethod(
  methodSpec: MethodSpec
): methodSpec is { unchecked: true } {
  return methodSpec.unchecked === true;
}

export function validateArgs(
  args: unknown[],
  methodSpec: Exclude<MethodSpec, { unchecked: true }>,
  serviceName: string,
  prop: string,
  options?: ValidationOptions
): void {
  for (let i = 0; i < methodSpec.args.length; i++) {
    methodSpec.args[i]!(args[i], [serviceName, prop, i], options);
  }
  if (methodSpec.rest) {
    for (let i = methodSpec.args.length; i < args.length; i++) {
      methodSpec.rest(args[i], [serviceName, prop, i], options);
    }
  } else if (args.length > methodSpec.args.length) {
    fail(
      [serviceName, prop, methodSpec.args.length],
      "no extra argument",
      args[methodSpec.args.length]
    );
  }
}

const PASSTHROUGH_METHODS = new Set([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "dup",
  "onRpcBroken",
  "map",
]);


function missingMethod(serviceName: string, prop: string): never {
  throw new RpcValidationError(
    `capnweb-validate: ${serviceName}.${prop} is not in the generated validator`,
    {
      path: [serviceName, prop],
      expected: "known RPC method",
      actual: "missing validator",
      value: undefined,
    }
  );
}

function reportValidationFailure(err: unknown): void {
  // Warn mode logs the mismatch and lets the value through. Re-throw non-validation errors: those are real bugs.
  if (err instanceof RpcValidationError) {
    console.warn(err.message);
    return;
  }
  throw err;
}

function checkArgs(
  mode: ValidationMode,
  args: unknown[],
  methodSpec: Exclude<MethodSpec, { unchecked: true }>,
  serviceName: string,
  prop: string,
  options?: ValidationOptions
): void {
  if (mode === "throw") {
    validateArgs(args, methodSpec, serviceName, prop, options);
    return;
  }
  try {
    validateArgs(args, methodSpec, serviceName, prop, options);
  } catch (err) {
    reportValidationFailure(err);
  }
}

export function wrapServerTarget<T extends object>(
  target: T,
  validator: ServiceValidator
): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      let orig = Reflect.get(t, prop, receiver);
      if (typeof prop !== "string") {
        // Forward symbol-keyed members (Symbol.dispose etc.) bound to the real target; unbound, `this` would be the proxy and re-enter the get trap, throwing missingMethod.
        return typeof orig === "function" ? orig.bind(t) : orig;
      }
      let methodSpec = validator.methods[prop];
      if (methodSpec && !isUncheckedMethod(methodSpec) && methodSpec.isGetter) {
        // Getter: Reflect.get already invoked the accessor, so `orig` is the read value; validate it like a no-arg return.
        return validateReturn(
          orig,
          methodSpec.returns,
          [validator.serviceName, prop],
          "server",
          validator.mode ?? "throw"
        );
      }
      if (typeof orig !== "function") return orig;
      // A method absent from the validator is a platform lifecycle hook the
      // transform excluded from the RPC surface; pass it through unvalidated.
      if (!methodSpec) return orig.bind(t);
      let mode = validator.mode ?? "throw";
      return function wrapped(this: unknown, ...args: unknown[]): unknown {
        if (isUncheckedMethod(methodSpec)) {
          return Reflect.apply(orig as (...a: unknown[]) => unknown, t, args);
        }
        checkArgs(mode, args, methodSpec, validator.serviceName, prop);
        let result = Reflect.apply(
          orig as (...a: unknown[]) => unknown,
          t,
          args
        );
        return validateReturn(
          result,
          methodSpec.returns,
          [validator.serviceName, prop, "<return>"],
          "server",
          mode
        );
      };
    },
  });
}

export function validateReturn(
  result: unknown,
  returns: Validator,
  path: PropertyPath,
  side: WrapSide,
  mode: ValidationMode = "throw"
): unknown {
  if (isRpcPromiseLike(result)) {
    return wrapRpcPromise(result, returns, path, side, mode);
  }
  let resultType = typeof result;
  if (
    result !== null &&
    (resultType === "object" || resultType === "function") &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    return (result as Promise<unknown>).then((value) =>
      validateResolvedValue(value, returns, path, side, mode)
    );
  }
  return validateResolvedValue(result, returns, path, side, mode);
}

function validateResolvedValue(
  value: unknown,
  validator: Validator,
  path: PropertyPath,
  side: WrapSide,
  mode: ValidationMode
): unknown {
  if (mode === "warn") {
    try {
      validator(value, path);
    } catch (err) {
      // Validation failed: warn and pass the original value through unwrapped.
      reportValidationFailure(err);
      return value;
    }
  } else {
    validator(value, path);
  }
  return wrapResolvedValue(value, validator, path, side);
}

function wrapResolvedValue(
  value: unknown,
  validator: Validator,
  path: PropertyPath,
  side: WrapSide
): unknown {
  let shape = shapeOf(validator);
  if (!shape) return value;
  if (shape.kind === "lazy")
    return wrapResolvedValue(value, shape.thunk(), path, side);
  if (shape.kind === "union") {
    for (let branch of shape.branches) {
      try {
        branch(value, path);
        return wrapResolvedValue(value, branch, path, side);
      } catch (err) {
        if (!(err instanceof RpcValidationError)) throw err;
      }
    }
    return value;
  }
  if (shape.kind === "stub") {
    if (!shape.service) return value;
    let valueType = typeof value;
    if (value === null || (valueType !== "object" && valueType !== "function"))
      return value;
    return side === "server"
      ? wrapServerTarget(value as object, shape.service)
      : wrapClientStub(value as object, shape.service);
  }
  if (shape.kind === "array" || shape.kind === "tuple") {
    if (!Array.isArray(value)) return value;
    let next: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      let elemValidator =
        shape.kind === "array"
          ? shape.element
          : (shape.elements[i] ?? shape.rest);
      if (!elemValidator) continue;
      let wrapped = wrapResolvedValue(
        value[i],
        elemValidator,
        [...path, i],
        side
      );
      if (wrapped !== value[i]) {
        next ??= value.slice();
        next[i] = wrapped;
      }
    }
    return next ?? value;
  }
  if (shape.kind === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    let rec = value as Record<string, unknown>;
    let next: Record<string, unknown> | undefined;
    for (let [key, propValidator] of Object.entries(shape.properties)) {
      let wrapped = wrapResolvedValue(
        rec[key],
        propValidator,
        [...path, key],
        side
      );
      if (wrapped !== rec[key]) {
        next ??= { ...rec };
        next[key] = wrapped;
      }
    }
    // Index-signature / Record values: wrap each dynamic key not covered by a
    // fixed property, so stubs reached through `Record<string, Stub<T>>` are
    // wrapped and their pipelined calls validate.
    if (shape.index) {
      for (let key of Object.keys(rec)) {
        if (key in shape.properties) continue;
        let wrapped = wrapResolvedValue(rec[key], shape.index, [...path, key], side);
        if (wrapped !== rec[key]) {
          next ??= { ...rec };
          next[key] = wrapped;
        }
      }
    }
    return next ?? value;
  }
  return value;
}

function isRpcPromiseLike(
  value: unknown
): value is (...args: unknown[]) => unknown {
  return (
    typeof value === "function" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function wrapRpcPromise(
  result: (...args: unknown[]) => unknown,
  returns: Validator,
  path: PropertyPath,
  side: WrapSide,
  mode: ValidationMode
): object {
  return new Proxy(result, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return (
          onfulfilled?: ((value: unknown) => unknown) | null,
          onrejected?: ((reason: unknown) => unknown) | null
        ) => {
          return callValidatedThen(
            target,
            receiver,
            returns,
            path,
            side,
            mode,
            onfulfilled,
            onrejected
          );
        };
      }
      if (prop === "catch") {
        return (onrejected?: ((reason: unknown) => unknown) | null) => {
          return callValidatedThen(
            target,
            receiver,
            returns,
            path,
            side,
            mode,
            undefined,
            onrejected
          );
        };
      }
      if (prop === "finally") {
        return (onfinally?: (() => unknown) | null) => {
          return callValidatedThen(
            target,
            receiver,
            returns,
            path,
            side,
            mode,
            (value) => {
              return Promise.resolve(onfinally?.()).then(() => value);
            },
            (reason) => {
              return Promise.resolve(onfinally?.()).then(() => {
                throw reason;
              });
            }
          );
        };
      }
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      let methodSpec = methodSpecFor(returns, prop);
      if (methodSpec) {
        return function wrappedPipelined(
          this: unknown,
          ...args: unknown[]
        ): unknown {
          let orig = Reflect.get(target, prop, receiver);
          if (isUncheckedMethod(methodSpec)) {
            return Reflect.apply(
              orig as (...a: unknown[]) => unknown,
              target,
              args
            );
          }
          checkArgs(
            mode,
            args,
            methodSpec,
            serviceNameFor(returns) ?? "Service",
            prop,
            {
              allowDeferred: side === "client",
            }
          );
          let result = Reflect.apply(
            orig as (...a: unknown[]) => unknown,
            target,
            args
          );
          return validateReturn(
            result,
            methodSpec.returns,
            [...path, prop, "<return>"],
            side,
            mode
          );
        };
      }
      let propValidator = propertyValidatorFor(returns, prop);
      if (propValidator) {
        let nextPath = numericKey(prop)
          ? [...path, Number(prop)]
          : [...path, prop];
        let next = Reflect.get(target, prop, receiver);
        if (isRpcPromiseLike(next))
          return wrapRpcPromise(next, propValidator, nextPath, side, mode);
        return validateResolvedValue(next, propValidator, nextPath, side, mode);
      }
      if (PASSTHROUGH_METHODS.has(prop))
        return Reflect.get(target, prop, receiver);
      // A service-less stub (e.g. recursive) has no method list to check, so pass the call through instead of throwing.
      if (isUnknownSurfaceStub(returns))
        return Reflect.get(target, prop, receiver);
      return missingMethod(serviceNameFor(returns) ?? formatPath(path), prop);
    },
    apply(target, thisArg, argArray) {
      return Reflect.apply(
        target as (...args: unknown[]) => unknown,
        thisArg,
        argArray
      );
    },
  });
}

function callValidatedThen(
  target: (...args: unknown[]) => unknown,
  receiver: unknown,
  returns: Validator,
  path: PropertyPath,
  side: WrapSide,
  mode: ValidationMode,
  onfulfilled?: ((value: unknown) => unknown) | null,
  onrejected?: ((reason: unknown) => unknown) | null
): Promise<unknown> {
  let then = Reflect.get(target, "then", receiver) as (
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null
  ) => Promise<unknown>;
  return Reflect.apply(then, target, [
    (value: unknown) => {
      // Validation runs in the fulfillment handler; route a failure to onrejected so the awaiter rejects rather than hangs,
      // or rethrow when there is no onrejected (bare `.then(onF)`) to reject the chained promise.
      let wrapped: unknown;
      try {
        wrapped = validateResolvedValue(value, returns, path, side, mode);
      } catch (err) {
        if (onrejected) return onrejected(err);
        throw err;
      }
      return onfulfilled ? onfulfilled(wrapped) : wrapped;
    },
    onrejected,
  ]);
}

function methodSpecFor(
  validator: Validator,
  prop: string
): MethodSpec | undefined {
  let shape = shapeOf(validator);
  if (shape?.kind === "lazy") return methodSpecFor(shape.thunk(), prop);
  if (shape?.kind !== "stub") return undefined;
  return shape.service?.methods[prop];
}

function serviceNameFor(validator: Validator): string | undefined {
  let shape = shapeOf(validator);
  if (shape?.kind === "lazy") return serviceNameFor(shape.thunk());
  if (shape?.kind !== "stub") return undefined;
  return shape.service?.serviceName;
}

// True for a stub whose service surface could not be resolved. Pipelined
// access on it can't be checked, so the runtime passes it through.
function isUnknownSurfaceStub(validator: Validator): boolean {
  let shape = shapeOf(validator);
  while (shape?.kind === "lazy") shape = shapeOf(shape.thunk());
  return shape?.kind === "stub" && !shape.service;
}

function propertyValidatorFor(
  validator: Validator,
  prop: string
): Validator | undefined {
  let shape = shapeOf(validator);
  if (shape?.kind === "lazy") return propertyValidatorFor(shape.thunk(), prop);
  if (shape?.kind === "object")
    return shape.properties[prop] ?? shape.index;
  if (shape?.kind === "array" && numericKey(prop)) return shape.element;
  if (shape?.kind === "tuple" && numericKey(prop)) {
    let i = Number(prop);
    return i < shape.elements.length ? shape.elements[i] : shape.rest;
  }
  return undefined;
}

function numericKey(prop: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(prop);
}

export function splitTrailingValidator(rest: unknown[]): {
  args: unknown[];
  validator: ServiceValidator;
} {
  let validator = rest.at(-1);
  if (!isServiceValidator(validator)) {
    throw new Error("capnweb-validate: internal helper missing validator");
  }
  return { args: rest.slice(0, -1), validator };
}

function isServiceValidator(value: unknown): value is ServiceValidator {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { serviceName?: unknown }).serviceName === "string" &&
    typeof (value as { methods?: unknown }).methods === "object"
  );
}

// ---------------------------------------------------------------------------
// Client-side wrapping.
//
// The helper builds the capnweb stub then wraps it in a Proxy that validates
// outgoing args before the network call and the resolved return before user code.
// ---------------------------------------------------------------------------

export function wrapClientStub(
  stub: object,
  validator: ServiceValidator
): object {
  return new Proxy(stub, {
    get(t, prop, receiver) {
      let orig = Reflect.get(t, prop, receiver);
      if (typeof prop !== "string") {
        // See wrapServerTarget: forward symbol-keyed members bound to the
        // target so disposal and other well-known-symbol hooks keep working.
        return typeof orig === "function" ? orig.bind(t) : orig;
      }
      let methodSpec = validator.methods[prop];
      if (methodSpec && !isUncheckedMethod(methodSpec) && methodSpec.isGetter) {
        // A getter read returns an RpcPromise for the value; validate its
        // resolved value (and keep pipelining working) like a method return.
        return validateReturn(
          orig,
          methodSpec.returns,
          [validator.serviceName, prop],
          "client",
          validator.mode ?? "throw"
        );
      }
      if (typeof orig !== "function") return orig;
      // Not in the validator: a method outside the typechecked RPC surface.
      if (!methodSpec) return (orig as (...a: unknown[]) => unknown).bind(t);
      let mode = validator.mode ?? "throw";
      return function wrapped(this: unknown, ...args: unknown[]): unknown {
        if (isUncheckedMethod(methodSpec)) {
          return Reflect.apply(orig as (...a: unknown[]) => unknown, t, args);
        }
        checkArgs(mode, args, methodSpec, validator.serviceName, prop, {
          allowDeferred: true,
        });
        let result = Reflect.apply(
          orig as (...a: unknown[]) => unknown,
          t,
          args
        );
        return validateReturn(
          result,
          methodSpec.returns,
          [validator.serviceName, prop, "<return>"],
          "client",
          mode
        );
      };
    },
  });
}

export function __validateRpcClass<T extends new (...args: any[]) => object>(
  validator: ServiceValidator
): (value: T, context?: unknown) => T {
  return function validateRpcClass(value: T, _context?: unknown): T {
    return class extends value {
      constructor(...args: any[]) {
        super(...args);
        return wrapServerTarget(this, validator);
      }
    } as T;
  };
}
