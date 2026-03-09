/// <reference types="@cloudflare/workers-types" />

import { RpcStub, RpcTarget, type RpcCompatible } from "../src/index-workers.js"
import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget as NativeRpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers"
import { expectAssignable, type Expect } from "./helpers.js"

interface CounterSurface {
  increment(amount?: number): number
  readonly value: number
}

class JsCounter extends RpcTarget implements CounterSurface {
  increment(amount: number = 1): number {
    return amount
  }

  get value(): number {
    return 0
  }
}

class NativeCounter extends NativeRpcTarget implements CounterSurface {
  increment(amount: number = 1): number {
    return amount
  }

  get value(): number {
    return 0
  }
}

class GreeterService extends WorkerEntrypoint {
  greet(name: string): string {
    return `Hello, ${name}!`
  }
}

class TestDo extends DurableObject {
  setValue(_value: string): void {}

  getValue(): string {
    return ""
  }

  subscribe(_callback: (value: string) => void): void {}
}

interface WorkersInteropApi {
  acceptNativeCounter(counter: NativeRpcStub<NativeCounter>): number
  getNativeCounter(): NativeRpcStub<NativeCounter>

  acceptService(service: Fetcher<GreeterService>): string
  getService(): Fetcher<GreeterService>

  acceptDurableObject(stub: DurableObjectStub<TestDo>): string
  getDurableObject(name: string): DurableObjectStub<TestDo>
}

// Workers-specific compatibility coverage: userspace RPC should accept native Workers RPC values.
type _WorkersInteropCompatible = [
  Expect<NativeCounter extends RpcCompatible<NativeCounter> ? true : false>,
  Expect<NativeRpcStub<NativeCounter> extends RpcCompatible<NativeRpcStub<NativeCounter>> ? true : false>,
  Expect<Fetcher<GreeterService> extends RpcCompatible<Fetcher<GreeterService>> ? true : false>,
  Expect<DurableObjectStub<TestDo> extends RpcCompatible<DurableObjectStub<TestDo>> ? true : false>,
]

declare function acceptUserspaceTarget(value: RpcTarget): void
declare function acceptNativeTarget(value: NativeRpcTarget): void

// README promises these RpcTarget classes are interchangeable on Workers.
acceptUserspaceTarget(new NativeCounter())
acceptNativeTarget(new JsCounter())

// Userspace stubs can wrap native Workers RpcTargets and native Workers RpcStubs.
const userspaceFromNativeTarget = new RpcStub(new NativeCounter())
expectAssignable<Promise<number>>(userspaceFromNativeTarget.increment(1))
expectAssignable<Promise<number>>(userspaceFromNativeTarget.value)

const nativeCounterStub = new NativeRpcStub(new NativeCounter())
const userspaceFromNativeStub = new RpcStub(nativeCounterStub)
expectAssignable<Promise<number>>(userspaceFromNativeStub.increment(2))
expectAssignable<Promise<number>>(userspaceFromNativeStub.value)

// Native Workers stubs can be constructed from the userspace RpcTarget alias.
const nativeFromUserspaceTarget = new NativeRpcStub(new JsCounter())
expectAssignable<Promise<number>>(nativeFromUserspaceTarget.increment(1))
expectAssignable<Promise<number>>(nativeFromUserspaceTarget.value)

// Service bindings and Durable Object stubs are Workers-only values that Cap'n Web proxies.
declare const serviceBinding: Fetcher<GreeterService>
const userspaceFromServiceBinding = new RpcStub(serviceBinding)
expectAssignable<Promise<string>>(userspaceFromServiceBinding.greet("World"))

declare const durableObjectStub: DurableObjectStub<TestDo>
const userspaceFromDurableObject = new RpcStub(durableObjectStub)
expectAssignable<Promise<void>>(userspaceFromDurableObject.setValue("ready"))
expectAssignable<Promise<string>>(userspaceFromDurableObject.getValue())
expectAssignable<Promise<void>>(userspaceFromDurableObject.subscribe((_value) => {}))

declare const api: RpcStub<WorkersInteropApi>

// Returned Workers-native values should remain pipelineable through Cap'n Web.
expectAssignable<Promise<number>>(api.acceptNativeCounter(nativeCounterStub))
expectAssignable<Promise<number>>(api.getNativeCounter().increment(3))
expectAssignable<Promise<number>>(api.getNativeCounter().value)

expectAssignable<Promise<string>>(api.acceptService(serviceBinding))
expectAssignable<Promise<string>>(api.getService().greet("Cap'n Web"))

expectAssignable<Promise<string>>(api.acceptDurableObject(durableObjectStub))
const remoteDo = api.getDurableObject("alpha")
expectAssignable<Promise<void>>(remoteDo.setValue("value"))
expectAssignable<Promise<string>>(remoteDo.getValue())
expectAssignable<Promise<void>>(remoteDo.subscribe((_value) => {}))

// Negative guards for the Workers-only surfaces above.

// @ts-expect-error native counter increment must receive number
api.getNativeCounter().increment("bad")

// @ts-expect-error service binding method must receive string
api.getService().greet(123)

// @ts-expect-error durable object setter must receive string
api.getDurableObject("wrong").setValue(123)

// @ts-expect-error durable object callback receives string
api.getDurableObject("wrong").subscribe((value: number) => {})
