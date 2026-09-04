---
title: API Cheat Sheet
description: Every export of the capnweb package at a glance, with links to the page that explains it.
sidebar:
  order: 2
---

Everything below is exported from the `capnweb` package.

## Starting a session

| Function                                                       | Use                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `newHttpBatchRpcSession<T>(url, options?)`                     | Client. One HTTP request carrying a whole batch. [Docs](/transports/http-batch/)      |
| `newWebSocketRpcSession<T>(urlOrSocket, localMain?, options?)` | Client *and* server. Long-lived bidirectional session. [Docs](/transports/websocket/) |
| `newMessagePortRpcSession<T>(port, localMain?, options?)`      | Both ends. Web Workers, iframes. [Docs](/transports/message-port/)                    |
| `new RpcSession<T>(transport, localMain?, options?)`           | Both ends, over any [custom transport](/transports/custom/).                          |

`RpcSession` exposes `getRemoteMain(): T` to obtain a stub for the peer's main interface.

## Answering requests

| Function                                                     | Runtime                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `newWorkersRpcResponse(request, api, options?)`              | [Cloudflare Workers](/servers/workers/). Handles batch *and* WebSocket.                         |
| `newHttpBatchRpcResponse(request, api, options?)`            | Any Fetch-API runtime. [Deno](/servers/deno/), [Bun](/servers/bun/), [others](/servers/other/). |
| `nodeHttpBatchRpcResponse(request, response, api, options?)` | [Node.js](/servers/node/) `http` module.                                                        |
| `newBunWebSocketRpcHandler(factory)`                         | [Bun](/servers/bun/). Returns a `Bun.serve()` `websocket` handler.                              |
| `newWebSocketRpcSession(socket, api, options?)`              | Any runtime, given an open `WebSocket`.                                                         |

## Types and classes

### `RpcTarget`

Base class marking instances as **pass-by-reference**. Callers reach prototype methods and getters,
never instance properties. Names prefixed with `#` are never exposed.
[Docs](/concepts/rpc-target/)

### `RpcStub<T>`

A `Proxy` standing in for a remote object.

| Member               | Meaning                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| *any method*         | Invokes the corresponding method on the remote target. Returns `RpcPromise`. |
| *any property*       | Returns an `RpcPromise` for the remote property.                             |
| `.dup()`             | Independent duplicate; target released when all duplicates are disposed.     |
| `.onRpcBroken(cb)`   | Called if the stub becomes permanently unusable.                             |
| `[Symbol.dispose]()` | Release this stub.                                                           |

`new RpcStub(target)` creates one locally, without a connection. [Docs](/concepts/stubs/)

### `RpcPromise<T>`

A thenable that is *also* a stub for its own eventual result.

| Member                   | Meaning                                              |
| ------------------------ | ---------------------------------------------------- |
| `await` / `.then()`      | Resolve normally.                                    |
| *any method or property* | Pipelined, no round trip.                            |
| `.map(fn)`               | Transform the value remotely. [Docs](/concepts/map/) |
| `.dup()`                 | Duplicate, usable immediately.                       |
| `[Symbol.dispose]()`     | Release; disposes the future result too.             |

`new RpcPromise(promise)` wraps a local `Promise` so callers can pipeline on it before it settles.
It takes ownership of the resolution. [Docs](/concepts/promises/)

### `RpcTransport`

Interface for custom transports.

```ts
interface RpcTransport {
  send(message: string): Promise<void>;
  receive(): Promise<string>;
  abort?(reason: any): void;
  // Optional: "string" | "jsonCompatible" | "jsonCompatibleWithBytes" | "structuredClonable"
  encodingLevel?: string;
}
```

[Docs](/transports/custom/)

### `RpcSessionOptions`

Passed as the last argument to the session and response helpers. Commonly used for response
`headers` (e.g. CORS) on the HTTP batch helpers.

## Disposal at a glance

| You have                                             | You must                                               |
| ---------------------------------------------------- | ------------------------------------------------------ |
| A stub you created or received as a **return value** | Dispose it.                                            |
| A stub you passed as a **parameter**                 | Dispose your copy; the callee's copy is auto-disposed. |
| A stub received as a **parameter**, needed later     | `.dup()` it, then dispose the duplicate later.         |
| A promise you will never await                       | Dispose it (or use `using`).                           |
| A property of a stub or promise                      | Nothing; dispose the parent.                           |
| Anything, in an HTTP batch                           | Nothing; the batch end disposes everything.            |

[Full rules](/concepts/disposal/)

## Value types on the wire

**By value:** primitives, plain objects, arrays, `bigint`, `Date`, `ArrayBuffer`, `DataView`, typed
arrays, `Error` and well-known subclasses, `Blob`, `ReadableStream`, `WritableStream`, `URL`,
`RegExp`, `Headers`, `Request`, `Response`.

**By reference:** `RpcTarget` subclasses, functions, existing stubs and promises.

**Not supported:** `Map`, `Set` (not yet); non-`RpcTarget` classes and cyclic values
(intentionally).

[Docs](/concepts/values/)
