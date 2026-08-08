---
title: WebSocket
description: Long-lived, fully bidirectional Cap'n Web sessions with newWebSocketRpcSession.
---

In WebSocket mode, the client forms a long-lived connection to the server and makes many calls over
it. The server can also make asynchronous calls **back to the client**.

## Client

Declare the interface, then open a session against it:

```ts
import { RpcTarget, RpcStub, newWebSocketRpcSession } from 'capnweb';

// Declare our RPC interface.
interface MyApi extends RpcTarget {
  // Returns information about the logged-in user.
  getUserInfo(): UserInfo;

  // Returns a friendly greeting for a user with the given name.
  greet(name: string): string;
}

// Start a WebSocket session.
//
// (Note that disposing the root stub will close the connection. Here we declare
// it with `using` so that the connection will be closed when the stub goes out
// of scope, but you can also call `stub[Symbol.dispose]()` directly.)
using stub: RpcStub<MyApi> = newWebSocketRpcSession<MyApi>('wss://example.com/api');

// With a WebSocket, we can freely make calls over time.
console.log(await stub.greet('Alice'));
console.log(await stub.greet('Bob'));

// But we can still use Promise Pipelining to reduce round trips. Note that we
// should use `using` with promises we don't intend to await so that the system
// knows when we don't need them anymore.
{
  using userInfoPromise = stub.getUserInfo();
  console.log(await stub.greet(userInfoPromise.name));
}

// Since we never awaited `userInfoPromise`, the server won't even bother
// sending the response back over the wire.
```

## Server calling the client

Pass a callback and the server can invoke it whenever it likes:

```ts
// Client
await api.subscribe((event) => {
  console.log('server pushed:', event);
});
```

```ts
// Server
class Api extends RpcTarget {
  #subscribers: RpcStub<(e: unknown) => void>[] = [];

  subscribe(cb: RpcStub<(e: unknown) => void>) {
    // Stubs in params are disposed when the call returns -- dup() to keep it.
    this.#subscribers.push(cb.dup());
  }
}
```

The `.dup()` there is mandatory. See
[holding on to a callback](/concepts/disposal/#holding-on-to-a-callback-past-the-call-that-delivered-it).

## Server side

`newWebSocketRpcSession()` is the *same function* used on the client. On the server, pass a
`WebSocket` object representing the already-open connection, and your API implementation as the
second parameter:

```ts
function newWebSocketRpcSession(
  webSocket: WebSocket,
  yourApi: RpcTarget,
  options?: RpcSessionOptions
): Disposable;
```

Dispose the returned `Disposable` to close the connection, or let it run until the client closes it.

Runtime-specific wiring:

- [Cloudflare Workers](/servers/workers/): `newWorkersRpcResponse()` does it for you.
- [Node.js](/servers/node/): use the `ws` package.
- [Deno](/servers/deno/): `Deno.upgradeWebSocket()`.
- [Bun](/servers/bun/): `newBunWebSocketRpcHandler()`.

## Disconnection

A dropped connection breaks every stub associated with the session. Detect it with:

```ts
stub.onRpcBroken((error) => {
  console.error('connection lost:', error);
  // tear down UI state, schedule a reconnect, ...
});
```

Cap'n Web does not reconnect automatically. Reconnection means establishing a new session and
re-acquiring any capabilities you held, since stubs from the old session are permanently broken.
See [Sessions & reconnection](/guides/sessions/) for the patterns that make this manageable,
including the React one and how to resume a subscription without gaps.

:::danger
The WebSocket API in browsers always permits cross-site connections, and does not permit setting
headers. Because of this, you generally **cannot use cookies or other headers for authentication.**
Instead, authenticate in-band via an RPC method that returns the authenticated API. See
[Security considerations](/guides/security/).
:::
