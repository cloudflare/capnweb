---
title: Introduction
description: What Cap'n Web is, how it relates to Cap'n Proto, and why object-capability RPC makes it more expressive than most RPC systems.
---

Cap'n Web is a spiritual sibling to [Cap'n Proto](https://capnproto.org) (and is created by the
same author), but designed to play nice in the web stack. That means:

- Like Cap'n Proto, it is an **object-capability protocol**. ("Cap'n" is short for "capabilities
  and.") It's incredibly powerful, and we get into it below.
- Unlike Cap'n Proto, Cap'n Web has **no schemas**. In fact, it has almost no boilerplate
  whatsoever. This means it works more like the
  [JavaScript-native RPC system in Cloudflare Workers](https://blog.cloudflare.com/javascript-native-rpc/).
- That said, it integrates nicely with TypeScript.
- Also unlike Cap'n Proto, Cap'n Web's underlying serialization is **human-readable**. It's just
  JSON, with a little pre- and post-processing.
- It works over HTTP, WebSocket, and `postMessage()` out of the box, and can be extended to other
  transports easily.
- It works in all major browsers, Cloudflare Workers, Node.js, Bun, Deno, and other modern
  JavaScript runtimes.

The whole thing compresses (minify + gzip) to **under 10 kB with no dependencies**.

## Why object-capability RPC

Cap'n Web is more expressive than almost every other RPC system, because it implements an
object-capability RPC model. That means it:

- **Supports bidirectional calling.** The client can call the server, and the server can also call
  the client.
- **Supports passing functions by reference.** If you pass a function over RPC, the recipient
  receives a "stub". When they call the stub, they actually make an RPC back to you, invoking the
  function where it was created. This is how bidirectional calling happens: the client passes a
  callback to the server, and then the server can call it later.
- **Supports passing objects by reference.** If a class extends the special marker type
  [`RpcTarget`](/concepts/rpc-target/), then instances of that class are passed by reference, with
  method calls calling back to the location where the object was created.
- **Supports promise pipelining.** When you start an RPC, you get back a promise. Instead of
  awaiting it, you can immediately use the promise in dependent RPCs, thus performing a chain of
  calls in a single network round trip.
- **Supports capability-based security patterns.** Holding a reference *is* the permission to use
  it, which makes authorization patterns fall out naturally.

## How it compares

|                        | Cap'n Web                          | Cap'n Proto                     |
| ---------------------- | ---------------------------------- | ------------------------------- |
| Schemas                | None                               | `.capnp` schema language        |
| Codegen                | None                               | Required                        |
| Serialization          | JSON (human-readable)              | Binary, zero-copy               |
| Object capabilities    | Yes                                | Yes                             |
| Promise pipelining     | Yes                                | Yes                             |
| Primary home           | The web stack                      | C++ and systems software        |

Cap'n Web is *not* a port of Cap'n Proto, and the two do not interoperate on the wire. They share
a model, an author, and a sense of humour.

## Where to next

- [Installation](/start/installation/) — one npm package, no build step.
- [Quickstart](/start/quickstart/) — a working client and server.
- [Pipelining tour](/start/pipelining-tour/) — the part that makes it fast.
