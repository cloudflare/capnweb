// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Core runtime helpers called by transformed user code. This module has no
// dependency on capnweb so capnweb-validate can also be used with native
// Workers RPC.

import { RpcValidationError, type PropertyPath } from "../error.js";

type ValidationOptions = {
  allowDeferred?: boolean;
};

type RuntimeShape =
  | { kind: "array"; element: Validator }
  | { kind: "tuple"; elements: Validator[] }
  | { kind: "object"; properties: Record<string, Validator> }
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
    };

export type ServiceValidator = {
  serviceName: string;
  targetKind?: "workerEntrypoint";
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

/**
 * Validator primitives. The transform emits references to `v.string`,
 * `v.number`, `v.array(v.string)`, etc. when constructing service validators.
 */
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
    // any / unknown / void - permissive on purpose.
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
  tuple(elements: Validator[]): Validator {
    return withShape(
      (value, path, options) => {
        if (isDeferredValidationValue(value, options)) return;
        if (!Array.isArray(value)) fail(path, "tuple", value);
        if (value.length !== elements.length)
          fail(path, `tuple(${elements.length})`, value);
        for (let i = 0; i < elements.length; i++) {
          elements[i]!(value[i], [...path, i], options);
        }
      },
      { kind: "tuple", elements }
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
      { kind: "object", properties: shape }
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
  // ---- Built-in pass-by-value brands. Match by `instanceof` against the
  // platform constructors capnweb itself serialises. `globalThis.X` is the
  // resolved constructor at runtime (Node 18+, Workers, browsers); we look it
  // up lazily so a runtime missing one of these (e.g. Node without `Blob`)
  // doesn't crash on import.
  date(value: unknown, path: PropertyPath, options?: ValidationOptions): void {
    if (isDeferredValidationValue(value, options)) return;
    if (!(value instanceof Date)) fail(path, "Date", value);
  },
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
  blob: brand("Blob"),
  readableStream: brand("ReadableStream"),
  writableStream: brand("WritableStream"),
  headers: brand("Headers"),
  request: brand("Request"),
  response: brand("Response"),
  // ---- Pass-by-reference brands. The wire always delivers an object (a stub
  // / RpcPromise / function-stub). Method-level shape is enforced statically
  // by TypeScript; at runtime we only confirm the receiver is callable / an
  // object so accidental primitives are caught.
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
  // Client-side args can intentionally contain RpcPromise placeholders for
  // promise pipelining, e.g. api.getProfile(api.authenticate(token).id). The
  // concrete value is validated at the server boundary when the pipeline lands.
  return options?.allowDeferred === true && isRpcPromiseLike(value);
}

/**
 * Build a brand validator for a global constructor that may be absent on the
 * current runtime (e.g. `Blob` outside Workers). Missing constructors fail
 * the same way wrong-type values do - the user has no way to satisfy the
 * type, so silently passing would defeat the boundary.
 */
function brand(name: string): Validator {
  return (value, path, options) => {
    if (isDeferredValidationValue(value, options)) return;
    let ctor = (globalThis as Record<string, unknown>)[name] as
      | (new (...a: never[]) => unknown)
      | undefined;
    if (typeof ctor !== "function" || !(value instanceof ctor)) {
      fail(path, name, value);
    }
  };
}

// ---------------------------------------------------------------------------
// Server-side wrapping.
//
// The transform rewrites every server boundary call site like
//   newWorkersRpcResponse(req, new Api(env))
// into
//   __newWorkersRpcResponseWithValidation(req, new Api(env), __validator)
// where `__validator` is a service shape generated for the resolved type of
// the target argument. The helper wraps the target in a Proxy that validates
// every method's incoming args and return value before delegating to the
// original implementation.
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

function canPassThroughMethod(
  prop: string,
  validator?: ServiceValidator
): boolean {
  return (
    PASSTHROUGH_METHODS.has(prop) ||
    (validator?.targetKind === "workerEntrypoint" &&
      WORKER_ENTRYPOINT_LIFECYCLE.has(prop))
  );
}

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

export function wrapServerTarget<T extends object>(
  target: T,
  validator: ServiceValidator
): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      let orig = Reflect.get(t, prop, receiver);
      if (typeof prop !== "string") return orig;
      if (typeof orig !== "function") return orig;
      let methodSpec = validator.methods[prop];
      if (!methodSpec) {
        if (canPassThroughMethod(prop, validator)) return orig.bind(t);
        return missingMethod(validator.serviceName, prop);
      }
      return function wrapped(this: unknown, ...args: unknown[]): unknown {
        if (isUncheckedMethod(methodSpec)) {
          return Reflect.apply(orig as (...a: unknown[]) => unknown, t, args);
        }
        validateArgs(args, methodSpec, validator.serviceName, prop);
        let result = Reflect.apply(
          orig as (...a: unknown[]) => unknown,
          t,
          args
        );
        return validateReturn(
          result,
          methodSpec.returns,
          [validator.serviceName, prop, "<return>"],
          "server"
        );
      };
    },
  });
}

export function validateReturn(
  result: unknown,
  returns: Validator,
  path: PropertyPath,
  side: WrapSide
): unknown {
  if (isRpcPromiseLike(result)) {
    return wrapRpcPromise(result, returns, path, side);
  }
  let resultType = typeof result;
  if (
    result !== null &&
    (resultType === "object" || resultType === "function") &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    return (result as Promise<unknown>).then((value) =>
      validateResolvedValue(value, returns, path, side)
    );
  }
  return validateResolvedValue(result, returns, path, side);
}

function validateResolvedValue(
  value: unknown,
  validator: Validator,
  path: PropertyPath,
  side: WrapSide
): unknown {
  validator(value, path);
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
    let validators =
      shape.kind === "array" ? value.map(() => shape.element) : shape.elements;
    let next: unknown[] | undefined;
    for (let i = 0; i < validators.length && i < value.length; i++) {
      let wrapped = wrapResolvedValue(
        value[i],
        validators[i]!,
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
  side: WrapSide
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
          validateArgs(
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
            side
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
          return wrapRpcPromise(next, propValidator, nextPath, side);
        return validateResolvedValue(next, propValidator, nextPath, side);
      }
      if (canPassThroughMethod(prop))
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
  onfulfilled?: ((value: unknown) => unknown) | null,
  onrejected?: ((reason: unknown) => unknown) | null
): Promise<unknown> {
  let then = Reflect.get(target, "then", receiver) as (
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null
  ) => Promise<unknown>;
  return Reflect.apply(then, target, [
    (value: unknown) => {
      let wrapped = validateResolvedValue(value, returns, path, side);
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

function propertyValidatorFor(
  validator: Validator,
  prop: string
): Validator | undefined {
  let shape = shapeOf(validator);
  if (shape?.kind === "lazy") return propertyValidatorFor(shape.thunk(), prop);
  if (shape?.kind === "object") return shape.properties[prop];
  if (shape?.kind === "array" && numericKey(prop)) return shape.element;
  if (shape?.kind === "tuple" && numericKey(prop))
    return shape.elements[Number(prop)];
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

export function isServiceValidator(value: unknown): value is ServiceValidator {
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
// `newHttpBatchRpcSession<Api>(url)` becomes
//   __newHttpBatchRpcSessionWithValidation(url, __validator)
// The helper builds the underlying capnweb stub then wraps it in a Proxy
// that validates outgoing args before the network call and validates the
// resolved return value before user code sees it.
// ---------------------------------------------------------------------------

export function wrapClientStub(
  stub: object,
  validator: ServiceValidator
): object {
  return new Proxy(stub, {
    get(t, prop, receiver) {
      let orig = Reflect.get(t, prop, receiver);
      if (typeof prop !== "string") return orig;
      if (typeof orig !== "function") return orig;
      let methodSpec = validator.methods[prop];
      if (!methodSpec) {
        if (canPassThroughMethod(prop, validator))
          return (orig as (...a: unknown[]) => unknown).bind(t);
        return missingMethod(validator.serviceName, prop);
      }
      return function wrapped(this: unknown, ...args: unknown[]): unknown {
        if (isUncheckedMethod(methodSpec)) {
          return Reflect.apply(orig as (...a: unknown[]) => unknown, t, args);
        }
        validateArgs(args, methodSpec, validator.serviceName, prop, {
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
          "client"
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
