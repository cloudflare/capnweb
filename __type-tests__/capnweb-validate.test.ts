import { RpcTarget, type RpcCompatible } from "../src/index.js"
import { validateStub, type ValidatedStub } from "../packages/capnweb-validate/src/index.js"
import { expectAssignable, expectType, type Expect } from "./helpers.js"

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

// @ts-expect-error wrong method name
api.missing()
// @ts-expect-error wrong argument type
counter.increment("1")
// @ts-expect-error array elements must be numbers
api.sum(["1"])
