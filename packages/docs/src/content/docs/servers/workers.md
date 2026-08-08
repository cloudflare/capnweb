---
title: Cloudflare Workers
description: Serve Cap'n Web from a Worker with newWorkersRpcResponse, handling HTTP batch and WebSocket at once.
---

The helper function `newWorkersRpcResponse()` makes it easy to implement an HTTP server that accepts
both the HTTP batch and WebSocket APIs at once.

```ts
import { RpcTarget, newWorkersRpcResponse } from 'capnweb';

// Define our server implementation.
class MyApiImpl extends RpcTarget implements MyApi {
  constructor(private userInfo: UserInfo) {}

  getUserInfo(): UserInfo {
    return this.userInfo;
  }

  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

// Define our Worker HTTP handler.
export default {
  fetch(request: Request, env, ctx) {
    let userInfo: UserInfo = authenticateFromCookie(request);
    let url = new URL(request.url);

    // Serve API at `/api`.
    if (url.pathname === '/api') {
      return newWorkersRpcResponse(request, new MyApiImpl(userInfo));
    }

    return new Response('Not found', { status: 404 });
  },
};
```

That single call handles content negotiation: a normal POST is treated as an
[HTTP batch](/transports/http-batch/), and an upgrade request becomes a
[WebSocket session](/transports/websocket/).

:::caution
Authenticating from a cookie works for HTTP batch, but browsers do not send custom headers on
WebSocket connections and always allow cross-site WebSocket connections. For anything reachable by
WebSocket, authenticate in-band instead. See [Security considerations](/guides/security/).
:::

## Compatibility with Workers' built-in RPC

Cloudflare Workers has long featured
[a built-in RPC system with semantics similar to Cap'n Web](https://developers.cloudflare.com/workers/runtime-apis/rpc/).

Cap'n Web is designed to be compatible with it: you can pass Cap'n Web RPC stubs over Workers RPC
and vice versa, and the system automatically wraps one stub type in the other and arranges to proxy
calls.

For best compatibility, set your
[compatibility date](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
to at least `2026-01-20`, or enable the
[compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
`rpc_params_dup_stubs`.

```jsonc
// wrangler.jsonc
{
  "name": "my-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-20",
  // Or, until that date is reachable:
  // "compatibility_flags": ["rpc_params_dup_stubs"]
}
```

See [Workers RPC interop](/guides/workers-rpc/) for the full feature comparison.

## CPU limits

Pipelining lets a client enqueue a lot of work in one message. Consider configuring
[per-request CPU limits](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
lower than the default 30s.

Note that in stateless Workers (that is, not Durable Objects), the system considers an entire
WebSocket session to be one "request" for CPU limit purposes.

```jsonc
// wrangler.jsonc
{
  "limits": { "cpu_ms": 5000 }
}
```

## Durable Objects

For stateful sessions such as chat rooms, collaborative documents, or anything where clients need
to reach the *same* server object, route the WebSocket to a Durable Object and start the session
there. The Durable Object's `fetch()` can call `newWorkersRpcResponse()` exactly the same way.
