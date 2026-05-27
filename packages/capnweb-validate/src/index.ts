// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

export { RpcValidationError } from "./error.js";
export type { RpcValidationFailure } from "./error.js";

type AnyClass = abstract new (...args: any[]) => object;
type AnyMethod = (this: unknown, ...args: any[]) => unknown;

type ClassDecoratorMarker = <TClass extends AnyClass>(
  value: TClass,
  context: ClassDecoratorContext<TClass>
) => void | TClass;

type MethodDecoratorMarker = <This, Value extends AnyMethod>(
  value: Value,
  context: ClassMethodDecoratorContext<This, Value>
) => void | Value;

type LegacyMethodDecoratorMarker = (
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor
) => void;

export function validateRpc<TSurface = unknown, TClass extends AnyClass = AnyClass>(
  value: TClass,
  context: ClassDecoratorContext<TClass>
): void | TClass;
export function validateRpc<TSurface = unknown>(): ClassDecoratorMarker;
export function validateRpc(
  ...args: unknown[]
): void | ClassDecoratorMarker {
  return uncompiledDecoratorMarker(args);
}

export function skipRpcValidation<This, Value extends AnyMethod>(
  value: Value,
  context: ClassMethodDecoratorContext<This, Value>
): void | Value;
export function skipRpcValidation(
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor
): void;
export function skipRpcValidation(): MethodDecoratorMarker &
  LegacyMethodDecoratorMarker;
export function skipRpcValidation(
  ...args: unknown[]
): void | (MethodDecoratorMarker & LegacyMethodDecoratorMarker) {
  // Decorator marker read by the transform. Runtime behavior is intentionally
  // a no-op so decorated methods behave normally after TypeScript lowers them.
  if (args.length === 0) return (() => {}) as MethodDecoratorMarker &
    LegacyMethodDecoratorMarker;
}

function uncompiledDecoratorMarker(
  args: unknown[]
): never | ClassDecoratorMarker {
  if (args.length === 0) {
    return () => {
      throwUncompiled();
    };
  }
  throwUncompiled();
}

function throwUncompiled(): never {
  throw new Error(
    "capnweb-validate decorator was called before it was transformed. " +
      "Configure the capnweb-validate bundler plugin or run the capnweb-validate CLI."
  );
}
