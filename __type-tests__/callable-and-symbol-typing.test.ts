import { RpcPromise, RpcStub, RpcTarget, type RpcCompatible } from "../src/index.js"
import {
  expectAssignable,
  expectType,
  type Equal,
  type Expect,
  type NonThenable,
} from "./helpers.js"

type GatewayResult = {
  ack: string
  worker: MathWorker
  status: Promise<JobStatus>
}

type SubmitJobInput = {
  id: number
  worker: RpcStub<MathWorker>
  sink: RpcStub<AuditSink>
  deps: Array<RpcStub<MathWorker>>
  meta: {
    attempts: number | Promise<number>
    tags: readonly string[]
  }
}

class MathWorker extends RpcTarget {
  multiply(a: number, b: number): number {
    return a * b
  }

  get id(): number {
    return 0
  }
}

class AuditSink extends RpcTarget {
  write(_entry: string): void {}
}

type JobStatus = {
  total: number
  sink: AuditSink
}

type CallableGateway = {
  (name: string, retries?: number | Promise<number>): Promise<GatewayResult>
  version(): string
  getWorker(id: number): Promise<MathWorker>
  getMaybeWorker(enabled: boolean): Promise<MathWorker | null>
  submitJob(input: SubmitJobInput): Promise<{
    ok: true
    worker: MathWorker
  }>
}

interface NumericApi {
  byId(): Promise<{ [id: number]: MathWorker }>
}

declare const gateway: RpcStub<CallableGateway>
declare const numericApi: RpcStub<NumericApi>

// Compile-time compatibility coverage for callable RPC targets.
type _CallableIsRpcCompatible = Expect<
  CallableGateway extends RpcCompatible<CallableGateway> ? true : false
>

// Positive coverage for callable stubs, nested targets, and pipelined placeholder mapping.
const callResult = gateway("alpha", Promise.resolve(2))
expectType<RpcPromise<GatewayResult>>(callResult)
expectAssignable<Promise<string>>(callResult.ack)
expectAssignable<Promise<number>>(callResult.worker.multiply(2, 3))
expectAssignable<Promise<number>>(callResult.status.total)
expectAssignable<Promise<void>>(callResult.status.sink.write("entry"))

expectAssignable<Promise<string>>(gateway.version())
expectAssignable<Promise<number>>(gateway.getWorker(1).multiply(2, 4))
expectAssignable<Promise<number>>(gateway.getWorker(callResult.worker.id).multiply(3, 5))

const mappedWorker = gateway.getWorker(1).map((worker) => {
  expectType<NonThenable<RpcPromise<MathWorker>>>(worker)
  return worker.multiply(3, 4)
})
expectAssignable<Promise<number>>(mappedWorker[0])

const mappedMaybe = gateway.getMaybeWorker(true).map((worker) => {
  expectType<NonThenable<RpcPromise<MathWorker>>>(worker)
  return worker.multiply(4, 5)
})
expectAssignable<Promise<number>>(mappedMaybe[0])

const localSink = new RpcStub(new AuditSink())
const submitted = gateway.submitJob({
  id: callResult.worker.id,
  worker: gateway.getWorker(11),
  sink: localSink,
  deps: [gateway.getWorker(12), Promise.resolve(new MathWorker())],
  meta: {
    attempts: gateway.getWorker(13).id,
    tags: ["a", "b"] as const,
  },
})
expectAssignable<Promise<{ ok: true; worker: RpcStub<MathWorker> }>>(submitted)

// Awaited checks keep the resolved callable-gateway shapes readable.
async function assertExtraShapes() {
  const done = await gateway.submitJob({
    id: 1,
    worker: new RpcStub(new MathWorker()),
    sink: new RpcStub(new AuditSink()),
    deps: [new RpcStub(new MathWorker())],
    meta: { attempts: Promise.resolve(2), tags: ["x"] },
  })
  expectType<true>(done.ok)
  expectType<RpcStub<MathWorker>>(done.worker)

  const maybeWorker = await gateway.getMaybeWorker(false)
  expectType<RpcStub<MathWorker> | null>(maybeWorker)

  const table = await numericApi.byId()
  expectType<RpcStub<MathWorker> | undefined>(table[1])
}

void assertExtraShapes

declare const secretKey: unique symbol

type SymbolPayload = {
  visible: string
  nested: {
    label: string
    [secretKey]: number
  }
  [secretKey]: Promise<MathWorker>
}

interface SymbolApi {
  roundTrip(payload: SymbolPayload): Promise<SymbolPayload>
}

declare const symbolApi: RpcStub<SymbolApi>

// Symbol-keyed fields are intentionally ignored when RpcCompatible walks object keys.
symbolApi.roundTrip({
  visible: "ok",
  nested: { label: "inner" },
})

async function assertSymbolFiltering() {
  const result = await symbolApi.roundTrip({
    visible: "ok",
    nested: { label: "value" },
  })
  expectType<string>(result.visible)
  expectType<string>(result.nested.label)
}

void assertSymbolFiltering

// Negative checks: these guard the callable and symbol-filtering edges.

// @ts-expect-error callable argument must be string
gateway(123)

// @ts-expect-error wrong retries type
gateway("x", "nope")

const badTagsJob = {
  id: 1,
  worker: new RpcStub(new MathWorker()),
  sink: new RpcStub(new AuditSink()),
  deps: [new RpcStub(new MathWorker())],
  meta: { attempts: 1, tags: [1, 2, 3] },
}
// @ts-expect-error submit tags must be strings
gateway.submitJob(badTagsJob)

// @ts-expect-error byId returns stubs, not plain numbers
const numericTableMismatch: Promise<{ [id: number]: number }> = numericApi.byId()

const badSymbolPayload = {
  visible: 123,
  nested: { label: "inner" },
}
// @ts-expect-error symbol payload visible must be string
symbolApi.roundTrip(badSymbolPayload)

type _SymbolReturnVisible = Awaited<ReturnType<typeof symbolApi.roundTrip>>["visible"]
type _SymbolVisibleType = Expect<Equal<_SymbolReturnVisible, string>>
