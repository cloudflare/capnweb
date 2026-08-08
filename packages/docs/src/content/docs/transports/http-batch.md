---
title: HTTP Batch
description: Send a whole dependent call graph in one HTTP request using newHttpBatchRpcSession.
---

In HTTP batch mode, a batch of RPC calls is made in a single HTTP request, with the server returning
a batch of results.

**Cap'n Web has a magic trick:** the results of one call in the batch can be used in the parameters
to later calls *in the same batch*, even though the entire batch is sent at once. If you take the
promise returned by one call and use it in the parameters to another, the promise is replaced with
its resolution before delivering it to the callee. This is
[promise pipelining](/concepts/promises/).

## Client

```ts
import { RpcTarget, RpcStub, newHttpBatchRpcSession } from 'capnweb';

// Declare our RPC interface.
interface MyApi extends RpcTarget {
  // Returns information about the logged-in user.
  getUserInfo(): UserInfo;

  // Returns a friendly greeting for a user with the given name.
  greet(name: string): string;
}

// Start a batch request using this interface.
using stub: RpcStub<MyApi> = newHttpBatchRpcSession<MyApi>('https://example.com/api');

// The batch will be sent on the next I/O tick (i.e. using setTimeout(sendBatch, 0)).
// You have until then to add calls to the batch.
//
// We can make any number of calls as part of the batch, as long as we store the
// promises without awaiting them yet.
let promise1 = stub.greet('Alice');
let promise2 = stub.greet('Bob');

// A promise returned by one call can be used in the input to another call. The
// first call's result will be substituted into the second call's parameters on
// the server side. If the first call returns an object, you can even specify a
// property of the object to pass to the second call, as shown here.
let userInfoPromise = stub.getUserInfo();
let promise3 = stub.greet(userInfoPromise.name);

// Use Promise.all() to wait on all the promises at once. NOTE: You don't
// necessarily have to use Promise.all(), but you must make sure you have
// explicitly awaited (or called `.then()` on) all promises before the batch is
// sent. The system will only ask the server to send back results for the
// promises you explicitly await. In this example, we have not awaited
// `userInfoPromise` -- we only used it as a parameter to another call -- so the
// result will not actually be returned.
let [greeting1, greeting2, greeting3] = await Promise.all([promise1, promise2, promise3]);

console.log(greeting1);
console.log(greeting2);
console.log(greeting3);
```

## When the batch is sent

The batch is dispatched on the next I/O tick. Everything you queue synchronously ends up in the same
request. The first `await` is your deadline.

:::caution
Once the batch completes, the `stub` and everything derived from it stops working. You must start a
new batch for further calls.
:::

## Why you might prefer batch over WebSocket

- **Stateless.** Works on any HTTP endpoint, including cached/edge deployments with no persistent
  connections.
- **Cheap.** No connection to keep alive, no reconnection logic, no heartbeats.
- **No disposal bookkeeping.** All stubs are implicitly disposed when the batch ends.

The trade-off: the server cannot call you back later, and there is no subscription model.

## Server side

Any of the [server runtimes](/servers/workers/) can answer a batch request:

- Cloudflare Workers: `newWorkersRpcResponse()` handles batch *and* WebSocket.
- Fetch-API runtimes: `newHttpBatchRpcResponse(request, api, options?)`.
- Node.js: `nodeHttpBatchRpcResponse(request, response, api, options?)`.

## Cross-origin

Batch requests are subject to normal CORS rules. If you also accept WebSockets, you might as well
accept cross-origin HTTP, since WebSockets always permit cross-origin requests anyway:

```ts
response.headers.set('Access-Control-Allow-Origin', '*');
```

Read [Security considerations](/guides/security/) before doing this; in particular, do not rely on
cookies for authentication.
