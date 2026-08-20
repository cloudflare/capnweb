// Declared stub returns/properties (`Promise<RpcStub<T>>`, `RpcStub<T>`) must produce the same
// `RpcPromise<T>` as returning the payload directly (`Promise<T>`), matching what
// `new RpcPromise(Promise.resolve(stub))` produces. Plain-interface stubs are the exception:
// they are NOT elided, because `RpcPromise<U>` only awaits back to a stub when `U` is Stubable.
import { RpcPromise, RpcStub, RpcTarget } from "../src/index.js"
import type { Stubable } from "../src/types.js"
import { expectAssignable, expectType, type Equal, type Expect } from "./helpers.js"

class Counter extends RpcTarget {
  increment(by: number): number {
    return by
  }

  get value(): number {
    return 0
  }
}

type Formatter = (x: number) => string

interface PlainApi {
  ping(): number
  echo(name: string): Promise<string>
}

interface ElisionApi {
  viaTarget(): Promise<Counter>
  viaStub(): Promise<RpcStub<Counter>>
  counterProp: RpcStub<Counter>
  viaFn(): Promise<Formatter>
  viaFnStub(): Promise<RpcStub<Formatter>>
  wrapped(): Promise<{ s: RpcStub<Counter> }>
  listStubs(): Promise<RpcStub<Counter>[]>
  consumeCounter(counter: RpcStub<Counter>): Promise<number>
  getApi(): Promise<RpcStub<PlainApi>>
  getAnyStub(): Promise<RpcStub<any>>
  anyStubProp: RpcStub<any>
  maybeStub(): Promise<RpcStub<Counter> | null>
  consumeMaybe(counter: RpcStub<Counter> | null): Promise<number>
}

// Stubs keep the string-keyed brand on their surface (for workers-types interop), so they
// match `Stubable` — harmless, because `Stubify`/`Result` check `StubBase` before `Stubable`.
// That ordering is the actual double-stubification fix; it protects callable stubs too.
type _BrandedStubIsStubable = Expect<Equal<RpcStub<Counter> extends Stubable ? true : false, true>>
type _CallableStubIsStillStubable = Expect<Equal<RpcStub<Formatter> extends Stubable ? true : false, true>>

declare const api: RpcStub<ElisionApi>

// 1. A `Promise<RpcStub<T>>` return is indistinguishable from a `Promise<T>` return.
const viaTarget = api.viaTarget()
const viaStub = api.viaStub()
type _StubReturnMatchesTargetReturn = Expect<Equal<typeof viaStub, typeof viaTarget>>
expectType<RpcPromise<Counter>>(viaStub)

// 2. Both forms can be passed as pipelined RPC arguments (previously TS2345 for viaStub).
api.consumeCounter(viaTarget)
api.consumeCounter(viaStub)

// 3. Awaiting yields a single stub, not a stub-of-stub (previously TS2322).
type _AwaitedViaStub = Expect<Equal<Awaited<typeof viaStub>, RpcStub<Counter>>>

// Pipelining on the elided promise works like any other RpcPromise<Counter>.
expectAssignable<Promise<number>>(viaStub.increment(3))
expectAssignable<Promise<number>>(viaStub.value)
viaStub.onRpcBroken((_error) => {})

// 5. An interface property typed `RpcStub<T>` elides identically.
const propPromise = api.counterProp
type _PropertyElides = Expect<Equal<typeof propPromise, typeof viaTarget>>

// 6. Callable stubs (`RpcStub<(x: number) => string>`) elide too — the second Stubable path.
const fnViaTarget = api.viaFn()
const fnViaStub = api.viaFnStub()
type _CallableStubElides = Expect<Equal<typeof fnViaStub, typeof fnViaTarget>>
type _AwaitedFnStub = Expect<Equal<Awaited<typeof fnViaStub>, RpcStub<Formatter>>>
expectAssignable<Promise<string>>(fnViaStub(4))

// 7. Constructor/method equivalence: wrapping a promised stub yourself produces exactly the
// same type as a method declared to return the stub, for every payload shape.
declare const counterStub: RpcStub<Counter>
const constructed = new RpcPromise(Promise.resolve(counterStub))
type _ConstructorMatchesMethodReturn = Expect<Equal<typeof constructed, typeof viaStub>>

// 7b. Explicitly annotating the payload type still compiles.
const explicit: RpcPromise<Counter> = new RpcPromise<Counter>(Promise.resolve(counterStub))
void explicit

// 7c. Callable stubs elide in the constructor too.
declare const formatterStub: RpcStub<Formatter>
const constructedFn = new RpcPromise(Promise.resolve(formatterStub))
type _CallableCtorMatchesMethodReturn = Expect<Equal<typeof constructedFn, typeof fnViaStub>>

// 7d. Plain-interface stubs are not elided in either form, and the two forms agree.
declare const plainStub: RpcStub<PlainApi>
const constructedPlain = new RpcPromise(Promise.resolve(plainStub))
const plainViaMethod = api.getApi()
type _PlainCtorMatchesMethodReturn = Expect<Equal<typeof constructedPlain, typeof plainViaMethod>>

// 7e. Union payloads distribute identically in both forms.
declare const maybePromise: Promise<RpcStub<Counter> | null>
const constructedMaybe = new RpcPromise(maybePromise)
const maybeViaMethod = api.maybeStub()
type _UnionCtorMatchesMethodReturn = Expect<Equal<typeof constructedMaybe, typeof maybeViaMethod>>
api.consumeMaybe(maybeViaMethod)
api.consumeMaybe(constructedMaybe)

// 8. map() over a declared `RpcStub<T>[]` return: the callback placeholder is `T`-shaped,
// so pipelined calls on elements typecheck.
const mapped = api.listStubs().map((c) => c.increment(2))
expectAssignable<Promise<number[]>>(mapped)

// 9. Self-referential stub returns compile (recursion in `Result` terminates).
declare class Node extends RpcTarget {
  next(): Promise<RpcStub<Node>>
}
declare const nodeStub: RpcStub<Node>
const nextNode = nodeStub.next()
expectType<RpcPromise<Node>>(nextNode)
const grandchild = nextNode.next()
expectType<RpcPromise<Node>>(grandchild)

// 4 & 10. Awaited shapes: stubs nested in object results stay single stubs, and
// plain-interface stubs keep their wrapper (awaiting still yields the stub itself).
async function assertAwaitedShapes() {
  const counter = await viaStub
  expectType<RpcStub<Counter>>(counter)

  const wrapped = await api.wrapped()
  expectType<RpcStub<Counter>>(wrapped.s)
  expectAssignable<Promise<number>>(wrapped.s.increment(1))

  // Plain-interface stubs are not elided: this assignment is today's working behavior and
  // must keep compiling (eliding would make the awaited value a stubified record).
  const s: RpcStub<PlainApi> = await api.getApi()
  expectAssignable<Promise<number>>(s.ping())
  s.dup()

  // `RpcStub<any>` results are not elided either: `[any] extends [Stubable]` is true, so
  // without the IsAny guard these would collapse to `RpcPromise<unknown>` and await to
  // `unknown`, losing the stub surface.
  const anyFromMethod = await api.getAnyStub()
  const anyFromProp = await api.anyStubProp
  expectAssignable<Disposable>(anyFromMethod)
  expectAssignable<Disposable>(anyFromProp)
  anyFromMethod.dup()
  anyFromProp.onRpcBroken((_error) => {})
}

void assertAwaitedShapes

// @ts-expect-error pipelined methods keep their signatures — increment requires a number
viaStub.increment("1")

// @ts-expect-error methods not on Counter are not available on the elided promise
viaStub.missing()
