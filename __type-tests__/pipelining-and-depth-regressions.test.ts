import { RpcPromise, RpcStub, RpcTarget, type RpcCompatible } from "../src/index.js"
import {
  expectAssignable,
  expectType,
  type Dec,
  type Equal,
  type Expect,
  type IsAny,
  type IsNever,
  type NonThenable,
} from "./helpers.js"

type PostData = { owner: User; post: Post; title: string }
type UnknownRecord = Record<string, unknown>

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

class Post extends RpcTarget {
  getData(_id: number): Promise<PostData> {
    return Promise.resolve({
      owner: new User(),
      post: this,
      title: "post",
    })
  }
}

class Api extends RpcTarget {
  post(): Promise<Post> {
    return Promise.resolve(new Post())
  }

  listPosts(): Promise<Post[]> {
    return Promise.resolve([new Post()])
  }
}

interface RootApi {
  api(): Promise<Api>
  getId(): Promise<number>
  nested(): Promise<{
    api: Api
    post: Promise<Post>
    meta: {
      owner: User
      ownerPromise: Promise<User>
    }
  }>
}

declare const stub: RpcStub<RootApi>

// Pipelining should preserve stubified access across chained methods, args, and map placeholders.
const nestedPipelined = stub.api().post().getData(123)
expectType<RpcPromise<PostData>>(nestedPipelined)
expectAssignable<Promise<{ owner: RpcStub<User>; post: RpcStub<Post>; title: string }>>(
  nestedPipelined
)

const idPromise = stub.getId()
const nestedWithPipelinedArg = stub.api().post().getData(idPromise)
expectAssignable<Promise<{ owner: RpcStub<User>; post: RpcStub<Post>; title: string }>>(
  nestedWithPipelinedArg
)

const nestedChain = stub.api().post().getData(stub.getId()).owner.getBestFriend().getName()
expectAssignable<Promise<string>>(nestedChain)

const mapped = stub
  .api()
  .listPosts()
  .map((post) => {
    expectType<NonThenable<RpcPromise<Post>>>(post)
    return post.getData(1).owner.getName()
  })
expectAssignable<Promise<string>>(mapped[0])

// Keep awaited checks together so the resolved pipelined shape stays easy to read.
async function assertPipelinedAndAwaitedShapes() {
  const nonPipelinedApi = await stub.api()
  const nonPipelinedPost = await nonPipelinedApi.post()
  const nonPipelinedData = await nonPipelinedPost.getData(7)
  expectType<RpcStub<User>>(nonPipelinedData.owner)
  expectType<RpcStub<Post>>(nonPipelinedData.post)
  expectType<string>(nonPipelinedData.title)

  const pipelinedData = await stub.api().post().getData(stub.getId())
  expectType<RpcStub<User>>(pipelinedData.owner)
  expectType<RpcStub<Post>>(pipelinedData.post)
  expectType<string>(pipelinedData.title)

  const nested = await stub.nested()
  expectType<RpcStub<Api>>(nested.api)
  expectType<RpcStub<Post>>(nested.post)
  expectType<RpcStub<User>>(nested.meta.owner)
  expectType<RpcStub<User>>(nested.meta.ownerPromise)
}

void assertPipelinedAndAwaitedShapes

// Generic and `any` fallbacks should degrade to `unknown`, never to `any`.
interface GenericApi {
  id<T>(value: T): Promise<T>
}

declare const genericApi: RpcStub<GenericApi>

const genericResult = genericApi.id(123)
expectAssignable<Promise<unknown>>(genericResult)
type GenericAwaited = Awaited<typeof genericResult>
type _GenericResultNotAny = Expect<Equal<IsAny<GenericAwaited>, false>>
type _GenericResultUnknown = Expect<Equal<GenericAwaited, unknown>>

interface AnyFallbackApi {
  parse(input: string): any
  version(): any
  mix(value: any, count: number): any
}

declare const anyFallbackApi: RpcStub<AnyFallbackApi>

const parseResult = anyFallbackApi.parse("ok")
expectAssignable<Promise<unknown>>(parseResult)
type ParseAwaited = Awaited<typeof parseResult>
type _ParseResultNotAny = Expect<Equal<IsAny<ParseAwaited>, false>>
type _ParseResultUnknown = Expect<Equal<ParseAwaited, unknown>>

anyFallbackApi.version()
anyFallbackApi.mix("x", Promise.resolve(2))

interface AnyParamTypedReturnApi {
  parse(input: any): number
}

declare const anyParamTypedReturnApi: RpcStub<AnyParamTypedReturnApi>

const typedAnyParamResult = anyParamTypedReturnApi.parse("ok")
expectType<RpcPromise<number>>(typedAnyParamResult)
type TypedAnyParamAwaited = Awaited<typeof typedAnyParamResult>
type _TypedAnyParamResultNumber = Expect<Equal<TypedAnyParamAwaited, number>>

interface UnknownInferenceApi {
  getUnknown(): unknown
  getUnknownObject(): UnknownRecord
  getNestedUnknownObject(): Promise<{
    payload: {
      meta: UnknownRecord
    }
  }>
  echoUnknownObject(input: UnknownRecord): UnknownRecord
}

declare const unknownInferenceApi: RpcStub<UnknownInferenceApi>

type _UnknownIsRpcCompatible = Expect<unknown extends RpcCompatible<unknown> ? true : false>
type _UnknownRecordIsRpcCompatible = Expect<
  UnknownRecord extends RpcCompatible<UnknownRecord> ? true : false
>

const unknownValueResult = unknownInferenceApi.getUnknown()
expectAssignable<Promise<unknown>>(unknownValueResult)
type UnknownValueResultNever = IsNever<typeof unknownValueResult>
type _UnknownValueResultNotNever = Expect<Equal<UnknownValueResultNever, false>>
type UnknownValueAwaited = Awaited<typeof unknownValueResult>
type _UnknownValueAwaitedNotAny = Expect<Equal<IsAny<UnknownValueAwaited>, false>>
type _UnknownValueAwaitedUnknown = Expect<Equal<UnknownValueAwaited, unknown>>

const unknownObjectResult = unknownInferenceApi.getUnknownObject()
expectAssignable<Promise<UnknownRecord>>(unknownObjectResult)
type UnknownObjectResultNever = IsNever<typeof unknownObjectResult>
type _UnknownObjectResultNotNever = Expect<Equal<UnknownObjectResultNever, false>>

const nestedUnknownObjectResult = unknownInferenceApi.getNestedUnknownObject()
expectAssignable<Promise<{ payload: { meta: UnknownRecord } }>>(nestedUnknownObjectResult)
type NestedUnknownObjectResultNever = IsNever<typeof nestedUnknownObjectResult>
type _NestedUnknownObjectResultNotNever = Expect<Equal<NestedUnknownObjectResultNever, false>>

unknownInferenceApi.echoUnknownObject({ id: "abc", count: 1, extra: { enabled: true } })
unknownInferenceApi.echoUnknownObject(Promise.resolve({ id: "abc" }))

class UnknownInferenceTarget extends RpcTarget {
  hello() {
    return "world"
  }

  giveMeUnknownObject(): UnknownRecord {
    return {
      name: "Alice",
      age: 30,
    }
  }
}

declare const unknownInferenceTarget: RpcStub<UnknownInferenceTarget>

const classUnknownObjectResult = unknownInferenceTarget.giveMeUnknownObject()
expectAssignable<Promise<UnknownRecord>>(classUnknownObjectResult)
type ClassUnknownObjectResultNever = IsNever<typeof classUnknownObjectResult>
type _ClassUnknownObjectResultNotNever = Expect<Equal<ClassUnknownObjectResultNever, false>>

interface UnknownEdgeCaseApi {
  roundTripUnknownArray(value: UnknownRecord[]): UnknownRecord[]
  roundTripUnknownMap(value: Map<string, UnknownRecord>): Map<string, UnknownRecord>
  roundTripUnknownPromise(value: Promise<UnknownRecord>): Promise<UnknownRecord>
  roundTripUnknownNullable(value: UnknownRecord | null): UnknownRecord | null
  roundTripUnknownNestedPromise(value: { payload: Promise<UnknownRecord> }): {
    payload: Promise<UnknownRecord>
  }
}

declare const unknownEdgeCaseApi: RpcStub<UnknownEdgeCaseApi>

type _UnknownArrayCompatible = Expect<
  UnknownRecord[] extends RpcCompatible<UnknownRecord[]> ? true : false
>
type _UnknownMapCompatible = Expect<
  Map<string, UnknownRecord> extends RpcCompatible<Map<string, UnknownRecord>> ? true : false
>
type _UnknownPromiseCompatible = Expect<
  Promise<UnknownRecord> extends RpcCompatible<Promise<UnknownRecord>> ? true : false
>

const unknownArrayResult = unknownEdgeCaseApi.roundTripUnknownArray([{ id: "x" }, { active: true }])
expectAssignable<Promise<UnknownRecord[]>>(unknownArrayResult)
type UnknownArrayResultNever = IsNever<typeof unknownArrayResult>
type _UnknownArrayResultNotNever = Expect<Equal<UnknownArrayResultNever, false>>

const unknownMapResult = unknownEdgeCaseApi.roundTripUnknownMap(new Map([["first", { id: "x" }]]))
expectAssignable<Promise<Map<string, UnknownRecord>>>(unknownMapResult)
type UnknownMapResultNever = IsNever<typeof unknownMapResult>
type _UnknownMapResultNotNever = Expect<Equal<UnknownMapResultNever, false>>

const unknownNullableResult = unknownEdgeCaseApi.roundTripUnknownNullable(
  Math.random() > 0.5 ? { id: "x" } : null
)
expectAssignable<Promise<UnknownRecord | null>>(unknownNullableResult)
type UnknownNullableResultNever = IsNever<typeof unknownNullableResult>
type _UnknownNullableResultNotNever = Expect<Equal<UnknownNullableResultNever, false>>

unknownEdgeCaseApi.roundTripUnknownPromise(Promise.resolve({ id: "x", count: 1 }))
unknownEdgeCaseApi.roundTripUnknownNestedPromise({
  payload: Promise.resolve({ id: "x", extra: { enabled: true } }),
})

async function assertUnknownInferenceShapes() {
  const unknownValue = await unknownInferenceApi.getUnknown()
  const unknownObject = await unknownInferenceApi.getUnknownObject()
  const nestedUnknownObject = await unknownInferenceApi.getNestedUnknownObject()
  const roundTrippedUnknownObject = await unknownInferenceApi.echoUnknownObject({ id: "rpc" })
  const classUnknownObject = await unknownInferenceTarget.giveMeUnknownObject()
  const unknownArray = await unknownEdgeCaseApi.roundTripUnknownArray([{ id: "arr" }])
  const unknownMap = await unknownEdgeCaseApi.roundTripUnknownMap(
    new Map([["primary", { id: "map" }]])
  )
  const unknownNullable = await unknownEdgeCaseApi.roundTripUnknownNullable(null)
  const unknownNestedPromise = await unknownEdgeCaseApi.roundTripUnknownNestedPromise({
    payload: Promise.resolve({ id: "nested" }),
  })

  expectType<unknown>(unknownValue)
  expectType<UnknownRecord>(unknownObject)
  expectType<UnknownRecord>(nestedUnknownObject.payload.meta)
  expectType<UnknownRecord>(roundTrippedUnknownObject)
  expectType<UnknownRecord>(classUnknownObject)
  expectType<UnknownRecord[]>(unknownArray)
  expectType<UnknownRecord | undefined>(unknownMap.get("primary"))
  expectType<UnknownRecord | null>(unknownNullable)
  expectType<UnknownRecord>(unknownNestedPromise.payload)
}

void assertUnknownInferenceShapes

// This is purely a compile-depth regression guard for recursive transforms.
type DeepNode<N extends number> = N extends 0
  ? {
      done: true
      owner: User
    }
  : {
      depth: N
      next: Promise<DeepNode<Dec<N>>>
      owner: Promise<User>
      post: Post
    }

interface DeepApi {
  walk(input: DeepNode<40>): Promise<DeepNode<40>>
}

declare const deepApi: RpcStub<DeepApi>
declare const deepNode: DeepNode<40>

const deepResult = deepApi.walk(deepNode)

type DeepParam = Parameters<typeof deepApi.walk>[0]
type DeepAwaited = Awaited<typeof deepResult>
type _DeepParamNotAny = Expect<Equal<IsAny<DeepParam>, false>>
type _DeepAwaitedNotAny = Expect<Equal<IsAny<DeepAwaited>, false>>

// Negative checks: these guard the known failure boundaries.

// @ts-expect-error nested pipelined ID must be number-like
stub.api().post().getData("bad-id")

// @ts-expect-error result has no missingProp
stub.api().post().getData(1).missingProp

// @ts-expect-error generic fallback should not be any
const genericShouldNotBeAny: number = genericApi.id("x")

// @ts-expect-error any-return fallback should preserve method parameter types
anyFallbackApi.parse(123)

// @ts-expect-error any-return fallback should preserve arity
anyFallbackApi.parse("ok", 1)

// @ts-expect-error zero-arg any-return method should reject extra args
anyFallbackApi.version("extra")

// @ts-expect-error later parameters should stay typed even if earlier args include any
anyFallbackApi.mix("x", "bad")

// @ts-expect-error required params should stay required
anyFallbackApi.mix("x")

// @ts-expect-error unknown-object parameter should still reject non-object values
unknownInferenceApi.echoUnknownObject(123)

// @ts-expect-error unknown-array elements must be object-like records
unknownEdgeCaseApi.roundTripUnknownArray([123])

// @ts-expect-error unknown-map values must be object-like records
unknownEdgeCaseApi.roundTripUnknownMap(new Map([["bad", 123]]))

// @ts-expect-error nullable unknown record does not accept undefined
unknownEdgeCaseApi.roundTripUnknownNullable(undefined)
