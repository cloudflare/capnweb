import {
  RpcPromise,
  RpcSession,
  RpcStub,
  RpcTarget,
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  type RpcCompatible,
  type RpcTransport,
} from "../src/index.js"
import { expectAssignable, expectType, type Equal, type Expect } from "./helpers.js"

type Formatter = (value: number) => Promise<string>

class Counter extends RpcTarget {
  increment(by: number = 1): number {
    return by
  }

  get value(): number {
    return 0
  }
}

class User extends RpcTarget {
  get id(): number {
    return 0
  }

  getName(): string {
    return "user"
  }

  getBestFriend(): Promise<User> {
    return Promise.resolve(this)
  }
}

interface PublicApi {
  ping(): number
  pingAsync(): Promise<number>
  pingVoid(): void
  pingUndefined(): undefined
  echoName(name: string): Promise<string>

  getCounter(seed: number): Counter
  getCounterAsync(seed: number): Promise<Counter>
  getMaybeCounter(seed: number): Promise<Counter | undefined>
  getCounterTable(): Promise<Record<string, Counter>>
  bumpCounter(counter: RpcStub<Counter>, by?: number): Promise<number>
  mergeCounters(counters: Record<string, RpcStub<Counter>>): Promise<number>
  invokeFormatter(formatter: RpcStub<Formatter>, value: number): Promise<string>

  getUser(userId: number): Promise<User>
  getMaybeUser(userId: number): Promise<User | null>
  listUsers(): Promise<User[]>
  sum(values: readonly number[]): Promise<number>
  acceptStreams(readable: ReadableStream<Uint8Array>, writable: WritableStream<any>): Promise<void>

  getPair(): readonly [Counter, Counter]
  getNested(): Promise<{
    owner: User
    members: User[]
    mainCounter: Counter
  }>
}

// Compile-time compatibility coverage for the main RPC surface.
type _RpcCompatibleChecks = [
  Expect<Counter extends RpcCompatible<Counter> ? true : false>,
  Expect<User extends RpcCompatible<User> ? true : false>,
  Expect<Equal<number extends RpcCompatible<number> ? true : false, true>>,
  Expect<Date extends RpcCompatible<Date> ? true : false>,
  Expect<Record<string, Counter> extends RpcCompatible<Record<string, Counter>> ? true : false>,
  Expect<
    { owner: User; mainCounter: Counter } extends RpcCompatible<{
      owner: User
      mainCounter: Counter
    }>
      ? true
      : false
  >
]

declare const api: RpcStub<PublicApi>
declare const transport: RpcTransport
declare const localCounter: Counter
declare const counterStub: RpcStub<Counter>
declare const counterPromise: RpcPromise<Counter>
declare const counterTable: Record<string, Counter | RpcStub<Counter>>
declare const byteReadable: ReadableStream<Uint8Array>
declare const genericWritable: WritableStream<any>
declare const textReadable: ReadableStream<string>
declare const namePromise: RpcPromise<string>
declare const stepPromise: RpcPromise<number>
declare const counterTablePromise: RpcPromise<Record<string, Counter>>

// Session constructors and transport helpers should all produce the same RpcStub surface.
const localStub = new RpcStub(new Counter())
expectType<RpcStub<Counter>>(localStub)

const session = new RpcSession<PublicApi>(transport)
expectType<RpcStub<PublicApi>>(session.getRemoteMain())

const wsApi = newWebSocketRpcSession<PublicApi>("wss://example.com/rpc")
const batchApi = newHttpBatchRpcSession<PublicApi>("https://example.com/rpc")
expectType<RpcStub<PublicApi>>(wsApi)
expectType<RpcStub<PublicApi>>(batchApi)

// Positive coverage for direct calls, pipelining, and accepted promise-like arguments.
const ping = api.ping()
expectAssignable<Promise<number>>(ping)
expectType<RpcPromise<number>>(ping)

const pingAsync = api.pingAsync()
expectAssignable<Promise<number>>(pingAsync)
expectType<RpcPromise<number>>(pingAsync)

const pingVoid = api.pingVoid()
expectAssignable<Promise<void>>(pingVoid)
expectType<RpcPromise<void>>(pingVoid)

const pingUndefined = api.pingUndefined()
expectAssignable<Promise<undefined>>(pingUndefined)
expectType<RpcPromise<undefined>>(pingUndefined)

const users = api.listUsers()
const userNames = users.map((user) => user.getName())
expectAssignable<Promise<string>>(userNames[0])

const directCounter = api.getCounter(10)
const asyncCounter = api.getCounterAsync(11)
expectAssignable<Promise<number>>(directCounter.increment(2))
expectAssignable<Promise<number>>(asyncCounter.increment(3))
expectAssignable<Promise<number>>(directCounter.value)
expectAssignable<Promise<number>>(asyncCounter.value)

api.echoName("alice")
api.echoName(namePromise)

api.bumpCounter(localCounter, 2)
api.bumpCounter(counterStub, stepPromise)
api.bumpCounter(counterPromise, 4)

api.mergeCounters(counterTable)
api.mergeCounters(counterTablePromise)

api.sum([1, 2, 3] as const)

api.acceptStreams(byteReadable, genericWritable)

api.invokeFormatter(async (value: number) => `${value}`, 5)
api.invokeFormatter(new RpcStub(async (value: number) => `${value}`), 6)

// Awaited checks make the post-Unstubify return shapes explicit.
type _AwaitedGetUser = Awaited<ReturnType<typeof api.getUser>>
type _AwaitedGetMaybeCounter = Awaited<ReturnType<typeof api.getMaybeCounter>>
type _AwaitedGetCounterTable = Awaited<ReturnType<typeof api.getCounterTable>>
type _AwaitedListUsers = Awaited<ReturnType<typeof api.listUsers>>
type _AwaitedGetPair = Awaited<ReturnType<typeof api.getPair>>
type _AwaitedGetNested = Awaited<ReturnType<typeof api.getNested>>

type _GetUserIsStub = Expect<Equal<_AwaitedGetUser, RpcStub<User>>>
type _GetMaybeCounterIsStubified = Expect<
  Equal<_AwaitedGetMaybeCounter, RpcStub<Counter> | undefined>
>
type _CounterTableValueIsStubified = Expect<
  Equal<
    _AwaitedGetCounterTable extends Record<string, infer Value> ? Value : never,
    RpcStub<Counter>
  >
>
type _ListUsersValueIsStubified = Expect<
  Equal<_AwaitedListUsers[number], RpcStub<User>>
>
type _PairTupleElementsAreStubified = [
  Expect<Equal<_AwaitedGetPair[0], RpcStub<Counter>>>,
  Expect<Equal<_AwaitedGetPair[1], RpcStub<Counter>>>
]
type _NestedObjectIsStubified = [
  Expect<Equal<_AwaitedGetNested["owner"], RpcStub<User>>>,
  Expect<Equal<_AwaitedGetNested["members"][number], RpcStub<User>>>,
  Expect<Equal<_AwaitedGetNested["mainCounter"], RpcStub<Counter>>>
]

async function assertAwaitedShapes() {
  const pingVoidResult = await api.pingVoid()
  const pingUndefinedResult = await api.pingUndefined()
  expectType<void>(pingVoidResult)
  expectType<undefined>(pingUndefinedResult)

  const fromSync = await api.getCounter(1)
  const fromAsync = await api.getCounterAsync(1)
  const maybeCounter = await api.getMaybeCounter(2)
  expectType<RpcStub<Counter>>(fromSync)
  expectType<RpcStub<Counter>>(fromAsync)
  expectType<RpcStub<Counter> | undefined>(maybeCounter)

  const counterTableResult = await api.getCounterTable()
  expectType<RpcStub<Counter>>(counterTableResult.primary)

  const [left, right] = await api.getPair()
  expectType<RpcStub<Counter>>(left)
  expectType<RpcStub<Counter>>(right)

  const nested = await api.getNested()
  expectType<RpcStub<User>>(nested.owner)
  expectType<RpcStub<User>>(nested.members[0])
  expectType<RpcStub<Counter>>(nested.mainCounter)

  const users = await api.listUsers()
  expectType<RpcStub<User>>(users[0])

  const sumResult = await api.sum([10, 11, 12])
  const mergeResult = await api.mergeCounters(counterTable)
  const streamResult = await api.acceptStreams(byteReadable, genericWritable)
  expectType<number>(sumResult)
  expectType<number>(mergeResult)
  expectType<void>(streamResult)
}

void assertAwaitedShapes

declare const formatterStub: RpcStub<Formatter>
expectAssignable<Promise<string>>(formatterStub(1))

// Negative checks (must fail type-checking).

// @ts-expect-error wrong method name
api.notAMethod()

// @ts-expect-error wrong argument type
api.getCounter("1")

// @ts-expect-error wrong argument type in pipelined call
api.getCounter(1).increment("nope")

// @ts-expect-error property does not exist
api.getCounter(1).missingProp

// @ts-expect-error formatter argument type mismatch
api.invokeFormatter((value: string) => Promise.resolve(value), 1)

// @ts-expect-error formatter return type mismatch
api.invokeFormatter((value: number) => value, 1)

// @ts-expect-error RpcTarget brand is required when passing by reference
api.bumpCounter({ increment: () => 1, value: 1 }, 1)

// @ts-expect-error wrong primitive argument type
api.echoName(123)

// @ts-expect-error counter table must be a plain record
api.mergeCounters(new Map([[1, localCounter]]))

// @ts-expect-error sum values must be numbers
api.sum(["1", "2"])

// @ts-expect-error readable stream chunk type must be Uint8Array
api.acceptStreams(textReadable, genericWritable)

// @ts-expect-error writable argument must be a WritableStream
api.acceptStreams(byteReadable, new Uint8Array())

// @ts-expect-error RpcPromise is not a plain number
const shouldBeErrorNumber: number = api.ping()

// @ts-expect-error RpcPromise<number> is not Promise<string>
const shouldBeErrorStringPromise: Promise<string> = api.ping()

// @ts-expect-error transport must implement RpcTransport
new RpcSession<PublicApi>({})
