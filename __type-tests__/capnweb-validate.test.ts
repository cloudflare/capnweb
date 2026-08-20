import { RpcPromise, RpcTarget, type RpcCompatible } from "../src/index.js"
import { validateStub, type ValidatedStub } from "../packages/capnweb-validate/src/index.js"
import { expectAssignable, expectType, type Equal, type Expect } from "./helpers.js"

class Counter extends RpcTarget {
  increment(by: number): number {
    return by
  }
}

interface Api {
  getCounter(): Promise<Counter>
  sum(values: readonly number[]): Promise<number>
  getPair(): readonly [number, string]
}

type _ValidatedStubCompatible = [
  Expect<ValidatedStub<Api> extends RpcCompatible<ValidatedStub<Api>> ? true : false>,
]

declare const rawStub: object

let api = validateStub<Api>(rawStub)

let counter = api.getCounter()
expectAssignable<Promise<number>>(counter.increment(1))
api.sum([1, 2, 3] as const)

api.getPair().then((pair) => {
  expectType<readonly [number, string]>(pair)
  // @ts-expect-error readonly tuple cannot be assigned to a mutable tuple
  let mutablePair: [number, string] = pair
  void mutablePair
})

// Stub elision mirrors the main package: a `Promise<ValidatedStub<T>>` return for a branded
// target produces the same type as a `Promise<T>` return, while plain-interface stubs keep
// the non-elided shape (they only await back to a stub when NOT elided).
type Formatter = (x: number) => string

interface StubReturningApi {
  viaTarget(): Promise<Counter>
  viaStub(): Promise<ValidatedStub<Counter>>
  viaFn(): Promise<Formatter>
  viaFnStub(): Promise<ValidatedStub<Formatter>>
  getPlain(): Promise<ValidatedStub<Api>>
  getAnyStub(): Promise<ValidatedStub<any>>
  getAny(): Promise<any>
  getUnknown(): Promise<unknown>
  maybeStub(): Promise<ValidatedStub<Counter> | null>
  consumeMaybe(counter: ValidatedStub<Counter> | null): Promise<number>
  dies(): Promise<never>
}

// The brand-leak fix, mirrored: a validated stub of a branded target must not itself look
// branded, or `Stubify` would double-wrap it.
type _NoBrandLeak = Expect<
  Equal<ValidatedStub<Counter> extends { readonly __RPC_TARGET_BRAND: never } ? true : false, false>
>

let stubApi = validateStub<StubReturningApi>(rawStub)

const viaTarget = stubApi.viaTarget()
const viaStub = stubApi.viaStub()
type _ValidatedStubElides = Expect<Equal<typeof viaStub, typeof viaTarget>>
expectAssignable<Promise<number>>(viaStub.increment(2))

// Callable stubs elide too.
const fnViaTarget = stubApi.viaFn()
const fnViaStub = stubApi.viaFnStub()
type _ValidatedCallableStubElides = Expect<Equal<typeof fnViaStub, typeof fnViaTarget>>

// A `never`-returning method stays `never` instead of matching the promise-normalization arm
// with `U = unknown`.
const neverResult = stubApi.dies()
type _NeverStaysNever = Expect<Equal<typeof neverResult, never>>

// Elision distributes over unions, so a `ValidatedStub<T> | null` result still passes as a
// pipelined argument.
const maybe = stubApi.maybeStub()
stubApi.consumeMaybe(maybe)

// Promise-backed stub results normalize: re-declaring a method as returning another method's
// result type produces that same type.
interface ChainApi {
  chain(): typeof viaTarget
}
let chainApi = validateStub<ChainApi>(rawStub)
const chained = chainApi.chain()
type _RpcPromiseNormalizes = Expect<Equal<typeof chained, typeof viaTarget>>

// The RpcPromise constructor applies the same elision to ValidatedStub payloads. This holds
// because ValidatedStub structurally matches capnweb's StubBase, which ElideStub keys on —
// pin it so drift in either package's stub shape can't silently change the constructor's type.
declare const validatedCounter: ValidatedStub<Counter>
const ctorFromValidated = new RpcPromise(Promise.resolve(validatedCounter))
type _CtorElidesValidatedStub = Expect<Equal<typeof ctorFromValidated, RpcPromise<Counter>>>

declare const validatedPlain: ValidatedStub<Api>
const ctorFromValidatedPlain = new RpcPromise(Promise.resolve(validatedPlain))
type _CtorKeepsValidatedPlainStub =
  Expect<Equal<typeof ctorFromValidatedPlain, RpcPromise<ValidatedStub<Api>>>>

const plainStubPromise = stubApi.getPlain()

async function assertValidatedStubShapes() {
  const awaitedCounter = await viaStub
  expectAssignable<Promise<number>>(awaitedCounter.increment(1))

  // Plain-interface stubs keep the wrapper: awaiting still yields the stub itself.
  const inner: ValidatedStub<Api> = await plainStubPromise
  expectAssignable<Promise<number>>(inner.getCounter().increment(1))

  // Union elision: awaiting yields the payload stub or null.
  const maybeCounter = await maybe
  if (maybeCounter !== null) {
    expectAssignable<Promise<number>>(maybeCounter.increment(1))
  } else {
    expectType<null>(maybeCounter)
  }

  // `any` and `unknown` payloads must keep the full stub-result surface: `[any] extends [X]`
  // is true for any `X`, so without the IsAny guards these would collapse to
  // `Promise<unknown> & StubBase<unknown>`.
  const anyStubResult = stubApi.getAnyStub()
  const anyResult = stubApi.getAny()
  expectAssignable<Disposable>(anyStubResult)
  expectAssignable<Disposable>(anyResult)
  expectAssignable<Disposable>(stubApi.getUnknown())
  anyStubResult.dup()
  anyResult.onRpcBroken((_error) => {})
}

void assertValidatedStubShapes

// @ts-expect-error wrong method name
api.missing()
// @ts-expect-error wrong argument type
counter.increment("1")
// @ts-expect-error array elements must be numbers
api.sum(["1"])
// @ts-expect-error pipelined methods keep signatures on elided stub returns
viaStub.increment("2")
