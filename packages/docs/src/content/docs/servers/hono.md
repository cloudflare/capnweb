---
title: Hono
description: Use the @hono/capnweb middleware to mount a Cap'n Web endpoint in a Hono app.
---

If your app is built on [Hono](https://hono.dev/), on any runtime it supports, check out
[`@hono/capnweb`](https://github.com/honojs/middleware/tree/main/packages/capnweb).

```sh
npm i @hono/capnweb
```

The middleware mounts a Cap'n Web endpoint on a route in your existing Hono app, so your RPC API can
live alongside your regular HTTP routes and share the same middleware stack for logging, CORS, and
so on.

Refer to the
[`@hono/capnweb` README](https://github.com/honojs/middleware/tree/main/packages/capnweb) for
current usage and options; it is maintained in the Hono middleware repository, not here.

## Rolling your own

If you'd rather not add a dependency, Hono handlers receive standard `Request` objects and return
standard `Response` objects, so the generic Fetch-API helpers work directly:

```ts
import { Hono } from 'hono';
import { RpcTarget, newHttpBatchRpcResponse } from 'capnweb';

class MyApiImpl extends RpcTarget {
  greet(name: string) {
    return `Hello, ${name}!`;
  }
}

const app = new Hono();

app.post('/api', (c) => newHttpBatchRpcResponse(c.req.raw, new MyApiImpl()));

export default app;
```

WebSocket support depends on the runtime you deploy Hono to. See
[Cloudflare Workers](/servers/workers/), [Node.js](/servers/node/), [Deno](/servers/deno/), or
[Bun](/servers/bun/).
