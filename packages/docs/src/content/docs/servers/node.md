---
title: Node.js
description: Serve Cap'n Web from Node's http module, including WebSocket support via the ws package.
---

A server on Node.js is a bit more involved, due to the awkward handling of WebSockets in Node's HTTP
library.

```ts
import http from 'node:http';
import { WebSocketServer } from 'ws'; // npm package
import { RpcTarget, newWebSocketRpcSession, nodeHttpBatchRpcResponse } from 'capnweb';

class MyApiImpl extends RpcTarget implements MyApi {
  // ... define API, same as above ...
}

// Run standard HTTP server on a port.
let httpServer = http.createServer(async (request, response) => {
  if (request.headers.upgrade?.toLowerCase() === 'websocket') {
    // Ignore, should be handled by WebSocketServer instead.
    return;
  }

  // Accept Cap'n Web requests at `/api`.
  if (request.url === '/api') {
    try {
      await nodeHttpBatchRpcResponse(request, response, new MyApiImpl(), {
        // If you are accepting WebSockets, then you might as well accept
        // cross-origin HTTP, since WebSockets always permit cross-origin
        // requests anyway. But see security considerations for discussion.
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    } catch (err) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(err?.stack || err));
    }
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not Found');
});

// Arrange to handle WebSockets as well, using the `ws` package. You can skip
// this if you only want to handle HTTP batch requests.
let wsServer = new WebSocketServer({ server: httpServer });
wsServer.on('connection', (ws) => {
  // The `as any` here is because the `ws` module seems to have its own
  // `WebSocket` type declaration that's incompatible with the standard one. In
  // practice, though, they are compatible enough for Cap'n Web!
  newWebSocketRpcSession(ws as any, new MyApiImpl());
});

// Accept requests on port 8080.
httpServer.listen(8080);
```

## Install the WebSocket dependency

You only need `ws` if you want to accept WebSocket sessions. HTTP batch works with nothing but
`node:http`.

```sh
npm i ws
npm i -D @types/ws
```

## Payload limits

`ws` supports a `maxPayload` option, and you should set it if you are exposed to untrusted peers:

```ts
let wsServer = new WebSocketServer({
  server: httpServer,
  maxPayload: 1024 * 1024, // 1 MiB
});
```

Cap'n Web's own message-size check runs *after* the transport has returned a complete message, so
transport-level limits are the first line of defence. See
[Security considerations](/guides/security/).
