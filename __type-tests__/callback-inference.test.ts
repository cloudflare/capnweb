import { RpcStub, RpcTarget } from "../src/index.js"
import { expectAssignable, expectType, type Expect } from "./helpers.js"

type NoArgCallback = () => void
type TimestampCallback = (ts: number) => void
type AsyncTimestampCallback = (ts: number) => Promise<void>
type OptionalTimestampCallback = (ts?: number) => void
type BooleanAsyncCallback = (flag: boolean) => Promise<boolean>
type TimestampPairCallback = (ts: number, source: string) => void
type ErrorCallback = (message: string) => void
type TimestampRelay = (next: RpcStub<TimestampCallback>, value: number) => void

class CallbackServer extends RpcTarget {
  run(callback: RpcStub<NoArgCallback>) {
    callback()
  }

  sendMeCurrentTs(callback: RpcStub<TimestampCallback>) {
    callback(Date.now())
  }

  sendMeCurrentTsAsync(callback: RpcStub<AsyncTimestampCallback>) {
    return callback(Date.now())
  }

  sendOptional(callback: RpcStub<OptionalTimestampCallback>) {
    callback()
    callback(Date.now())
  }

  sendBooleanAsync(callback: RpcStub<BooleanAsyncCallback>) {
    return callback(true)
  }

  sendPair(callback: RpcStub<TimestampPairCallback>) {
    callback(Date.now(), "clock")
  }

  configure(options: { onTick: RpcStub<TimestampCallback>; onError?: RpcStub<ErrorCallback> }) {
    options.onTick(Date.now())
    options.onError?.("boom")
  }

  fanout(callbacks: Array<RpcStub<TimestampCallback>>) {
    for (const callback of callbacks) {
      callback(Date.now())
    }
  }

  useRelay(relay: RpcStub<TimestampRelay>) {
    relay((value: number) => {
      void value
    }, Date.now())
  }
}

declare const stub: RpcStub<CallbackServer>
declare const noArgCallbackStub: RpcStub<NoArgCallback>
declare const callbackStub: RpcStub<TimestampCallback>
declare const asyncCallbackStub: RpcStub<AsyncTimestampCallback>
declare const asyncBooleanCallbackStub: RpcStub<BooleanAsyncCallback>

// Static checks for the callback parameter shapes exposed on the stub.
type RunArg = Parameters<typeof stub.run>[0]
type SendTsArg = Parameters<typeof stub.sendMeCurrentTs>[0]
type SendTsAsyncArg = Parameters<typeof stub.sendMeCurrentTsAsync>[0]
type SendOptionalArg = Parameters<typeof stub.sendOptional>[0]
type SendPairArg = Parameters<typeof stub.sendPair>[0]

type _RunAllowsPlainFn = Expect<(() => void) extends RunArg ? true : false>
type _RunAllowsPromiseFn = Expect<Promise<() => void> extends RunArg ? true : false>
type _SendTsAllowsPlainFn = Expect<((ts: number) => void) extends SendTsArg ? true : false>
type _SendTsAllowsStub = Expect<RpcStub<(ts: number) => void> extends SendTsArg ? true : false>
type _SendTsAllowsPromiseFn = Expect<Promise<(ts: number) => void> extends SendTsArg ? true : false>
type _SendTsAsyncAllowsPlainFn = Expect<
  ((ts: number) => Promise<void>) extends SendTsAsyncArg ? true : false
>
type _SendOptionalAllowsPlainFn = Expect<
  ((ts?: number) => void) extends SendOptionalArg ? true : false
>
type _SendPairAllowsPlainFn = Expect<
  ((ts: number, source: string) => void) extends SendPairArg ? true : false
>

// Positive coverage: plain functions, RpcStub instances, and promise-wrapped callbacks all work.
stub.run(() => {})
stub.run(noArgCallbackStub)
stub.run(Promise.resolve(() => {}))

stub.sendMeCurrentTs((ts: number) => {
  expectType<number>(ts)
  ts.toFixed()
})
stub.sendMeCurrentTs(callbackStub)
stub.sendMeCurrentTs(
  Promise.resolve((ts: number) => {
    expectType<number>(ts)
  })
)
stub.sendMeCurrentTs(Promise.resolve(callbackStub))

stub.sendMeCurrentTsAsync(async (ts: number) => {
  expectType<number>(ts)
  ts.toFixed()
})
stub.sendMeCurrentTsAsync(asyncCallbackStub)
stub.sendMeCurrentTsAsync(
  Promise.resolve(async (ts: number) => {
    ts.toFixed()
  })
)

stub.sendOptional((ts?: number) => {
  expectType<number | undefined>(ts)
  ts?.toFixed()
})
stub.sendOptional(
  Promise.resolve((ts?: number) => {
    ts?.toFixed()
  })
)

const booleanResult = stub.sendBooleanAsync(async (flag: boolean) => {
  expectType<boolean>(flag)
  return flag
})
expectAssignable<Promise<boolean>>(booleanResult)
stub.sendBooleanAsync(asyncBooleanCallbackStub)

stub.sendPair((ts: number, source: string) => {
  expectType<number>(ts)
  expectType<string>(source)
})

stub.configure({
  onTick: (ts: number) => {
    expectType<number>(ts)
  },
})
stub.configure({
  onTick: callbackStub,
  onError: (message: string) => {
    expectType<string>(message)
  },
})
stub.configure(
  Promise.resolve({
    onTick: (ts: number) => {
      ts.toFixed()
    },
  })
)

stub.fanout([
  callbackStub,
  (ts: number) => {
    ts.toFixed()
  },
  Promise.resolve((ts: number) => {
    ts.toFixed()
  }),
])

stub.useRelay((next: RpcStub<TimestampCallback>, value: number) => {
  expectAssignable<Promise<void>>(next(value))
  expectType<number>(value)
})
stub.useRelay(
  Promise.resolve((next: RpcStub<TimestampCallback>, value: number) => {
    void next
    void value
  })
)

// Inline callbacks should inherit parameter types from the surrounding RpcStub signature.
stub.sendMeCurrentTs((ts) => {
  expectType<number>(ts)
  ts.toFixed()
})
stub.sendOptional((ts) => {
  expectType<number | undefined>(ts)
})

// @ts-expect-error wrong callback argument type
stub.sendMeCurrentTs((ts: string) => {
  console.log(ts)
})

// @ts-expect-error run callback should not require parameters
stub.run((value: number) => {
  console.log(value)
})

// @ts-expect-error callback requires too many required parameters
stub.sendMeCurrentTs((ts: number, extra: number) => {
  console.log(ts, extra)
})

// @ts-expect-error wrong callback return type for async callback
stub.sendMeCurrentTsAsync((ts: number) => {
  console.log(ts)
})

// @ts-expect-error wrong callback parameter type
stub.sendPair((ts: string, source: string) => {
  console.log(ts, source)
})

// @ts-expect-error optional callback has wrong argument type
stub.sendOptional((ts?: string) => {
  console.log(ts)
})

// @ts-expect-error boolean callback must return Promise<boolean>
stub.sendBooleanAsync((flag: boolean) => {
  return flag
})

stub.configure({
  // @ts-expect-error nested callback in object has wrong arg type
  onTick: (ts: string) => {
    console.log(ts)
  },
})

stub.configure({
  onTick: callbackStub,
  // @ts-expect-error nested callback in object has wrong arg type
  onError: (message: number) => {
    console.log(message)
  },
})

stub.fanout([
  // @ts-expect-error fanout callback element has wrong arg type
  (ts: string) => {
    console.log(ts)
  },
])

// @ts-expect-error promise callback has wrong arg type
stub.sendMeCurrentTs(Promise.resolve((ts: string) => {
  console.log(ts)
}))

// @ts-expect-error relay callback value param has wrong type
stub.useRelay((next: RpcStub<TimestampCallback>, value: string) => {
  console.log(next, value)
})
