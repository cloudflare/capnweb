// Regression tests for generic Unstubify — verifies that generic type parameters
// flow correctly through RpcStub call signatures.
import { RpcStub, RpcTarget } from "../src/index.js"

// ── User's original repro ──────────────────────────────────────────────────────

type DemoEventMap = {
  someEvent1: { someString1: string }
  someEvent2: { someString2: string; someNumber2: number }
}

type DemoEventName = keyof DemoEventMap

type DemoEventWithName<E extends DemoEventName> = {
  name: E
  data: DemoEventMap[E]
}

type DemoEventPayload = {
  name: DemoEventName
  data: DemoEventMap[DemoEventName]
}

export function plainGenericWorks<E extends DemoEventName>(
  name: E,
  data: DemoEventMap[E],
  callback: (event: DemoEventWithName<E>) => void
): void {
  callback({ name, data })
}

export function rpcStubGenericNowWorks<E extends DemoEventName>(
  name: E,
  data: DemoEventMap[E],
  callback: RpcStub<(event: DemoEventWithName<E>) => void>
): void {
  // Previously: E is not assignable to Unstubify<E> in RpcStub callback params
  callback({ name, data })
}

export function rpcStubBroadPayloadWorks(
  name: DemoEventName,
  data: DemoEventMap[DemoEventName],
  callback: RpcStub<(event: DemoEventPayload) => void>
): void {
  callback({ name, data })
}

// ── Generic nested object with branded target ───────────────────────────────────

class Worker extends RpcTarget {
  run(): void {}
}

type Job<T extends string> = {
  id: T
  worker: Worker
  meta: { tags: readonly T[] }
}

export function submitJob<T extends string>(
  stub: RpcStub<(job: Job<T>) => void>,
  job: Job<T>
): void {
  stub(job)
}

// ── Generic tuple / readonly array params ───────────────────────────────────────

export function withPair<A extends string, B extends number>(
  cb: RpcStub<(pair: readonly [A, B]) => void>,
  a: A,
  b: B
): void {
  cb([a, b] as const)
}
