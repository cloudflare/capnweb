import { RpcStub, RpcTarget } from "../src/index.js"
import { expectAssignable, expectType, type Expect } from "./helpers.js"

type Summary = { summary: string; size: number }
type Envelope = {
  id: string
  createdAt: Date
  bytes: Uint8Array
  meta: {
    source: "edge" | "origin"
    attempts: number
    tags: readonly string[]
  }
  checkpoint: readonly [at: number, checksum: bigint]
}

type JobCommand =
  | { kind: "push"; taskId: string; payload: Envelope }
  | { kind: "cancel"; taskId: string; reason?: string }
  | { kind: "flush"; force: boolean }

type Ack = { ok: true; taskId: string; at: Date } | { ok: false; taskId: string; error: Error }

type EnvelopeCallback = (input: Envelope) => void
type EnvelopeAsyncCallback = (input: Envelope) => Promise<Summary>
type CommandCallback = (command: JobCommand) => Ack | Promise<Ack>
type TopicCallback = (topic: string, priority?: number, ...labels: string[]) => void
type TupleValue = readonly [id: string, at: Date, bytes: Uint8Array]
type TupleResult = readonly [string, number]
type TupleCallback = (pair: TupleValue) => Promise<TupleResult>
type AckHandler = (command: JobCommand) => Promise<Ack>
type NestedAckBatchCallback = (
  next: RpcStub<AckHandler>,
  batch: readonly JobCommand[]
) => Promise<readonly Ack[]>
type HandlerMap = Map<string, RpcStub<AckHandler>>
type RecordLookup = Record<string, { audit: RpcStub<AuditTarget>; ack: Ack }>
type RecordStatusMap = Record<string, { status: "ok" | "bad"; when: Date }>

class AuditTarget extends RpcTarget {
  record(_event: string): void {}
}

class AdvancedCallbackServer extends RpcTarget {
  withEnvelope(callback: RpcStub<EnvelopeCallback>) {
    callback({
      id: "seed",
      createdAt: new Date(0),
      bytes: new Uint8Array([1, 2, 3]),
      meta: { source: "edge", attempts: 1, tags: ["core"] },
      checkpoint: [0, 0n],
    })
  }

  withEnvelopeAsync(callback: RpcStub<EnvelopeAsyncCallback>) {
    return callback({
      id: "seed",
      createdAt: new Date(0),
      bytes: new Uint8Array([1, 2, 3]),
      meta: { source: "origin", attempts: 2, tags: ["edge", "worker"] },
      checkpoint: [1, 9n],
    })
  }

  withCommand(callback: RpcStub<CommandCallback>) {
    return callback({ kind: "flush", force: true })
  }

  withOptionalAndRest(callback: RpcStub<TopicCallback>) {
    callback("jobs", 1, "alpha", "beta")
  }

  withTuple(callback: RpcStub<TupleCallback>) {
    return callback(["id-1", new Date(0), new Uint8Array([4, 5])] as const)
  }

  withNestedCallback(callback: RpcStub<NestedAckBatchCallback>) {
    return callback(async (command: JobCommand): Promise<Ack> => {
      if (command.kind === "flush") {
        return { ok: true, taskId: "flush", at: new Date(0) }
      }
      return { ok: false, taskId: command.taskId, error: new Error("not-implemented") }
    }, [])
  }

  withMap(callback: RpcStub<(handlers: HandlerMap) => Promise<number>>) {
    return callback(new Map())
  }

  withSet(callback: RpcStub<(items: Set<readonly [string, number]>) => Promise<Set<string>>>) {
    return callback(new Set([["a", 1] as const]))
  }

  withRecord(callback: RpcStub<(lookup: RecordLookup) => Promise<RecordStatusMap>>) {
    return callback({
      one: {
        audit: new RpcStub(new AuditTarget()),
        ack: { ok: true, taskId: "one", at: new Date(0) },
      },
    })
  }
}

declare const stub: RpcStub<AdvancedCallbackServer>
declare const ackHandlerStub: RpcStub<AckHandler>

// Static checks for the higher-order callback entrypoints.
type WithEnvelopeArg = Parameters<typeof stub.withEnvelope>[0]
type WithOptionalAndRestArg = Parameters<typeof stub.withOptionalAndRest>[0]

type _WithEnvelopeAcceptsPlainFn = Expect<
  ((input: Envelope) => void) extends WithEnvelopeArg ? true : false
>
type _WithEnvelopeAcceptsPromiseWrappedFn = Expect<
  Promise<(input: Envelope) => void> extends WithEnvelopeArg ? true : false
>
type _WithOptionalAndRestAcceptsPlainFn = Expect<
  ((topic: string, priority?: number, ...labels: string[]) => void) extends WithOptionalAndRestArg
    ? true
    : false
>

// Positive coverage for nested callback shapes and structured container types.
stub.withEnvelope((input: Envelope) => {
  expectType<"edge" | "origin">(input.meta.source)
  expectType<readonly [number, bigint]>(input.checkpoint)
  expectType<readonly string[]>(input.meta.tags)
})
stub.withEnvelope(
  Promise.resolve((input: Envelope) => {
    input.bytes.byteLength
  })
)

stub.withEnvelopeAsync(async (input: Envelope) => {
  return { summary: input.id, size: input.bytes.byteLength }
})

stub.withCommand((command: JobCommand): Ack => {
  if (command.kind === "push") {
    expectType<Envelope>(command.payload)
    return { ok: true, taskId: command.taskId, at: new Date(0) }
  }
  if (command.kind === "cancel") {
    return { ok: false, taskId: command.taskId, error: new Error(command.reason) }
  }
  return { ok: true, taskId: "flush", at: new Date(0) }
})
stub.withCommand(
  Promise.resolve((command: JobCommand) => {
    if (command.kind === "flush") {
      return Promise.resolve({ ok: true, taskId: "flush", at: new Date(0) } as const)
    }
    return Promise.resolve({ ok: false, taskId: command.taskId, error: new Error("x") } as const)
  })
)

stub.withOptionalAndRest((topic: string, priority = 0, ...labels: string[]) => {
  expectType<string>(topic)
  expectType<number>(priority)
  expectType<string[]>(labels)
})

stub.withTuple(async (pair: readonly [string, Date, Uint8Array]) => {
  expectType<Date>(pair[1])
  return [pair[0], pair[2].byteLength] as const
})
stub.withTuple(
  Promise.resolve(async (pair: readonly [string, Date, Uint8Array]) => {
    return [pair[0], pair[2].byteLength] as const
  })
)

stub.withNestedCallback(async (next: RpcStub<AckHandler>, batch: readonly JobCommand[]) => {
  expectType<readonly JobCommand[]>(batch)
  const first = await next({ kind: "flush", force: false })
  expectType<Ack>(first)
  return [first]
})
stub.withNestedCallback(
  Promise.resolve(async (next: RpcStub<AckHandler>) => {
    const ack = await next({ kind: "cancel", taskId: "id-2" })
    return [ack] as const
  })
)

stub.withMap(async (handlers: HandlerMap) => {
  const handler = handlers.get("default")
  if (handler) {
    const ack = await handler({ kind: "flush", force: true })
    expectType<Ack>(ack)
  }
  return handlers.size
})
stub.withMap(
  Promise.resolve(async (handlers: HandlerMap) => {
    void handlers
    return 0
  })
)

stub.withSet(async (items: Set<readonly [string, number]>) => {
  const out = new Set<string>()
  for (const [name, count] of items) {
    out.add(`${name}:${count}`)
  }
  return out
})
stub.withSet(
  Promise.resolve(async (items: Set<readonly [string, number]>) => {
    void items
    return new Set<string>(["ok"])
  })
)

stub.withRecord(async (lookup: RecordLookup) => {
  const out: RecordStatusMap = {}
  for (const key of Object.keys(lookup)) {
    const entry = lookup[key]
    expectAssignable<Promise<void>>(entry.audit.record(key))
    out[key] = {
      status: entry.ack.ok ? "ok" : "bad",
      when: new Date(0),
    }
  }
  return out
})
stub.withRecord(
  Promise.resolve(async (lookup: RecordLookup) => {
    void lookup
    return {
      one: { status: "ok", when: new Date(0) },
    }
  })
)

// Keep awaited shape checks together so the resolved container types stay readable.
async function assertReturnShapes() {
  const envelopeResult = await stub.withEnvelopeAsync(async (input: Envelope) => {
    return { summary: input.id, size: input.bytes.byteLength }
  })
  expectType<string>(envelopeResult.summary)
  expectType<number>(envelopeResult.size)

  const tupleResult = await stub.withTuple(async (pair: readonly [string, Date, Uint8Array]) => {
    return [pair[0], pair[2].byteLength] as const
  })
  expectAssignable<readonly [string | number, ...unknown[]]>(tupleResult)
  expectType<string | number>(tupleResult[0])

  const ack = await stub.withCommand(ackHandlerStub)
  expectType<Ack>(ack)
}

void assertReturnShapes

// Inline callbacks should inherit types from the surrounding RpcStub signature.
stub.withEnvelope((input) => {
  expectType<Envelope>(input)
  input.meta.source
})

stub.withOptionalAndRest((topic, priority, ...labels) => {
  expectType<string>(topic)
  expectType<number | undefined>(priority)
  expectType<string[]>(labels)
  topic.toUpperCase()
  priority?.toFixed()
  labels.join(",")
})

// Negative checks: these cases guard the callback inference boundaries.
// @ts-expect-error wrong envelope shape
stub.withEnvelope((input: { id: number }) => {
  console.log(input)
})

// @ts-expect-error wrong command callback return shape
stub.withCommand((command: JobCommand) => {
  void command
  return { ok: "yes", taskId: "x", at: new Date(0) }
})

// @ts-expect-error wrong topic type
stub.withOptionalAndRest((topic: number, priority?: number, ...labels: string[]) => {
  console.log(topic, priority, labels)
})

// @ts-expect-error wrong rest element type
stub.withOptionalAndRest((topic: string, priority?: number, ...labels: number[]) => {
  console.log(topic, priority, labels)
})

// @ts-expect-error wrong tuple element type
stub.withTuple(async (pair: readonly [string, string, Uint8Array]) => {
  return [pair[0], pair[2].byteLength] as const
})

// @ts-expect-error wrong nested callback argument type
stub.withNestedCallback(async (next: RpcStub<(command: string) => Promise<Ack>>) => {
  const result = await next("bad")
  return [result]
})

// @ts-expect-error wrong map handler value type
stub.withMap(async (handlers: Map<string, RpcStub<(command: string) => Promise<Ack>>>) => {
  void handlers
  return 0
})

// @ts-expect-error wrong set item type
stub.withSet(async (items: Set<readonly [number, number]>) => {
  void items
  return new Set<string>()
})

// @ts-expect-error wrong record callback return shape
stub.withRecord(async () => {
  return {
    one: { status: "invalid", when: new Date(0) },
  }
})
