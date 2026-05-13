// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import {
  RpcTarget,
  type RpcClassValidators,
  type RpcMethodValidator,
  type RpcValidationOptions,
  setRpcMethodValidators,
  setRpcStubValidators,
} from "../core.js";
import type { ClassSpec, MethodSpec, TypeSpec } from "./types.js";

type RpcValidationFailure = { path: string[]; expected: string; actual: string; value: unknown };

export function __capnweb_registerRpcValidators(
    classes: Record<string, Function>, classSpecs: readonly ClassSpec[]): void {
  for (let spec of classSpecs) {
    let klass = classes[spec.name];
    if (!klass) throw new Error(`Missing class '${spec.name}' for Cap'n Web validator.`);
    let validators: RpcClassValidators = {};
    for (let method of spec.methods) validators[method.name] = makeMethodValidator(spec.name, method);
    setRpcMethodValidators(klass, validators);
  }
}

export function __capnweb_bindClientValidator<T extends object>(stub: T, classSpec: ClassSpec): T {
  let validators: RpcClassValidators = {};
  for (let method of classSpec.methods) validators[method.name] = makeMethodValidator(classSpec.name, method);
  setRpcStubValidators(stub, validators);
  return stub;
}

function makeMethodValidator(className: string, method: MethodSpec): RpcMethodValidator {
  let prefix = `${className}.${method.name}`;
  let minArgs = method.params.reduce((min, param, index) => param.optional ? min : index + 1, 0);
  return {
    args(args, options) {
      if (args.length < minArgs || args.length > method.params.length) {
        let expected = minArgs === method.params.length ? `${minArgs}` : `${minArgs}-${method.params.length}`;
        throw new TypeError(`${prefix} expected ${expected} argument(s), got ${args.length}`);
      }
      for (let i = 0; i < args.length; i++) {
        let param = method.params[i];
        if (!param || (param.optional && args[i] === undefined)) continue;
        let failure = validateTypeSpec(param.type, args[i], [param.name], options);
        if (failure) throw makeValidationError(prefix, failure);
      }
    },
    returns(value) {
      let failure = validateTypeSpec(method.returns, value, []);
      if (failure) throw makeValidationError(`${prefix} return`, failure);
    },
  };
}

function makeValidationError(prefix: string, failure: RpcValidationFailure): TypeError {
  let where = failure.path.length > 0 ? failure.path.join(".") : "value";
  let err = new TypeError(`${prefix}: ${where}: expected ${failure.expected}, got ${failure.actual}`);
  (err as TypeError & { rpcValidation: RpcValidationFailure }).rpcValidation = failure;
  return err;
}

function validateTypeSpec(
    type: TypeSpec, value: unknown, path: string[],
    options?: RpcValidationOptions): RpcValidationFailure | undefined {
  if (options?.isRpcPlaceholder?.(value)) return undefined;
  let mismatch = (): RpcValidationFailure => ({ path, expected: describeTypeSpec(type), actual: actualKind(value), value });
  switch (type.kind) {
    case "any": return undefined;
    case "never": return mismatch();
    case "primitive":
      switch (type.name) {
        case "string": return typeof value === "string" ? undefined : mismatch();
        case "number": return typeof value === "number" ? undefined : mismatch();
        case "bigint": return typeof value === "bigint" ? undefined : mismatch();
        case "boolean": return typeof value === "boolean" ? undefined : mismatch();
        case "undefined":
        case "void": return value === undefined ? undefined : mismatch();
        case "null": return value === null ? undefined : mismatch();
      }
    case "literal": return value === type.value ? undefined : mismatch();
    case "array": {
      if (!Array.isArray(value)) return mismatch();
      for (let i = 0; i < value.length; i++) {
        let failure = validateTypeSpec(type.element, value[i], [...path, `[${i}]`], options);
        if (failure) return failure;
      }
      return undefined;
    }
    case "tuple": {
      if (!Array.isArray(value) || value.length !== type.elements.length) return mismatch();
      for (let i = 0; i < type.elements.length; i++) {
        let failure = validateTypeSpec(type.elements[i], value[i], [...path, `[${i}]`], options);
        if (failure) return failure;
      }
      return undefined;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return mismatch();
      let record = value as Record<string, unknown>;
      for (let prop of type.props) {
        if (!Object.prototype.hasOwnProperty.call(record, prop.name)) {
          if (prop.optional) continue;
          return { path: [...path, prop.name], expected: describeTypeSpec(prop.type), actual: "missing", value: undefined };
        }
        if (record[prop.name] === undefined && prop.optional) continue;
        let failure = validateTypeSpec(prop.type, record[prop.name], [...path, prop.name], options);
        if (failure) return failure;
      }
      return undefined;
    }
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return mismatch();
      for (let [key, item] of Object.entries(value as Record<string, unknown>)) {
        let failure = validateTypeSpec(type.value, item, [...path, key], options);
        if (failure) return failure;
      }
      return undefined;
    }
    case "union": {
      let failures: RpcValidationFailure[] = [];
      for (let variant of type.variants) {
        let failure = validateTypeSpec(variant, value, path, options);
        if (!failure) return undefined;
        failures.push(failure);
      }
      return failures.find(failure => failure.path.length > path.length) ?? mismatch();
    }
    case "instance": {
      let ctor = (globalThis as Record<string, unknown>)[type.name];
      return typeof ctor === "function" && value instanceof ctor ? undefined : mismatch();
    }
    case "rpcTarget": return value instanceof RpcTarget ? undefined : mismatch();
    case "stub": return value !== null && (typeof value === "object" || typeof value === "function") ? undefined : mismatch();
    case "function": return typeof value === "function" ? undefined : mismatch();
    case "unsupported": return mismatch();
  }
}

function describeTypeSpec(type: TypeSpec): string {
  switch (type.kind) {
    case "any": return "any";
    case "never": return "never";
    case "primitive": return type.name === "void" ? "undefined" : type.name;
    case "literal": return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value);
    case "array": return `${describeTypeSpec(type.element)}[]`;
    case "tuple": return `[${type.elements.map(describeTypeSpec).join(", ")}]`;
    case "object": return `{ ${type.props.map(p => `${p.name}${p.optional ? "?" : ""}: ${describeTypeSpec(p.type)}`).join(", ")} }`;
    case "record": return `Record<string, ${describeTypeSpec(type.value)}>`;
    case "union": return type.variants.map(describeTypeSpec).sort().join(" | ");
    case "instance": return type.name;
    case "rpcTarget": return "RpcTarget";
    case "stub": return "RpcStub";
    case "function": return "Function";
    case "unsupported": return type.text;
  }
}

function actualKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (value instanceof RegExp) return "RegExp";
  if (value instanceof Error) return "Error";
  if (typeof value === "object") {
    let ctor = (value as object).constructor;
    if (ctor && ctor.name && ctor.name !== "Object") return ctor.name;
    return "object";
  }
  return typeof value;
}

export type { ClassSpec, MethodSpec, ObjectProp, ParamSpec, PrimitiveName, TypeSpec } from "./types.js";
