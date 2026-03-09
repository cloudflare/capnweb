import { RpcStub, RpcTarget } from "../src/index.js"
import { expectType, type Equal, type Expect } from "./helpers.js"

class OptionalCallbackServer extends RpcTarget {
  optionalCallback(callback?: RpcStub<(message: string) => void>) {
    callback?.("seed")
  }

  optionalUnionCallback(callback: RpcStub<(message: string) => void> | undefined) {
    callback?.("seed")
  }
}

declare const stub: RpcStub<OptionalCallbackServer>

type OptionalCallbackArg = Parameters<typeof stub.optionalCallback>[0]
type OptionalUnionCallbackArg = Parameters<typeof stub.optionalUnionCallback>[0]

type _OptionalCallbackAllowsPlainFn = Expect<
  Equal<((message: string) => void) extends OptionalCallbackArg ? true : false, true>
>
type _OptionalUnionCallbackAllowsPlainFn = Expect<
  Equal<((message: string) => void) extends OptionalUnionCallbackArg ? true : false, true>
>

stub.optionalCallback((message) => {
  expectType<string>(message)
  message.toUpperCase()
})
stub.optionalCallback(undefined)
stub.optionalUnionCallback((message) => {
  expectType<string>(message)
  message.toUpperCase()
})
stub.optionalUnionCallback(undefined)

// @ts-expect-error optional callback parameter type mismatch
stub.optionalCallback((message: number) => {
  void message
})

// @ts-expect-error optional callback union parameter type mismatch
stub.optionalUnionCallback((message: number) => {
  void message
})
