---
title: Other Runtimes
description: The two portable functions that let you serve Cap'n Web from any modern JavaScript runtime.
---

Every runtime does HTTP handling and WebSockets a little differently, although most modern runtimes
use the standard `Request` and `Response` types from the Fetch API, as well as the standard
`WebSocket` API.

You should be able to use these two functions, exported by `capnweb`, to implement both HTTP batch
and WebSocket handling on all platforms:

```ts
// Run a single HTTP batch.
function newHttpBatchRpcResponse(
  request: Request,
  yourApi: RpcTarget,
  options?: RpcSessionOptions
): Promise<Response>;

// Run a WebSocket session.
//
// This is actually the same function as is used on the client side! But on the
// server, you should pass in a `WebSocket` object representing the already-open
// connection, instead of a URL string, and you pass your API implementation as
// the second parameter.
//
// You can dispose the returned `Disposable` to close the connection, or just
// let it run until the client closes it.
function newWebSocketRpcSession(
  webSocket: WebSocket,
  yourApi: RpcTarget,
  options?: RpcSessionOptions
): Disposable;
```

## The general shape

```ts
async function handle(request: Request): Promise<Response> {
  let url = new URL(request.url);
  if (url.pathname !== '/api') {
    return new Response('Not Found', { status: 404 });
  }

  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    // Runtime-specific: obtain a WebSocket for this request, then:
    //   newWebSocketRpcSession(socket, new MyApiImpl());
    // ...and return whatever response the runtime expects for an upgrade.
  }

  return newHttpBatchRpcResponse(request, new MyApiImpl());
}
```

The only genuinely runtime-specific part is obtaining the `WebSocket` object for an upgrade request.
Everything else is portable.

## If your runtime isn't HTTP at all

Cap'n Web only needs a bidirectional stream of discrete messages. If you have one (a TCP socket, a
message queue, a serial link, an `ipc` channel between processes), implement
[`RpcTransport`](/transports/custom/) and use `new RpcSession(transport, localMain)` directly.
