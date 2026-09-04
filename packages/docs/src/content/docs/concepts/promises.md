---
title: RpcPromise & Pipelining
description: Why RPC calls return RpcPromise instead of Promise, and how that enables single-round-trip call chains.
sidebar:
  order: 4
---

Calling an RPC method returns an `RpcPromise` rather than a regular `Promise`.

You can use an `RpcPromise` in all the ways a regular `Promise` can be used: you can `await` it,
call `.then()`, pass it to `Promise.resolve()`, and so on. This all works because `RpcPromise` is a
["thenable"](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise#thenables).

But you can do more with an `RpcPromise`, because it supports **promise pipelining**.

## 1. A promise is also a stub

An `RpcPromise` is a stub for the eventual result of the promise. You can access properties and
invoke methods on it without awaiting it first.

```ts
// In a single round trip, authenticate the user, and fetch their notifications.
let user = api.authenticate(cookie);
let notifications = await user.getNotifications();
```

## 2. A promise can be an argument

An `RpcPromise`, or a property of one, can be passed as a parameter to other RPC calls.

```ts
// In a single round trip, authenticate the user, and fetch their public profile
// given their ID.
let user = api.authenticate(cookie);
let profile = await api.getUserProfile(user.id);
```

Whenever an `RpcPromise` is passed in the parameters to an RPC, or returned as part of a result, the
promise is replaced with its resolution before delivery to the receiving application. So you can use
an `RpcPromise<T>` anywhere a `T` is required.

## Awaiting is what costs a round trip

**Building the chain is free; awaiting is what talks to the network.** Structure your code so that
everything you need is expressed before the first `await`.

```ts
// ❌ Three round trips.
let a = await api.first();
let b = await api.second(a);
let c = await api.third(b);

// ✅ One round trip.
let c = await api.third(api.second(api.first()));
```

### One round trip is not the same as one message

"One round trip" is a claim about **waiting**, not about message count.

| Transport                             | Three chained calls send…                   | Round trips |
| ------------------------------------- | ------------------------------------------- | ----------- |
| [WebSocket](/transports/websocket/)   | Three `push` messages, written back-to-back | 1           |
| [HTTP batch](/transports/http-batch/) | One request body containing all three       | 1           |

Over a WebSocket, Cap'n Web really does send a separate message per call, so if you go looking in
your browser's network inspector, you will find three frames, plus a `pull` for the result you
awaited and a `release` afterwards. What it does *not* do is wait for a reply in between: they all
go out in the same tick and the results come back together, which in elapsed network time is
indistinguishable from sending one message. The HTTP batch transport goes further and concatenates
the whole batch into a single request body.

**Count your `await`s, not your calls.** If you can set up an entire chain without awaiting
anything, it costs one round trip no matter how many calls are in it.

## Transforming without pulling data back

If you need to do something for each element of a result, use
[the magic `.map()` method](/concepts/map/) rather than awaiting the array and looping:

```ts
let names = await api.listUserIds().map(id => [id, api.getUserName(id)]);
```

## Making one from a local `Promise`

Normally an `RpcPromise` comes back from a call. You can also build one yourself, out of an
ordinary `Promise`, with `new RpcPromise(promise)`. Pipelined calls then queue up in order and are
delivered once the inner promise settles.

Wrapping a promise is semantically identical to making a local-loopback RPC that returns it:

```ts
import { RpcPromise, RpcStub } from 'capnweb';

let myPromise = Promise.resolve({ value: 123 });

// This...
using direct = new RpcPromise(myPromise);

// ...means the same as this.
using rpcFunc = new RpcStub(() => myPromise);
using loopback = rpcFunc();
```

### Call a target that does not exist yet

`new RpcPromise(promise)` lets you call a target before the target exists. Here, two calls and a
getter queue before the counter is created.

```ts
import { RpcPromise, RpcTarget } from 'capnweb';

class Counter extends RpcTarget {
  #value: number;

  constructor(value = 0) {
    super();
    this.#value = value;
  }

  increment(by = 1) {
    return this.#value += by;
  }

  get value() {
    return this.#value;
  }
}

{
  let { promise, resolve } = Promise.withResolvers<Counter>();
  using counter = new RpcPromise(promise);

  using first = counter.increment();
  using second = counter.increment(10);
  // Property access queues the getter and returns an RpcPromise<number>.
  let value = counter.value;

  resolve(new Counter(0));
  console.log('ordered:', await first, await second, await value);
}
```

This prints `ordered: 1 11 11`: pending operations run in invocation order. Property promises such
as `counter.value` have no independent disposer.

### Hide connection setup behind a stub

This [MessagePort](/transports/message-port/) example exposes a stub while local setup finishes.

```ts
import { newMessagePortRpcSession } from 'capnweb';

class Api extends RpcTarget {
  authenticate(token: string) {
    if (token !== 's3cret') {
      throw new Error('bad token');
    }
    return new Counter(100);
  }
}

{
  let channel = new MessageChannel();
  using serverSide = newMessagePortRpcSession(channel.port1, new Api());

  async function connect() {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
    return newMessagePortRpcSession<Api>(channel.port2);
  }

  using api = new RpcPromise(connect());
  using authed = api.authenticate('s3cret');
  using result = authed.increment(5);

  console.log('connected:', await result);
}
```

This prints `connected: 105`. The caller does not await readiness or authentication, so the calls
remain pipelined.

### Reject when readiness fails

A rejected source breaks the wrapper and its queued operations.

```ts
{
  using counter = new RpcPromise<Counter>(
    Promise.reject(new Error('connection failed')),
  );

  counter.onRpcBroken((error: Error) => console.log('broken:', error.message));
  using result = counter.increment();

  try {
    await result;
  } catch (error) {
    if (error instanceof Error) {
      console.log('call:', error.message);
    }
  }
}
```

The output is `broken: connection failed` followed by `call: connection failed`. Both receive the
same rejection. An unused wrapper observes its backing rejection, but every queued call or `.map()`
result must still be awaited or disposed.

Cap'n Web processes the resolution with the same serialization, stub conversion, rejection, and
ownership semantics as an RPC return:

- The backing value must be a real `Promise`.
- The promise may resolve to any [serializable value](/concepts/values/), an `RpcTarget` or function
  that Cap'n Web converts to a stub, or an `RpcStub`.
- The wrapper [owns](/concepts/disposal/) every stub in the resolution. If another owner will keep
  using a stub, resolve with `stub.dup()`.
- Rejection reaches queued operations, code awaiting the wrapper, and `onRpcBroken`.

> **Pending calls have no built-in bound**
>
> Pending calls retain their arguments, and there is no queue limit or backpressure setting. A
> readiness or reconnection producer must eventually settle. Reject on terminal failure or an
> application deadline, and rate-limit untrusted callers.

## Disposal

`RpcPromise` participates in [disposal](/concepts/disposal/) just like a stub:

- Disposing an `RpcPromise` automatically disposes the future result. It may also cause the promise
  to be cancelled and rejected, though this is not guaranteed. **If you don't intend to await an RPC
  promise, dispose it.**
- Passing an `RpcPromise` in the params or return value of a call follows the same ownership rules
  as passing an `RpcStub`.
- When you access a property of an `RpcStub` or `RpcPromise`, the result is itself an `RpcPromise`,
  but this one does **not** have its own disposer. You must dispose the stub or promise it came
  from.

```ts
{
  using userInfoPromise = stub.getUserInfo();
  console.log(await stub.greet(userInfoPromise.name));
}
// Never awaited, so the server won't even send the response back over the wire.
```

:::caution[Never disposing is a memory leak, on both sides]
Un-awaited, un-disposed promises accumulate. Each one holds an entry in the session's import table,
and pins the corresponding export (and the object it refers to) alive on the peer. A client that
keeps issuing calls and never settles them will grow your server's memory for as long as the
session lasts.

This is only bounded by the session ending. The library has no reference-count limit to configure,
so if you serve untrusted peers you have to bound it in application code. Attaching disposers to
the values you return gives you something to count. See
[Security considerations](/guides/security/) and [Sessions](/guides/sessions/).
:::

## `.dup()` on a property

You can call `.dup()` on a property of a stub or promise to create a stub backed by that property.
This is particularly useful when you know in advance that the property will resolve to a stub:
calling `.dup()` on it gives you a stub you can start using immediately, that otherwise behaves
exactly like the eventual stub would if you awaited it.
