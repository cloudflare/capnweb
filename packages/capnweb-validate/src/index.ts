// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { ValidatedStub } from "./internal/core.js";
export type { ValidatedStub } from "./internal/core.js";

type AnyClass = abstract new (...args: any[]) => object;
type AnyMethod = (this: unknown, ...args: any[]) => unknown;

// Optional `@validateRpc<TSurface>()` arg: the class instance must satisfy
// TSurface, and the transform uses TSurface as the exact RPC surface. No arg =>
// `unknown`, so any class is accepted and the transform uses the class surface.
//
// `context` is optional and the class is returned so the same marker works as a
// plain wrapper for codebases that can't enable decorators:
// `export default validateRpc<TSurface>()(MyApi)`.
type ClassDecoratorMarker<TSurface = unknown> = <
  TClass extends abstract new (...args: any[]) => TSurface
>(
  value: TClass,
  context?: ClassDecoratorContext<TClass>
) => TClass;

type MethodDecoratorMarker = <This, Value extends AnyMethod>(
  value: Value,
  context: ClassMethodDecoratorContext<This, Value>
) => void | Value;

type LegacyMethodDecoratorMarker = (
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor
) => void;

// Serves `@validateRpc` and the wrapper form `validateRpc(MyApi)`: the class is
// argument 0 either way, and returning it is legal for a class decorator.
export function validateRpc<TClass extends AnyClass = AnyClass>(
  value: TClass,
  context?: ClassDecoratorContext<TClass>
): TClass;
// Wrapper-form equivalent of `@skipRpcValidation()`, which is a method
// decorator and so out of reach for codebases that can't enable decorators.
// The transform reads the array literal, so it must be written inline.
export function validateRpc<TClass extends AnyClass>(
  value: TClass,
  options: { skip: readonly (keyof InstanceType<TClass> & string)[] }
): TClass;
export function validateRpc<TSurface = unknown>(): ClassDecoratorMarker<TSurface>;
export function validateRpc(
  ...args: unknown[]
): void | ClassDecoratorMarker {
  return uncompiledDecoratorMarker(args);
}

export function validateStub<TSurface>(stub: object): ValidatedStub<TSurface>;
export function validateStub(_stub: object): never {
  throw new Error(
    "capnweb-validate validateStub() was called before it was transformed. " +
      "Configure the capnweb-validate bundler plugin or run the capnweb-validate CLI."
  );
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
