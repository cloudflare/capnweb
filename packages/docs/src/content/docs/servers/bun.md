---
title: Bun
description: Serve Cap'n Web from Bun.serve using newBunWebSocketRpcHandler.
---

Bun's server-side WebSocket API uses
[callback-based handlers](https://bun.sh/docs/runtime/http/websockets) instead of the standard
`addEventListener` interface. Cap'n Web provides `newBunWebSocketRpcHandler()`, which returns a
handler object you can pass directly to `Bun.serve()`.

```ts
import { RpcTarget, newBunWebSocketRpcHandler, newHttpBatchRpcResponse } from 'capnweb';

class MyApiImpl extends RpcTarget implements MyApi {
  // ... define API, same as above ...
}

// Create a WebSocket handler that manages RPC sessions automatically.
// The callback is invoked once per connection to create a fresh API instance.
let rpcHandler = newBunWebSocketRpcHandler(() => new MyApiImpl());

Bun.serve({
  async fetch(req, server) {
    let url = new URL(req.url);
    if (url.pathname === '/api') {
      // Upgrade WebSocket requests.
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (server.upgrade(req)) return;
        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Handle HTTP batch requests.
      let response = await newHttpBatchRpcResponse(req, new MyApiImpl());
      response.headers.set('Access-Control-Allow-Origin', '*');
      return response;
    }

    return new Response('Not Found', { status: 404 });
  },

  // Pass the handler directly -- no manual wiring needed.
  websocket: rpcHandler,
});
```

Note that the callback passed to `newBunWebSocketRpcHandler()` runs **once per connection**, so each
client gets its own API instance. That is usually what you want: per-connection state such as
authentication lives naturally on that instance.

## Payload limits

Bun's `Bun.serve()` accepts `maxPayloadLength` in its `websocket` options. Set it when exposed to
untrusted peers — see [Security considerations](/guides/security/).
