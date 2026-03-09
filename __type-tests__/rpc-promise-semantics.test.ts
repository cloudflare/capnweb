import { RpcPromise, RpcStub, RpcTarget } from "../src/index.js"
import { expectAssignable, expectType, type Equal, type Expect } from "./helpers.js"

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

  getCounter(): Promise<Counter> {
    return Promise.resolve(new Counter())
  }

  getBestFriend(): Promise<User> {
    return Promise.resolve(this)
  }
}

interface PromiseApi {
  ping(): number
  getCounter(seed: number): Promise<Counter>
  getUser(userId: number): Promise<User>
  echoName(name: string): Promise<string>
  sumPair(left: number, right: number): Promise<number>
  describe(input: {
    name: string
    counter: RpcStub<Counter>
    friend: RpcStub<User> | null
  }): Promise<string>
  consumeCounter(counter: RpcStub<Counter>): Promise<number>
}

declare const api: RpcStub<PromiseApi>

const userPromise = api.getUser(1)
const counterPromise = api.getCounter(2)
const namePromise = userPromise.getName()
const idPromise = userPromise.id
const nestedCounterPromise = userPromise.getCounter()

type _AwaitedUserPromise = Expect<Equal<Awaited<typeof userPromise>, RpcStub<User>>>
type _AwaitedCounterPromise = Expect<Equal<Awaited<typeof counterPromise>, RpcStub<Counter>>>
type _AwaitedNamePromise = Expect<Equal<Awaited<typeof namePromise>, string>>
type _AwaitedIdPromise = Expect<Equal<Awaited<typeof idPromise>, number>>

// RpcPromise is a thenable and a pipelined RPC handle until converted to a native Promise.
expectType<RpcPromise<User>>(userPromise)
expectType<RpcPromise<Counter>>(counterPromise)
expectType<RpcPromise<string>>(namePromise)
expectType<RpcPromise<number>>(idPromise)
expectType<RpcPromise<Counter>>(nestedCounterPromise)

userPromise.onRpcBroken((_error) => {})
counterPromise.onRpcBroken((_error) => {})
idPromise.onRpcBroken((_error) => {})

expectAssignable<Promise<number>>(counterPromise.increment(3))
expectAssignable<Promise<number>>(counterPromise.value)
expectAssignable<Promise<string>>(userPromise.getName())
expectAssignable<Promise<number>>(nestedCounterPromise.increment(4))

api.echoName(namePromise)
api.sumPair(idPromise, counterPromise.value)
api.describe({
  name: userPromise.getName(),
  counter: userPromise.getCounter(),
  friend: userPromise.getBestFriend(),
})
api.consumeCounter(nestedCounterPromise)

const promiseFromResolve = Promise.resolve(counterPromise)
const propertyFromResolve = Promise.resolve(namePromise)
const allResolved = Promise.all([api.echoName("alice"), idPromise, counterPromise.value] as const)
expectAssignable<Promise<RpcStub<Counter>>>(promiseFromResolve)
expectAssignable<Promise<string>>(propertyFromResolve)
expectAssignable<Promise<readonly [string, number, number]>>(allResolved)

const thenCounter = counterPromise.then((counter) => {
  expectType<RpcStub<Counter>>(counter)
  return counter.increment(idPromise)
})
const thenName = userPromise.then((user) => {
  expectType<RpcStub<User>>(user)
  return user.getName()
})
const caughtName = api.echoName("ok").catch((_error) => "fallback")
const finalName = api.echoName("ok").finally(() => {})
expectAssignable<Promise<number>>(thenCounter)
expectAssignable<Promise<string>>(thenName)
expectAssignable<Promise<string>>(caughtName)
expectAssignable<Promise<string>>(finalName)

async function assertResolvedPromiseShapes() {
  const user = await userPromise
  const counter = await counterPromise
  const name = await Promise.resolve(namePromise)
  const [label, userId, value] = await allResolved

  expectType<RpcStub<User>>(user)
  expectType<RpcStub<Counter>>(counter)
  expectType<string>(name)
  expectType<string>(label)
  expectType<number>(userId)
  expectType<number>(value)
}

void assertResolvedPromiseShapes

const afterThen = counterPromise.then((counter) => counter)
const afterFinally = counterPromise.finally(() => {})

// @ts-expect-error then() returns a native Promise, so pipelining methods are no longer available
afterThen.increment(1)

// @ts-expect-error Promise.resolve() returns a native Promise, not an RpcPromise
promiseFromResolve.increment(1)

// @ts-expect-error finally() returns a native Promise, not an RpcPromise
afterFinally.value
