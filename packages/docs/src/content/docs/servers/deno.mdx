---
title: Deno
description: Serve Cap'n Web from Deno.serve, handling both HTTP batch and WebSocket upgrades.
sidebar:
  order: 3
---

Import the package with the `npm:` specifier and use the standard Fetch-API helpers.

```ts
import {
  newHttpBatchRpcResponse,
  newWebSocketRpcSession,
  RpcTarget,
} from 'npm:capnweb';

// This is the server implementation.
class MyApiImpl extends RpcTarget implements MyApi {
  // ... define API, same as above ...
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === '/api') {
    if (req.headers.get('upgrade') === 'websocket') {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.addEventListener('open', () => {
        newWebSocketRpcSession(socket, new MyApiImpl());
      });
      return response;
    } else {
      const response = await newHttpBatchRpcResponse(req, new MyApiImpl());
      // If you are accepting WebSockets, then you might as well accept
      // cross-origin HTTP, since WebSockets always permit cross-origin requests
      // anyway. But see security considerations for further discussion.
      response.headers.set('Access-Control-Allow-Origin', '*');
      return response;
    }
  }

  return new Response('Not Found', { status: 404 });
});
```

:::note
Start the RPC session from the `open` event, not immediately after `upgradeWebSocket()`. The socket
is not ready to send until then.
:::

Run it with network permission:

```sh
deno run --allow-net server.ts
```
