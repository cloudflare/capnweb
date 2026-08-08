---
title: Workers RPC Interop
description: How Cap'n Web interoperates with the RPC system built into the Cloudflare Workers Runtime, and where the two still differ.
---

Cap'n Web works on any JavaScript platform. But on Cloudflare Workers specifically, it's designed to
play nicely with [the built-in RPC system](https://blog.cloudflare.com/javascript-native-rpc/).

The two have basically the same semantics. The only fundamental difference is that Workers RPC is a
built-in API provided by the Workers Runtime, whereas Cap'n Web is implemented in pure JavaScript.

## What interoperates

- On Workers, the `RpcTarget` class exported by `capnweb` is just an **alias of the built-in one**,
  so you can use them interchangeably.
- RPC stubs and promises originating from one RPC system can be **passed over the other**. This
  automatically sets up proxying.
- You can also send Workers **Service Bindings** and **Durable Object stubs** over Cap'n Web; again,
  this sets up proxying.

So basically, it "just works".

```ts
import { RpcTarget, newWorkersRpcResponse } from 'capnweb';

export class Api extends RpcTarget {
  constructor(private env: Env) {
    super();
  }

  // Hand a browser client a capability backed by a Durable Object.
  getRoom(name: string) {
    let id = this.env.ROOMS.idFromName(name);
    return this.env.ROOMS.get(id); // a DO stub, proxied over Cap'n Web
  }
}
```

## Compatibility date

For best compatibility, set your
[Workers compatibility date](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
to at least `2026-01-20`, or enable the
[compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
`rpc_params_dup_stubs`.

This aligns the Workers Runtime with Cap'n Web's stub ownership rules for call parameters.

## Where they still differ

As of this writing the feature set is not exactly the same between the two. We aim to fix this over
time, by adding missing features to both sides until they match.

Expect Cap'n Web to run ahead. It is a library rather than a runtime built-in, so it can ship a new
idea in a version bump instead of a compatibility flag, and that makes it the natural place to
experiment. `.map()` is the current example: it exists in Cap'n Web and is on the list for Workers
RPC. The intent is that the two converge, with Cap'n Web arriving first.

| Capability                                  | Cap'n Web | Workers RPC |
| ------------------------------------------- | --------- | ----------- |
| `Map`, `Set`, and some other built-ins      | Not yet   | Yes         |
| Values containing aliases and cycles        | No        | Yes\*       |
| `RpcPromise` in the parameters of a request | Yes       | Not yet     |
| The magic `.map()` method                   | Yes       | Not yet     |

\* Workers RPC supports sending values that contain aliases and cycles. This can cause problems, so
we plan to **remove** this feature from Workers RPC, with a compatibility flag, of course.

## Ownership differences

:::caution
The ownership behaviour of calls differs from the original behaviour in the native RPC
implementation built into the Workers Runtime. In the original Workers behaviour, the callee loses
ownership of stubs passed in a call's parameters.

We plan to change the Workers Runtime to match Cap'n Web's behaviour, as the original has proven
more problematic than helpful. See [Disposal](/concepts/disposal/) for the rules Cap'n Web uses.
:::

## When to use which

- **Worker-to-Worker or Worker-to-Durable-Object**, inside Cloudflare: use built-in Workers RPC. It
  is faster and needs no library.
- **Browser-to-Worker**, or anything crossing the public internet: use Cap'n Web. Workers RPC does
  not speak to browsers.
- **Both**: mix freely. Stubs cross the boundary and Cap'n Web proxies them.
