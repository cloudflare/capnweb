import { RpcPromise, RpcStub, RpcTarget } from "../src/index.js"
import { expectAssignable, expectType, type NonThenable } from "./helpers.js"

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

interface NamedFormatter {
  (value: number): string
  label: string
}

interface MapApi {
  listUsers(): Promise<User[]>
  listNames(): Promise<string[]>
  listScores(): Promise<readonly number[]>
  maybeUser(enabled: boolean): Promise<User | null>
  pair(): Promise<readonly [number, User]>
  mutablePair(): Promise<[number, User]>
  getLookup(): Promise<Record<string, User>>
  listFormatters(): Promise<NamedFormatter[]>
  greet(name: string): Promise<string>
}

declare const api: RpcStub<MapApi>

// `map()` exposes compile-time placeholders for pipelined values, not awaited Promises.
const mappedNames = api.listUsers().map((user) => {
  expectType<NonThenable<RpcPromise<User>>>(user)
  return user.getName()
})
expectAssignable<Promise<string[]>>(mappedNames)
expectAssignable<Promise<string>>(mappedNames[0])

const mappedGreetings = api.listNames().map((name) => {
  expectType<NonThenable<RpcPromise<string>>>(name)
  return api.greet(name)
})
expectAssignable<Promise<string[]>>(mappedGreetings)
expectAssignable<Promise<string>>(mappedGreetings[0])

const mappedObjects = api.listUsers().map((user) => {
  return {
    id: user.id,
    name: user.getName(),
    bestFriend: user.getBestFriend(),
  }
})

const mappedNestedRpcPromises = api.listUsers().map((user) => {
  return {
    direct: user.getBestFriend(),
    nested: [user.getBestFriend().getName(), { id: user.id }] as const,
  }
})

const mappedScores = api.listScores().map((score) => {
  expectType<NonThenable<RpcPromise<number>>>(score)
  return score.toFixed(2)
})
expectAssignable<Promise<string>>(mappedScores[0])

const firstScore = api.listScores()[0]
expectAssignable<Promise<number>>(firstScore)

const mappedMaybe = api.maybeUser(true).map((user) => {
  expectType<NonThenable<RpcPromise<User>>>(user)
  return user.getName()
})
expectAssignable<Promise<string>>(mappedMaybe[0])

const mappedPair = api.pair().map((pair) => {
  expectType<NonThenable<RpcPromise<number> | RpcPromise<User>>>(pair)
  return pair.toString()
})
expectAssignable<Promise<string>>(mappedPair[0])

const pairFirst = api.pair()[0]
const pairSecond = api.pair()[1]
expectType<RpcPromise<number>>(pairFirst)
expectType<RpcPromise<User>>(pairSecond)

const mutablePairFirst = api.mutablePair()[0]
const mutablePairSecond = api.mutablePair()[1]
expectType<RpcPromise<number>>(mutablePairFirst)
expectType<RpcPromise<User>>(mutablePairSecond)

const mappedLookup = api.getLookup().map((lookup) => {
  expectAssignable<Promise<RpcStub<User>>>(lookup["primary"])
  return lookup["primary"].getName()
})
expectAssignable<Promise<string>>(mappedLookup[0])

const mappedFormatterCalls = api.listFormatters().map((formatter) => {
  expectAssignable<Promise<string>>(formatter.label)
  return formatter(1)
})
expectAssignable<Promise<string[]>>(mappedFormatterCalls)
expectAssignable<Promise<string>>(mappedFormatterCalls[0])

// Awaited checks cover the shapes users see after the mapped pipeline resolves.
async function assertMapAwaitedShapes() {
  const names = await mappedNames
  expectType<string>(names[0])

  const objs = await mappedObjects
  expectType<number>(objs[0].id)
  expectType<string>(objs[0].name)
  expectAssignable<Promise<string>>(objs[0].bestFriend.getName())

  const nested = await mappedNestedRpcPromises
  expectAssignable<Promise<string>>(nested[0].direct.getName())
  expectType<number>(nested[0].nested[1].id)
}

void assertMapAwaitedShapes

// Negative checks: placeholder values must not look like native Promises or full arrays.

// @ts-expect-error callback parameter should be inferred from map placeholder, not string
api.listUsers().map((user: string) => user.toUpperCase())

// @ts-expect-error map placeholder number values are not plain numbers
api.listScores().map((score) => score + 1)

// @ts-expect-error mapper placeholders are not thenables
api.listScores().map((score) => score.then((value) => value + 1))

// @ts-expect-error mapper placeholders are not thenables
api.listScores().map((score) => score.catch(() => 0))

// @ts-expect-error mapper placeholders are not thenables
api.listScores().map((score) => score.finally(() => {}))

// @ts-expect-error callable mapper placeholders are not thenables
api.listFormatters().map((formatter) => formatter.then(() => ""))

// @ts-expect-error map callbacks cannot be async
api.listUsers().map(async (user) => user.getName())

// @ts-expect-error map callbacks cannot be async for primitive placeholders either
api.listNames().map(async (name) => api.greet(name))

// @ts-expect-error map callbacks cannot return native promises
api.listUsers().map((user) => Promise.resolve(user.getName()))

// @ts-expect-error map callbacks cannot return thenables that wrap native promises
api.listUsers().map((user) => Promise.resolve(user.getName()) as PromiseLike<string>)

// @ts-expect-error map callbacks cannot return thenables nested in objects
api.listUsers().map((user) => ({ nested: Promise.resolve(user.getName()) as PromiseLike<string> }))

// @ts-expect-error map callbacks cannot return native promises in objects
api.listUsers().map((user) => ({ name: Promise.resolve("x"), id: user.id }))

// @ts-expect-error map callbacks cannot return native promises in arrays
api.listUsers().map((user) => [user.getName(), Promise.resolve("x")])

// @ts-expect-error map callbacks cannot return native promises nested in containers
api.listUsers().map((user) => ({ nested: [{ friend: Promise.resolve(user.getBestFriend()) }] }))

// @ts-expect-error map callbacks cannot return unions containing native promises
api.listUsers().map((user) => (Math.random() > 0.5 ? user.getName() : Promise.resolve("fallback")))

// @ts-expect-error runtime only supports numeric array indexes over pipelining
api.listScores().length

// @ts-expect-error runtime only supports numeric array indexes over pipelining
api.listScores().at(0)

// @ts-expect-error runtime only supports numeric array indexes over pipelining
api.listScores().slice(0, 1)

// @ts-expect-error callback value should not expose unknown methods
api.maybeUser(true).map((user) => user.notARealMethod())

// @ts-expect-error pair callback receives one element, not tuple indexing
api.pair().map((pair) => pair[0])

// @ts-expect-error callable mapper placeholders should preserve function args
api.listFormatters().map((formatter) => formatter("bad"))

// @ts-expect-error runtime only supports numeric array indexes over pipelining
api.pair().length

// @ts-expect-error runtime only supports numeric array indexes over pipelining
api.mutablePair().push(1)

// @ts-expect-error runtime only supports numeric array indexes over pipelining
api.mutablePair().pop()
