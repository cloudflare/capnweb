// Shared compile-only helpers so each file can focus on the surface it is checking.
export type Equal<Lhs, Rhs> = (<T>() => T extends Lhs ? 1 : 2) extends <T>() => T extends Rhs
  ? 1
  : 2
  ? true
  : false

export type Expect<T extends true> = T
export type IsAny<T> = 0 extends 1 & T ? true : false
export type IsNever<T> = [T] extends [never] ? true : false
export type NonThenable<T> = T extends unknown ? Omit<T, keyof Promise<unknown>> : never

export type BuildTuple<N extends number, A extends 1[] = []> = A["length"] extends N
  ? A
  : BuildTuple<N, [1, ...A]>

export type Dec<N extends number> = BuildTuple<N> extends [1, ...infer Rest extends 1[]]
  ? Rest["length"]
  : never

export function expectType<T>(_value: T): void {}
export function expectAssignable<T>(_value: T): void {}
