// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// This file borrows heavily from `types/defines/rpc.d.ts` in workerd.

// Branded types for identifying `WorkerEntrypoint`/`DurableObject`/`Target`s.
// TypeScript uses *structural* typing meaning anything with the same shape as type `T` is a `T`.
// For the classes exported by `cloudflare:workers` we want *nominal* typing (i.e. we only want to
// accept `WorkerEntrypoint` from `cloudflare:workers`, not any other class with the same shape)
export const __RPC_STUB_BRAND: '__RPC_STUB_BRAND';
export const __RPC_TARGET_BRAND: '__RPC_TARGET_BRAND';
// Distinguishes mapper placeholders from regular values so param unwrapping can accept them.
declare const __RPC_MAP_VALUE_BRAND: unique symbol;
export interface RpcTargetBranded {
  [__RPC_TARGET_BRAND]: never;
}

type IsAny<T> = 0 extends (1 & T) ? true : false;
type IsUnknown<T> = unknown extends T ? ([T] extends [unknown] ? true : false) : false;

// Types that can be used through `Stub`s.
// `never[]` preserves compatibility with strongly-typed function signatures without introducing
// `any` into inference.
export type Stubable = RpcTargetBranded | ((...args: never[]) => unknown);

type TypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigUint64Array
  | BigInt64Array
  | Float32Array
  | Float64Array;

// This represents all the types that can be sent as-is over an RPC boundary
type BaseType =
  | void
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | TypedArray
  | ArrayBuffer
  | DataView
  | Date
  | Error
  | RegExp
  | ReadableStream<Uint8Array>
  | WritableStream<any>  // Chunk type can be any RPC-compatible type
  | Request
  | Response
  | Headers;

// Base type for all RPC stubs, including common memory management methods.
// `T` is used as a marker type for unwrapping `Stub`s later.
interface StubBase<T = unknown> extends Disposable {
  [__RPC_STUB_BRAND]: T;
  dup(): this;
  onRpcBroken(callback: (error: any) => void): void;
}

// Marker carried by map() callback inputs. This lets primitive placeholders flow through params.
interface MapValuePlaceholder<T> {
  [__RPC_MAP_VALUE_BRAND]: T;
}

// Types that can be passed over RPC.
// The reason for using a generic type here is to build a serializable subset of structured
// cloneable composite types. This allows types defined with the "interface" keyword to pass the
// serializable check as well. Otherwise, only types defined with the "type" keyword would pass.
export type RpcCompatible<T> =
  // Allow `unknown` as a leaf so records/interfaces with `unknown` fields remain compatible.
  | (IsUnknown<T> extends true ? unknown : never)
  // Structured cloneables
  | BaseType
  // Structured cloneable composites
  | Map<
      T extends Map<infer U, unknown> ? RpcCompatible<U> : never,
      T extends Map<unknown, infer U> ? RpcCompatible<U> : never
    >
  | Set<T extends Set<infer U> ? RpcCompatible<U> : never>
  | Array<T extends Array<infer U> ? RpcCompatible<U> : never>
  | ReadonlyArray<T extends ReadonlyArray<infer U> ? RpcCompatible<U> : never>
  | {
      [K in keyof T as K extends string | number ? K : never]: RpcCompatible<T[K]>;
    }
  | Promise<T extends Promise<infer U> ? RpcCompatible<U> : never>
  // Special types
  | Stub<Stubable>
  // Serialized as stubs, see `Stubify`
  | Stubable;

export type Stub<T extends RpcCompatible<T>> =
    T extends object ? Provider<T> & StubBase<T> : StubBase<T>;

// Recursively rewrite all `Stubable` types with `Stub`s, and resolve promises.
// prettier-ignore
export type Stubify<T> =
  T extends Stubable ? Stub<T>
  : T extends Promise<infer U> ? Stubify<U>
  : T extends StubBase<any> ? T
  : T extends Map<infer K, infer V> ? Map<Stubify<K>, Stubify<V>>
  : T extends Set<infer V> ? Set<Stubify<V>>
  : T extends [] ? []
  : T extends [infer Head, ...infer Tail] ? [Stubify<Head>, ...Stubify<Tail>]
  : T extends readonly [] ? readonly []
  : T extends readonly [infer Head, ...infer Tail] ? readonly [Stubify<Head>, ...Stubify<Tail>]
  : T extends Array<infer V> ? Array<Stubify<V>>
  : T extends ReadonlyArray<infer V> ? ReadonlyArray<Stubify<V>>
  : T extends BaseType ? T
  // When using "unknown" instead of "any", interfaces are not stubified.
  : T extends { [key: string | number]: any } ? { [K in keyof T as K extends string | number ? K : never]: Stubify<T[K]> }
  : T;

// Recursively rewrite all `Stub<T>`s with the corresponding `T`s.
// Note we use `StubBase` instead of `Stub` here to avoid circular dependencies:
// `Stub` depends on `Provider`, which depends on `Unstubify`, which would depend on `Stub`.
// prettier-ignore
type UnstubifyInner<T> =
  // Preserve local RpcTarget acceptance, but avoid needless `Stub | Value` unions when the stub
  // is already assignable to the value type (important for callback contextual typing).
  T extends StubBase<infer V> ? (T extends V ? UnstubifyInner<V> : (T | UnstubifyInner<V>))
  : T extends Promise<infer U> ? UnstubifyInner<U>
  : T extends Map<infer K, infer V> ? Map<Unstubify<K>, Unstubify<V>>
  : T extends Set<infer V> ? Set<Unstubify<V>>
  : T extends [] ? []
  : T extends [infer Head, ...infer Tail] ? [Unstubify<Head>, ...Unstubify<Tail>]
  : T extends readonly [] ? readonly []
  : T extends readonly [infer Head, ...infer Tail] ? readonly [Unstubify<Head>, ...Unstubify<Tail>]
  : T extends Array<infer V> ? Array<Unstubify<V>>
  : T extends ReadonlyArray<infer V> ? ReadonlyArray<Unstubify<V>>
  : T extends BaseType ? T
  : T extends { [key: string | number]: unknown } ? { [K in keyof T as K extends string | number ? K : never]: Unstubify<T[K]> }
  : T;

// You can put promises anywhere in the params and they'll be resolved before delivery.
// (This also covers RpcPromise, because it's defined as being a Promise.)
// Map placeholders are also allowed so primitive map callback inputs can be forwarded directly
// into RPC params.
type Unstubify<T> =
  | UnstubifyInner<T>
  | Promise<UnstubifyInner<T>>
  | MapValuePlaceholder<UnstubifyInner<T>>;

type UnstubifyAll<A extends readonly unknown[]> = { [I in keyof A]: Unstubify<A[I]> };

// Utility type for adding `Disposable`s to `object` types only.
// Note `unknown & T` is equivalent to `T`.
type MaybeDisposable<T> = T extends object ? Disposable : unknown;

// Type for method return or property on an RPC interface.
// - Stubable types are replaced by stubs.
// - RpcCompatible types are passed by value, with stubable types replaced by stubs
//   and a top-level `Disposer`.
// Everything else can't be passed over RPC.
// Technically, we use custom thenables here, but they quack like `Promise`s.
// Intersecting with `(Maybe)Provider` allows pipelining.
type UnknownResult = Promise<unknown> & Provider<unknown> & StubBase<unknown>;

// prettier-ignore
type Result<R> =
  IsAny<R> extends true ? UnknownResult
  : IsUnknown<R> extends true ? UnknownResult
  : R extends Stubable ? Promise<Stub<R>> & Provider<R> & StubBase<R>
  : R extends RpcCompatible<R> ? Promise<Stubify<R> & MaybeDisposable<R>> & Provider<R> & StubBase<R>
  : never;

// Type for method or property on an RPC interface.
// For methods, unwrap `Stub`s in parameters, and rewrite returns to be `Result`s.
// Unwrapping `Stub`s allows calling with `Stubable` arguments.
// For properties, rewrite types to be `Result`s.
// In each case, unwrap `Promise`s.
type MethodOrProperty<V> = V extends (...args: infer P) => infer R
  ? (...args: UnstubifyAll<P>) => IsAny<R> extends true ? UnknownResult : Result<Awaited<R>>
  : Result<Awaited<V>>;

// Type for the callable part of an `Provider` if `T` is callable.
// This is intersected with methods/properties.
type MaybeCallableProvider<T> = T extends (...args: any[]) => any
  ? MethodOrProperty<T>
  : unknown;

type TupleIndexKeys<T extends ReadonlyArray<unknown>> = Extract<keyof T, `${number}`>;
type MapCallbackValue<T> =
  // `Omit` removes call signatures, so re-intersect callable provider behavior.
  T extends unknown
    ? Omit<Result<T>, keyof Promise<unknown>> &
        MaybeCallableProvider<T> &
        MapValuePlaceholder<T>
    : never;
type InvalidNativePromiseInMapResult<T, Seen = never> =
  T extends unknown ? InvalidNativePromiseInMapResultImpl<T, Seen> : never;
type InvalidNativePromiseInMapResultImpl<T, Seen> =
  [T] extends [Seen] ? never
  // RpcPromise is modeled as Promise & StubBase, so allow promise-like stub values.
  : T extends StubBase<any> ? never
  // Native thenables cannot be represented in map recordings, even when typed as PromiseLike.
  : T extends PromiseLike<unknown> ? T
  : T extends Map<infer K, infer V>
    ? InvalidNativePromiseInMapResult<K, Seen | T> |
        InvalidNativePromiseInMapResult<V, Seen | T>
  : T extends Set<infer V> ? InvalidNativePromiseInMapResult<V, Seen | T>
  : T extends readonly [] ? never
  : T extends readonly [infer Head, ...infer Tail]
    ? InvalidNativePromiseInMapResult<Head, Seen | T> |
        InvalidNativePromiseInMapResult<Tail[number], Seen | T>
  : T extends ReadonlyArray<infer V> ? InvalidNativePromiseInMapResult<V, Seen | T>
  : T extends { [key: string | number]: unknown }
    ? InvalidNativePromiseInMapResult<
        T[Extract<keyof T, string | number>],
        Seen | T
      >
  : never;
type MapCallbackReturn<T> =
  InvalidNativePromiseInMapResult<T> extends never ? T : never;
type ArrayProvider<E> = {
  [K in number]: MethodOrProperty<E>;
} & {
  map<V>(callback: (elem: MapCallbackValue<E>) => MapCallbackReturn<V>): Result<Array<V>>;
};
type TupleProvider<T extends ReadonlyArray<unknown>> = {
  [K in TupleIndexKeys<T>]: MethodOrProperty<T[K]>;
} & ArrayProvider<T[number]>;

// Base type for all other types providing RPC-like interfaces.
// Rewrites all methods/properties to be `MethodOrProperty`s, while preserving callable types.
export type Provider<T> = MaybeCallableProvider<T> &
  (T extends ReadonlyArray<unknown>
    ? number extends T["length"] ? ArrayProvider<T[number]> : TupleProvider<T>
    : {
        [K in Exclude<
          keyof T,
          symbol | keyof StubBase<never>
        >]: MethodOrProperty<T[K]>;
      } & {
        map<V>(
          callback: (value: MapCallbackValue<NonNullable<T>>) => MapCallbackReturn<V>
        ): Result<Array<V>>;
      });
