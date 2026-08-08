# Cap'n Web: A JavaScript-native RPC system

Cap'n Web is a spiritual sibling to [Cap'n Proto](https://capnproto.org) (and is created by the
same author), but designed to play nice in the web stack. That means:

* Like Cap'n Proto, it is an **object-capability protocol**. ("Cap'n" is short for "capabilities
  and.") It's incredibly powerful.
* Unlike Cap'n Proto, Cap'n Web has **no schemas**. In fact, it has almost no boilerplate
  whatsoever. This means it works more like the
  [JavaScript-native RPC system in Cloudflare Workers](https://blog.cloudflare.com/javascript-native-rpc/).
* That said, it integrates nicely with TypeScript.
* Also unlike Cap'n Proto, Cap'n Web's underlying serialization is **human-readable**. It's just
  JSON, with a little pre- and post-processing.
* It works over HTTP, WebSocket, and `postMessage()` out of the box, and can be extended to other
  transports easily.
* It works in all major browsers, Cloudflare Workers, Node.js, Bun, Deno, and other modern
  JavaScript runtimes.

The whole thing compresses (minify + gzip) to **under 10 kB with no dependencies**.

Cap'n Web is more expressive than almost every other RPC system, because it implements an
object-capability RPC model. That means it supports **bidirectional calling**, **passing functions
and objects by reference**, **promise pipelining** (chaining dependent calls into a single network
round trip), and **capability-based security patterns**, where holding a reference *is* the
permission to use it.

## Installation

[Cap'n Web is an npm package.](https://www.npmjs.com/package/capnweb)

```
npm i capnweb
```

There is no build step, no schema compiler, and no code generation.

```js
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
```

To use `using` declarations, your `tsconfig.json` needs `"target": "esnext"` and matching `lib`s.
See [Installation](packages/docs/src/content/docs/start/installation.md).

## Example

A client looks like this:

```js
import { newWebSocketRpcSession } from "capnweb";

// One-line setup.
let api = newWebSocketRpcSession("wss://example.com/api");

// Call a method on the server!
let result = await api.hello("World");

console.log(result);
```

Here's the server:

```js
import { RpcTarget, newWorkersRpcResponse } from "capnweb";

// This is the server implementation.
class MyApiServer extends RpcTarget {
  hello(name) {
    return `Hello, ${name}!`
  }
}

// Standard Cloudflare Workers HTTP handler.
//
// (Node, Deno, Bun and other runtimes are supported too.)
export default {
  fetch(request, env, ctx) {
    // Parse URL for routing.
    let url = new URL(request.url);

    // Serve API at `/api`.
    if (url.pathname === "/api") {
      return newWorkersRpcResponse(request, new MyApiServer());
    }

    // You could serve other endpoints here...
    return new Response("Not found", {status: 404});
  }
}
```

And here is the part that makes it interesting. Three dependent calls, one round trip:

```ts
using api = newHttpBatchRpcSession<Api>("https://example.com/api");

// No awaits, so no round trips yet.
using authed = api.authenticate(apiToken);
let friendIds = authed.getFriendIds();

// One await. One round trip. Everything above travelled together.
let friends = await friendIds.map(id => api.getUserProfile(id));
```

## Documentation

**The [documentation site](packages/docs/) is the source of truth.** It is an Astro + Starlight site
under [`packages/docs/`](packages/docs/), and every page is readable as Markdown directly on GitHub.

Start here:

| Page | What it covers |
| --- | --- |
| [Introduction](packages/docs/src/content/docs/start/introduction.md) | What Cap'n Web is and why object capabilities matter |
| [Quickstart](packages/docs/src/content/docs/start/quickstart.md) | A working client and server |
| [Pipelining tour](packages/docs/src/content/docs/start/pipelining-tour.md) | The part that makes it fast |
| [How it compares](packages/docs/src/content/docs/guides/comparisons.md) | Against tRPC, JSON-RPC, GraphQL and Cap'n Proto |

Core concepts:
[What can be passed](packages/docs/src/content/docs/concepts/values.md) ·
[RpcTarget](packages/docs/src/content/docs/concepts/rpc-target.md) ·
[RpcStub](packages/docs/src/content/docs/concepts/stubs.md) ·
[RpcPromise & pipelining](packages/docs/src/content/docs/concepts/promises.md) ·
[The magic `map()`](packages/docs/src/content/docs/concepts/map.md) ·
[Streaming](packages/docs/src/content/docs/concepts/streaming.md) ·
[Disposal](packages/docs/src/content/docs/concepts/disposal.md)

Transports:
[Overview](packages/docs/src/content/docs/transports/index.md) ·
[HTTP batch](packages/docs/src/content/docs/transports/http-batch.md) ·
[WebSocket](packages/docs/src/content/docs/transports/websocket.md) ·
[MessagePort](packages/docs/src/content/docs/transports/message-port.md) ·
[Custom](packages/docs/src/content/docs/transports/custom.md)

Server runtimes:
[Cloudflare Workers](packages/docs/src/content/docs/servers/workers.md) ·
[Node.js](packages/docs/src/content/docs/servers/node.md) ·
[Deno](packages/docs/src/content/docs/servers/deno.md) ·
[Bun](packages/docs/src/content/docs/servers/bun.md) ·
[Hono](packages/docs/src/content/docs/servers/hono.md) ·
[Other](packages/docs/src/content/docs/servers/other.md)

Guides and reference:
[Security considerations](packages/docs/src/content/docs/guides/security.md) ·
[Sessions & reconnection](packages/docs/src/content/docs/guides/sessions.md) ·
[Runtime validation](packages/docs/src/content/docs/guides/validation.md) ·
[Workers RPC interop](packages/docs/src/content/docs/guides/workers-rpc.md) ·
[Wire protocol](packages/docs/src/content/docs/reference/protocol.md) ·
[API cheat sheet](packages/docs/src/content/docs/reference/api.md)

To run the site locally, with both examples embedded as live in-browser playgrounds:

```
cd packages/docs && npm install && npm run dev
```

## Examples

Runnable examples live in [`examples/`](examples/):

* [`batch-pipelining`](examples/batch-pipelining/): three dependent calls in one HTTP round trip.
* [`worker-react`](examples/worker-react/): a React app against a Cap'n Web Worker, with runtime
  validation at the RPC boundary.

## Related packages

* [`capnweb-validate`](packages/capnweb-validate/): generates runtime validators from your
  TypeScript types at build time, since TypeScript types are erased and a malicious peer can send
  anything.

## Security

Cap'n Web gives you strong authorization tools, but a few things are your responsibility:
authenticating in-band rather than with cookies, rate-limiting because pipelining is cheap for
attackers, setting transport payload limits, and validating types at runtime. Read
[Security considerations](packages/docs/src/content/docs/guides/security.md) before exposing a
service to untrusted peers.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Bug reports and pull requests are welcome. Note that `packages/docs/` is the source of truth for
user-facing documentation; behaviour changes should update the relevant page there.

## License

[MIT](LICENSE.txt)
