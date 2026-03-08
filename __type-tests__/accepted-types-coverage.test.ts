import { RpcStub, type RpcCompatible } from "../src/index.js"
import { expectAssignable, expectType, type Expect } from "./helpers.js"

type LabelState = { label: string; ok: boolean }

type PlainObject = {
  id: string
  meta: {
    enabled: boolean
    tags: string[]
    count: number | null
  }
  nested: Array<{
    when: Date
    bytes: Uint8Array
  }>
}

type WellKnownError =
  | AggregateError
  | EvalError
  | RangeError
  | ReferenceError
  | SyntaxError
  | TypeError
  | URIError

type AcceptedBundle = {
  text: string
  count: number
  ok: boolean
  nil: null
  missing: undefined
  object: { id: string; tags: string[] }
  list: string[]
  big: bigint
  when: Date
  bytes: Uint8Array
  err: TypeError
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<any>
  headers: Headers
  request: Request
  response: Response
}

interface AcceptedTypesApi {
  roundTripString(value: string): string
  roundTripNumber(value: number): number
  roundTripBoolean(value: boolean): boolean
  roundTripNull(value: null): null
  roundTripUndefined(value: undefined): undefined

  roundTripPlainObject(value: PlainObject): PlainObject
  roundTripArray(value: LabelState[]): LabelState[]

  roundTripBigInt(value: bigint): bigint
  roundTripDate(value: Date): Date
  roundTripBytes(value: Uint8Array): Uint8Array
  roundTripError(value: Error): Error
  roundTripReadable(value: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>
  roundTripWritable(value: WritableStream<any>): WritableStream<any>
  roundTripHeaders(value: Headers): Headers
  roundTripRequest(value: Request): Request
  roundTripResponse(value: Response): Response
  roundTripKnownError(value: WellKnownError): WellKnownError
  roundTripBundle(value: AcceptedBundle): AcceptedBundle
}

// Compile-time compatibility coverage for accepted transport shapes.
type _RpcCompatibleAcceptedTypes = [
  Expect<string extends RpcCompatible<string> ? true : false>,
  Expect<number extends RpcCompatible<number> ? true : false>,
  Expect<boolean extends RpcCompatible<boolean> ? true : false>,
  Expect<null extends RpcCompatible<null> ? true : false>,
  Expect<undefined extends RpcCompatible<undefined> ? true : false>,
  Expect<PlainObject extends RpcCompatible<PlainObject> ? true : false>,
  Expect<LabelState[] extends RpcCompatible<LabelState[]> ? true : false>,
  Expect<bigint extends RpcCompatible<bigint> ? true : false>,
  Expect<Date extends RpcCompatible<Date> ? true : false>,
  Expect<Uint8Array extends RpcCompatible<Uint8Array> ? true : false>,
  Expect<Error extends RpcCompatible<Error> ? true : false>,
  Expect<AggregateError extends RpcCompatible<AggregateError> ? true : false>,
  Expect<EvalError extends RpcCompatible<EvalError> ? true : false>,
  Expect<RangeError extends RpcCompatible<RangeError> ? true : false>,
  Expect<ReferenceError extends RpcCompatible<ReferenceError> ? true : false>,
  Expect<SyntaxError extends RpcCompatible<SyntaxError> ? true : false>,
  Expect<TypeError extends RpcCompatible<TypeError> ? true : false>,
  Expect<URIError extends RpcCompatible<URIError> ? true : false>,
  Expect<
    ReadableStream<Uint8Array> extends RpcCompatible<ReadableStream<Uint8Array>> ? true : false
  >,
  Expect<WritableStream<any> extends RpcCompatible<WritableStream<any>> ? true : false>,
  Expect<Headers extends RpcCompatible<Headers> ? true : false>,
  Expect<Request extends RpcCompatible<Request> ? true : false>,
  Expect<Response extends RpcCompatible<Response> ? true : false>,
  Expect<AcceptedBundle extends RpcCompatible<AcceptedBundle> ? true : false>
]

declare const api: RpcStub<AcceptedTypesApi>

const plainObject: PlainObject = {
  id: "obj-1",
  meta: {
    enabled: true,
    tags: ["rpc", "typed"],
    count: 3,
  },
  nested: [{ when: new Date(0), bytes: new Uint8Array([1, 2, 3]) }],
}

const request = new Request("https://example.com/path", {
  method: "POST",
  headers: new Headers({ "content-type": "text/plain" }),
  body: "hello",
})
const response = new Response("ok", {
  status: 201,
  headers: new Headers({ "x-ok": "1" }),
})
const readableBytes = new ReadableStream<Uint8Array>()
const writableAny = new WritableStream<any>()
const readableText = new ReadableStream<string>()
const bundle: AcceptedBundle = {
  text: "bundle",
  count: 1,
  ok: true,
  nil: null,
  missing: undefined,
  object: { id: "obj", tags: ["rpc"] },
  list: ["one", "two"],
  big: 99n,
  when: new Date(0),
  bytes: new Uint8Array([3, 4, 5]),
  err: new TypeError("typed"),
  readable: readableBytes,
  writable: writableAny,
  headers: new Headers({ "x-bundle": "1" }),
  request,
  response,
}

// Positive coverage for values that should round-trip directly.
expectAssignable<Promise<string>>(api.roundTripString("hello"))
expectAssignable<Promise<number>>(api.roundTripNumber(123))
expectAssignable<Promise<boolean>>(api.roundTripBoolean(true))
expectAssignable<Promise<null>>(api.roundTripNull(null))
expectAssignable<Promise<undefined>>(api.roundTripUndefined(undefined))

expectAssignable<Promise<PlainObject>>(api.roundTripPlainObject(plainObject))
expectAssignable<Promise<LabelState[]>>(api.roundTripArray([{ label: "a", ok: true }]))

expectAssignable<Promise<bigint>>(api.roundTripBigInt(42n))
expectAssignable<Promise<Date>>(api.roundTripDate(new Date(0)))
expectAssignable<Promise<Uint8Array>>(api.roundTripBytes(new Uint8Array([9, 8])))
expectAssignable<Promise<Error>>(api.roundTripError(new Error("boom")))
expectAssignable<Promise<ReadableStream<Uint8Array>>>(api.roundTripReadable(readableBytes))
expectAssignable<Promise<WritableStream<any>>>(api.roundTripWritable(writableAny))
expectAssignable<Promise<Headers>>(api.roundTripHeaders(new Headers({ "x-id": "1" })))
expectAssignable<Promise<Request>>(api.roundTripRequest(request))
expectAssignable<Promise<Response>>(api.roundTripResponse(response))
expectAssignable<Promise<WellKnownError>>(api.roundTripKnownError(new TypeError("typed")))
expectAssignable<Promise<AcceptedBundle>>(api.roundTripBundle(bundle))

// Well-known Error subclasses should be accepted via Error base type.
api.roundTripError(new TypeError("type"))
api.roundTripError(new RangeError("range"))
api.roundTripError(new ReferenceError("ref"))
api.roundTripError(new SyntaxError("syntax"))
api.roundTripError(new URIError("uri"))
api.roundTripError(new EvalError("eval"))
api.roundTripKnownError(new RangeError("range"))
api.roundTripKnownError(new ReferenceError("ref"))
api.roundTripKnownError(new SyntaxError("syntax"))
api.roundTripKnownError(new URIError("uri"))
api.roundTripKnownError(new EvalError("eval"))
api.roundTripKnownError(new AggregateError([], "agg"))

// Keep awaited assertions together so the resolved, post-Unstubify shapes stay obvious.
async function assertAcceptedAwaitedShapes() {
  const s = await api.roundTripString("value")
  const n = await api.roundTripNumber(9)
  const b = await api.roundTripBoolean(true)
  const z = await api.roundTripNull(null)
  const u = await api.roundTripUndefined(undefined)
  const p = await api.roundTripPlainObject(plainObject)
  const a = await api.roundTripArray([{ label: "x", ok: false }])
  const bi = await api.roundTripBigInt(1n)
  const d = await api.roundTripDate(new Date(0))
  const bytes = await api.roundTripBytes(new Uint8Array([1]))
  const err = await api.roundTripError(new TypeError("typed"))
  const rs = await api.roundTripReadable(readableBytes)
  const ws = await api.roundTripWritable(writableAny)
  const h = await api.roundTripHeaders(new Headers())
  const req = await api.roundTripRequest(request)
  const res = await api.roundTripResponse(response)
  const knownErr = await api.roundTripKnownError(new TypeError("known"))
  const bundled = await api.roundTripBundle(bundle)

  expectType<string>(s)
  expectType<number>(n)
  expectType<boolean>(b)
  expectType<null>(z)
  expectType<undefined>(u)
  expectType<PlainObject>(p)
  expectType<LabelState[]>(a)
  expectType<bigint>(bi)
  expectType<Date>(d)
  expectType<Uint8Array>(bytes)
  expectType<Error>(err)
  expectType<ReadableStream<Uint8Array>>(rs)
  expectType<WritableStream<any>>(ws)
  expectType<Headers>(h)
  expectType<Request>(req)
  expectType<Response>(res)
  expectType<WellKnownError>(knownErr)
  expectType<AcceptedBundle>(bundled)
  expectType<TypeError>(bundled.err)
}

void assertAcceptedAwaitedShapes

// Negative checks: these calls must stay rejected by the compiler.

// @ts-expect-error string required
api.roundTripString(123)

// @ts-expect-error null-only method should reject undefined
api.roundTripNull(undefined)

// @ts-expect-error undefined-only method should reject null
api.roundTripUndefined(null)

api.roundTripPlainObject({
  // @ts-expect-error plain object id must be string
  id: 123,
  meta: { enabled: true, tags: ["ok"], count: 1 },
  nested: [],
})

// @ts-expect-error byte stream must be ReadableStream<Uint8Array>
api.roundTripReadable(readableText)

// @ts-expect-error Request required
api.roundTripRequest("https://example.com")

// @ts-expect-error Response required
api.roundTripResponse("ok")

// @ts-expect-error Headers required
api.roundTripHeaders(new Map([["x-id", "1"]]))

// @ts-expect-error known-error method requires a well-known Error subclass
api.roundTripKnownError("base")
