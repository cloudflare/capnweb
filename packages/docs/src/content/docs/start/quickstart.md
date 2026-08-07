---
title: Quickstart
description: Build a working Cap'n Web client and server, first in plain JavaScript and then with TypeScript types.
---

Let's build the smallest useful Cap'n Web service, then add types.

## A client

```js
import { newWebSocketRpcSession } from 'capnweb';

// One-line setup.
let api = newWebSocketRpcSession('wss://example.com/api');

// Call a method on the server!
let result = await api.hello('World');

console.log(result);
```

There is no client generation and no interface registration. `api` is a *stub*: a `Proxy` that
appears to have every possible method. Calling one sends an RPC.

## A server

```js
import { RpcTarget, newWorkersRpcResponse } from 'capnweb';

// This is the server implementation.
class MyApiServer extends RpcTarget {
  hello(name) {
    return `Hello, ${name}!`;
  }
}

// Standard Cloudflare Workers HTTP handler.
//
// (Node and other runtimes are supported too.)
export default {
  fetch(request, env, ctx) {
    // Parse URL for routing.
    let url = new URL(request.url);

    // Serve API at `/api`.
    if (url.pathname === '/api') {
      return newWorkersRpcResponse(request, new MyApiServer());
    }

    // You could serve other endpoints here...
    return new Response('Not found', { status: 404 });
  },
};
```

Extending [`RpcTarget`](/concepts/rpc-target/) is what makes the object available over RPC. Callers
can invoke its prototype methods and getters, but not its instance properties.

See [Server runtimes](/servers/workers/) for Node.js, Deno, Bun, and Hono equivalents.

## Adding types

You don't *have to* declare your interface separately — the client could just use
`import("./server").ApiServer` as the type. But a shared types file is often cleaner:

```ts
// shared/api.ts
interface PublicApi {
  // Authenticate the API token, and return the authenticated API.
  authenticate(apiToken: string): AuthedApi;

  // Get a given user's public profile info. (Doesn't require authentication.)
  getUserProfile(userId: string): Promise<UserProfile>;
}

interface AuthedApi {
  getUserId(): number;

  // Get the user IDs of all the user's friends.
  getFriendIds(): number[];
}

type UserProfile = {
  name: string;
  photoUrl: string;
};
```

On the server, implement the interface as an `RpcTarget`:

```ts
import { newWorkersRpcResponse, RpcTarget } from 'capnweb';

class ApiServer extends RpcTarget implements PublicApi {
  // ... implement PublicApi ...
}

export default {
  async fetch(req, env, ctx) {
    // ... same as previous example ...
  },
};
```

On the client, the stub is fully typed — you get compile-time checking and autocomplete, even
though nothing was generated:

```ts
import { newWebSocketRpcSession } from 'capnweb';

using api = newWebSocketRpcSession<PublicApi>('wss://example.com/api');

using authed = api.authenticate(apiToken);
let userId: number = await authed.getUserId();
```

:::caution
TypeScript types are erased at runtime. A malicious client can send values of types you did not
expect. See [Security considerations](/guides/security/) and
[Runtime validation](/guides/validation/).
:::

## Which transport?

| You want                                        | Use                                                     |
| ----------------------------------------------- | ------------------------------------------------------- |
| A burst of calls, then done                     | [HTTP batch](/transports/http-batch/)                    |
| A long-lived session, server-initiated calls    | [WebSocket](/transports/websocket/)                      |
| Talk to a Web Worker or iframe                  | [MessagePort](/transports/message-port/)                 |
| Something else entirely                         | [Custom transport](/transports/custom/)                  |

## Next steps

- [Pipelining tour](/start/pipelining-tour/) — do all of the above in one round trip.
- [What can be passed](/concepts/values/) — the type system on the wire.
- [Disposal](/concepts/disposal/) — the one piece of bookkeeping Cap'n Web asks of you.
