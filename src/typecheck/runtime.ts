// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Runtime side of the typecheck feature. Consumes typia-generated validator
// functions emitted at build time by `capnweb-typecheck` and adapts them to
// Cap'n Web's `RpcMethodValidator` shape (throw on failure, preserve
// `RpcPromise` placeholders to keep pipelining working).
//
// Imported by the main bundle so `capnweb/internal/typecheck` can share the
// same validator state as normal `capnweb` imports.

import {
  type RpcClassValidators,
  type RpcMethodValidator,
  setRpcMethodValidators,
  setRpcStubValidators,
} from "../core.js";
import type { TypiaValidationError, TypiaValidationResult } from "./typia-runtime.js";

// Re-export the vendored typia helpers under stable names so generated code
// can resolve them through `capnweb/internal/typecheck`. The post-process
// step in `capnweb-typecheck`'s build rewrites typia's `lib/internal/*`
// imports to point here.
export { _validateReport, _createStandardSchema } from "./typia-runtime.js";
export type { TypiaValidationError, TypiaValidationResult } from "./typia-runtime.js";

/**
 * Validator function signature emitted by `typia.createValidate<T>()`. We
 * treat these as opaque -- typia generates the body, we only call it and
 * inspect the `{success, errors}` result.
 */
export type TypiaValidator = (input: unknown) => TypiaValidationResult;

/**
 * Per-method validator set produced by the generator: one validator per
 * positional parameter (for per-arg pipelining-aware checks) plus a return
 * validator. `paramNames` is recorded so error messages can reference the
 * parameter by name instead of by index. `paramOptional` says whether each
 * positional parameter can be elided when calling the method.
 */
export type RpcMethodTypiaValidators = {
  paramNames: readonly string[];
  paramOptional: readonly boolean[];
  paramValidators: readonly TypiaValidator[];
  returns: TypiaValidator;
};

export type RpcClassTypiaValidators = Record<string, RpcMethodTypiaValidators>;
export type RpcTypiaRegistry = Record<string, RpcClassTypiaValidators>;

/**
 * Shape of `err.rpcValidation` on the `TypeError`s thrown by registered
 * validators.
 */
type RpcValidationFailure = {
  path: string[];
  expected: string;
  actual: string;
  value: unknown;
};

/**
 * Register per-method argument and return-value validators for a set of
 * `RpcTarget` classes. `classes` maps the spec class name (a string emitted
 * by generated code) to the runtime constructor. `registry` is the
 * typia-backed validator map produced by `capnweb-typecheck`.
 */
export function __capnweb_registerRpcValidators(
    classes: Record<string, Function>, registry: RpcTypiaRegistry): void {
  for (let className in registry) {
    let klass = classes[className];
    if (!klass) {
      throw new Error(`Missing class '${className}' for Cap'n Web validator.`);
    }
    let methodValidators: RpcClassValidators = {};
    for (let methodName in registry[className]) {
      methodValidators[methodName] = wrapTypiaValidators(
          `${className}.${methodName}`, registry[className][methodName]);
    }
    setRpcMethodValidators(klass, methodValidators);
  }
}

/**
 * Bind client-side argument and return validators to an existing `RpcStub`
 * and return that same stub. Generated code wraps typed factory calls with
 * this helper, so the application still receives the original Cap'n Web
 * proxy object and `RpcPromise` pipelining / disposal / `StubBase` methods
 * keep their normal behavior.
 */
export function __capnweb_bindClientValidator<T extends object>(
    stub: T, className: string, validators: RpcClassTypiaValidators): T {
  let methodValidators: RpcClassValidators = {};
  for (let methodName in validators) {
    methodValidators[methodName] = wrapTypiaValidators(
        `${className}.${methodName}`, validators[methodName]);
  }
  setRpcStubValidators(stub, methodValidators);
  return stub;
}

function wrapTypiaValidators(
    prefix: string, raw: RpcMethodTypiaValidators): RpcMethodValidator {
  let maxArgs = raw.paramValidators.length;
  let minArgs = raw.paramOptional.reduce((min, optional, index) =>
    optional ? min : index + 1, 0);
  return {
    args(argList, options) {
      if (argList.length < minArgs || argList.length > maxArgs) {
        let expected = minArgs === maxArgs ? `${maxArgs}` : `${minArgs}-${maxArgs}`;
        throw new TypeError(
            `${prefix} expected ${expected} argument(s), got ${argList.length}`);
      }
      for (let i = 0; i < argList.length; i++) {
        let arg = argList[i];
        // Preserve RpcPromise pipelining: skip validation for pipelined
        // placeholders. The eventual value will still be validated on the
        // server when it's delivered.
        if (options?.isRpcPlaceholder?.(arg)) continue;
        let validator = raw.paramValidators[i];
        if (!validator) continue;
        let result = validator(arg);
        if (!result.success) {
          throw makeValidationError(prefix, raw.paramNames[i], result.errors, false);
        }
      }
    },
    returns(value) {
      let result = raw.returns(value);
      if (!result.success) {
        throw makeValidationError(prefix, undefined, result.errors, true);
      }
    },
  };
}

function makeValidationError(
    prefix: string, paramName: string | undefined,
    errors: TypiaValidationError[], isReturn: boolean): TypeError {
  let first = errors[0];
  let pathSegments = stripInputPrefix(first.path);
  let actual = actualKind(first.value);
  let where: string;
  let publicPath: string[];

  if (isReturn) {
    publicPath = pathSegments;
    where = pathSegments.length > 0 ? pathSegments.join(".") : "value";
  } else {
    publicPath = paramName ? [paramName, ...pathSegments] : pathSegments;
    where = publicPath.length > 0 ? publicPath.join(".") : "value";
  }

  let header = isReturn ? `${prefix} return` : prefix;
  let err = new TypeError(`${header}: ${where}: expected ${first.expected}, got ${actual}`);
  (err as TypeError & { rpcValidation: RpcValidationFailure }).rpcValidation = {
    path: publicPath, expected: first.expected, actual, value: first.value,
  };
  return err;
}

// Typia paths look like:
//   $input            (the root)
//   $input.user.name  (nested property)
//   $input[0]         (numeric index)
//   $input["k"]       (string-literal key)
// Strip the `$input` head and split into a flat list of property/index segments.
function stripInputPrefix(path: string): string[] {
  let rest = path.startsWith("$input") ? path.slice("$input".length) : path;
  let out: string[] = [];
  let i = 0;
  while (i < rest.length) {
    let c = rest[i];
    if (c === ".") {
      let end = i + 1;
      while (end < rest.length && rest[end] !== "." && rest[end] !== "[") end++;
      out.push(rest.slice(i + 1, end));
      i = end;
    } else if (c === "[") {
      let close = rest.indexOf("]", i);
      if (close < 0) break;
      let segment = rest.slice(i + 1, close);
      if (segment.startsWith("\"") && segment.endsWith("\"")) {
        out.push(JSON.parse(segment));
      } else {
        out.push(`[${segment}]`);
      }
      i = close + 1;
    } else {
      i++;
    }
  }
  return out;
}

function actualKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (value instanceof RegExp) return "RegExp";
  if (value instanceof Error) return "Error";
  if (typeof value === "object" && value !== null) {
    let ctor = (value as object).constructor;
    if (ctor && ctor.name && ctor.name !== "Object") return ctor.name;
    return "object";
  }
  return typeof value;
}
