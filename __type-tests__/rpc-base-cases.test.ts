import { RpcPromise, RpcStub, RpcTarget, type RpcCompatible } from "../src/index.js"
import { expectAssignable, expectType, type Equal, type Expect } from "./helpers.js"

class PointTarget extends RpcTarget {
  get x(): number {
    return 0
  }

  move(_dx: number, _dy: number): void {}
}

interface BaseCasesApi {
  roundTripBoolean(value: boolean): boolean
  roundTripNullable(value: string | null | undefined): string | null | undefined
  roundTripBigInt(value: bigint): bigint
  roundTripDate(value: Date): Date
  roundTripBytes(value: Uint8Array): Uint8Array
  roundTripError(value: Error): Error
  roundTripHeaders(value: Headers): Headers
  roundTripTuple(value: readonly [string, number]): readonly [string, number]
  roundTripReadonly(value: readonly string[]): readonly string[]
  roundTripRecord(
    value: Record<string, { count: number; when: Date }>
  ): Record<string, { count: number; when: Date }>
  roundTripTarget(value: RpcStub<PointTarget>): Promise<PointTarget>
  roundTripTargetRecord(
    value: Record<string, RpcStub<PointTarget>>
  ): Promise<Record<string, PointTarget>>
  invoke(callback: RpcStub<(name: string, attempt: number) => Promise<boolean>>): Promise<boolean>
}

type _BaseRpcCompatibleChecks = [
  Expect<boolean extends RpcCompatible<boolean> ? true : false>,
  Expect<number extends RpcCompatible<number> ? true : false>,
  Expect<bigint extends RpcCompatible<bigint> ? true : false>,
  Expect<null extends RpcCompatible<null> ? true : false>,
  Expect<undefined extends RpcCompatible<undefined> ? true : false>,
  Expect<Date extends RpcCompatible<Date> ? true : false>,
  Expect<Uint8Array extends RpcCompatible<Uint8Array> ? true : false>,
  Expect<Error extends RpcCompatible<Error> ? true : false>,
  Expect<Headers extends RpcCompatible<Headers> ? true : false>,
  Expect<
    ReadableStream<Uint8Array> extends RpcCompatible<ReadableStream<Uint8Array>> ? true : false
  >,
  Expect<WritableStream<any> extends RpcCompatible<WritableStream<any>> ? true : false>,
  Expect<readonly [string, number] extends RpcCompatible<readonly [string, number]> ? true : false>,
  Expect<
    Record<string, { count: number; when: Date }> extends RpcCompatible<
      Record<string, { count: number; when: Date }>
    >
      ? true
      : false
  >
]

declare const api: RpcStub<BaseCasesApi>
declare const point: PointTarget
declare const pointStub: RpcStub<PointTarget>
declare const pointPromise: RpcPromise<PointTarget>
declare const nullableStringPromise: RpcPromise<string>
declare const pointRecord: Record<string, PointTarget | RpcStub<PointTarget>>

const booleanResult = api.roundTripBoolean(true)
expectAssignable<Promise<boolean>>(booleanResult)

api.roundTripNullable(null)
api.roundTripNullable(undefined)
api.roundTripNullable(nullableStringPromise)

api.roundTripBigInt(10n)
api.roundTripDate(new Date(0))
api.roundTripBytes(new Uint8Array([1, 2, 3]))
api.roundTripError(new Error("boom"))
api.roundTripHeaders(new Headers({ "x-id": "1" }))

const tupleResult = api.roundTripTuple(["id-1", 7] as const)
expectAssignable<Promise<readonly [string, number]>>(tupleResult)

const readonlyResult = api.roundTripReadonly(["a", "b", "c"] as const)
expectAssignable<Promise<readonly string[]>>(readonlyResult)

api.roundTripRecord({
  one: { count: 1, when: new Date(0) },
  two: { count: 2, when: new Date(0) },
})

api.roundTripTarget(point)
api.roundTripTarget(pointStub)
api.roundTripTarget(pointPromise)

api.roundTripTargetRecord(pointRecord)

const invokeResult = api.invoke(async (name: string, attempt: number) => {
  expectType<string>(name)
  expectType<number>(attempt)
  return name.length > 0 && attempt > 0
})
expectAssignable<Promise<boolean>>(invokeResult)

type _AwaitedRoundTripTarget = Awaited<ReturnType<typeof api.roundTripTarget>>
type _AwaitedRoundTripTargetRecord = Awaited<ReturnType<typeof api.roundTripTargetRecord>>

type _RoundTripTargetReturnsStub = Expect<Equal<_AwaitedRoundTripTarget, RpcStub<PointTarget>>>
type _RoundTripTargetRecordValuesAreStub = Expect<
  Equal<
    _AwaitedRoundTripTargetRecord extends Record<string, infer Value> ? Value : never,
    RpcStub<PointTarget>
  >
>

async function assertAwaitedBaseShapes() {
  const tuple = await api.roundTripTuple(["tuple", 1] as const)
  expectType<readonly [string, number]>(tuple)

  const target = await api.roundTripTarget(point)
  expectType<RpcStub<PointTarget>>(target)
  expectAssignable<Promise<void>>(target.move(1, 2))

  const targetRecord = await api.roundTripTargetRecord({ primary: point })
  expectType<RpcStub<PointTarget>>(targetRecord.primary)
}

void assertAwaitedBaseShapes

// Negative checks.
// @ts-expect-error nullable method only accepts string | null | undefined
api.roundTripNullable(123)

// @ts-expect-error tuple first element must be string
api.roundTripTuple([1, 2] as const)

// @ts-expect-error readonly array elements must be strings
api.roundTripReadonly([1, 2, 3])

// @ts-expect-error target requires RpcTarget brand
api.roundTripTarget({ move: () => {}, x: 1 })

// @ts-expect-error target record values require RpcTarget brand
api.roundTripTargetRecord({ bad: { move: () => {}, x: 1 } })

// @ts-expect-error callback argument type mismatch
api.invoke(async (name: number, attempt: number) => {
  return name > attempt
})

// @ts-expect-error callback must return Promise<boolean>
api.invoke((name: string, attempt: number) => {
  return name.length > attempt
})

// @ts-expect-error headers argument must be Headers
api.roundTripHeaders(new Map([["x-id", "1"]]))
