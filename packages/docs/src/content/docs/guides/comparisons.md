---
title: How It Compares
description: Cap'n Web against tRPC, JSON-RPC, GraphQL, Cap'n Proto and the older distributed-object systems, including the things it deliberately does not do.
---

Cap'n Web claims to be more expressive than most RPC systems. This page is the receipt: what that
buys you against each of the usual alternatives, and where the claim runs out.

## vs. tRPC, oRPC, and friends

[tRPC](https://trpc.io/), [oRPC](https://orpc.unnoq.com/) and similar libraries share a lot with
Cap'n Web: TypeScript types as the contract, no code generation, no schema language. The difference
is what a call can *return*.

|                                   | Cap'n Web | Typical TS RPC library     |
| --------------------------------- | --------- | -------------------------- |
| TypeScript types as the contract  | Yes       | Yes                        |
| No codegen                        | Yes       | Yes                        |
| Return an **object** by reference | Yes       | No, results are plain data |
| Pass a **function** by reference  | Yes       | No                         |
| Server calls the client           | Yes       | Subscriptions only         |
| Dependent calls in one round trip | Yes       | No                         |
| Reference lifetime management     | Yes       | N/A                        |

Those libraries can batch calls, but batching and pipelining solve different problems. Batching
combines calls that are **independent**: you already know all the arguments. Pipelining combines
calls that are **dependent**, where the argument to the second call is the result of the first.
That is the case that otherwise forces a round trip, and it is the case
[`.map()`](/concepts/map/) and [`RpcPromise`](/concepts/promises/) exist to collapse.

## vs. JSON-RPC

[JSON-RPC](https://www.jsonrpc.org/specification) is also JSON over any transport, and it also
supports notifications in both directions. What it has no concept of:

- **Pass-by-reference.** Every JSON-RPC method is addressed by a global name and every argument is
  plain data. There is no way to hand the other side a reference to one particular object and let
  them call methods on it, which is the whole basis of
  [capability-based authorization](/guides/security/).
- **Lifetime management.** Nothing in JSON-RPC tracks that you are holding something the peer must
  keep alive, so there is nothing to release. Cap'n Web has
  [import/export tables and disposal](/concepts/disposal/).
- **Pipelining.** No way to refer to the result of a call you have not received yet.

Cap'n Web's closest relative is not JSON-RPC but CapTP, the object-capability protocol family that
[Cap'n Proto](https://capnproto.org) also belongs to.

## vs. GraphQL, and the N+1 question

GraphQL and Cap'n Web attack the same problem from opposite ends. GraphQL gives the client a query
language so it can describe a whole dependent graph in one request. Cap'n Web gives the client
promise pipelining so it can *write ordinary code* that happens to produce one request.

The comparison is aggressive, though, and it breaks down in places.

:::caution[`.map()` does not remove N+1; it relocates it]
Pipelining collapses **network** round trips. It does not collapse **database** queries.

```ts
// One network round trip. Still N+1 queries on the server.
let names = await api.listUserIds().map(id => api.getUserName(id));
```

The client waits once instead of N+1 times, which is a real and often dominant win. But the server
still runs one `listUserIds` query and N `getUserName` queries.
:::

Things GraphQL has that Cap'n Web does not:

- **A DataLoader equivalent.** There is no built-in batching or per-request caching layer to fold
  those N queries into one. If you need that, expose a method that takes the whole array and does a
  single `WHERE id IN (...)`, then call *that* from the map callback.
- **Query cost analysis.** A GraphQL server can inspect a query and reject it as too expensive
  before executing any of it. Cap'n Web has no query planner, so there is nothing to analyse. Rate
  limiting is your job. See [Security considerations](/guides/security/).

Where the problem genuinely disappears is when a "query" is not a network hop at all. With SQLite
embedded in a [Durable Object](/servers/workers/), the database is in the same process as your
code, and the
[N+1 problem largely stops being a problem](https://www.sqlite.org/np1queryprob.html).

The two ideas are also not mutually exclusive. Nothing stops you exposing a GraphQL-style
`query(document)` method over a Cap'n Web session, or using Cap'n Web for the interactive,
capability-bearing parts of an app and GraphQL for the reporting queries.

## vs. Cap'n Proto, and using Cap'n Web from other languages

Cap'n Web is **deliberately scoped to JavaScript and TypeScript.** It is not a port of Cap'n Proto
and the two do not interoperate on the wire. See
[the comparison table in the introduction](/start/introduction/#how-it-compares).

If your backend is not JavaScript, the answer today is to use Cap'n Proto instead. It is the same
object-capability model with the same promise pipelining, plus schemas and code generation for a
long list of languages. A proxy that translated between the two given a Cap'n Proto schema would be
a lovely thing to have; it does not exist.

### Why not a port?

Cap'n Web's implementation works by walking arbitrary objects at runtime without knowing their
types; that is what lets it serialize anything and forward any call without a schema. That is
natural in a dynamic language and awkward in a static one.

- **Another dynamic language** (Python, Ruby) would probably port fine.
- **A statically-typed language** is much harder, because the type-agnostic object walking has no
  direct equivalent.
- **A shared Rust/WASM core** does not obviously help either. The values Cap'n Web moves are
  JavaScript objects, so such an implementation would spend most of its size marshalling values
  across the JS/WASM boundary, plausibly more code than the entire TypeScript implementation, which
  is [under 10 kB](/start/introduction/) in total.

## Isn't this distributed objects all over again?

CORBA, Java RMI and .NET Remoting all tried to make remote objects work, and all are cautionary
tales. It is a fair challenge, and Cap'n Web is making a specific bet about *why* they failed.

The usual diagnosis is that they tried to make a remote call look exactly like a local call, to
hide the network. That cannot work, because the differences are not cosmetic: remote calls have
latency, they fail independently of your process, and the thing on the other end has a lifetime you
do not control.

Cap'n Web does not hide any of those:

| Reality of the network | How it surfaces in Cap'n Web                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Latency                | Every call returns an [`RpcPromise`](/concepts/promises/). You can see every place you wait.  |
| Partial failure        | A dropped session [breaks every stub](/guides/sessions/) and rejects pending calls.           |
| Remote lifetime        | [Disposal](/concepts/disposal/) is explicit; there is no distributed GC pretending otherwise. |

The second failure was being **synchronous first.** In CORBA a call blocked until it returned, so a
chain of N dependent calls cost N round trips, which made fine-grained object graphs unusable over
a network and pushed everyone toward coarse, chatty-avoiding "service" interfaces. Promise
pipelining inverts that: fine-grained interfaces are the ones that pipeline well.

The third was sheer size. Cap'n Web is a single dependency-free package with a
[wire protocol](/reference/protocol/) you can read in one sitting.

None of this makes distributed systems easy. You still have to decide what happens on reconnect and
how your API evolves (see [Sessions & reconnection](/guides/sessions/)).

## Is it a protocol, or a JavaScript library?

Both. The `capnweb` npm package is one implementation; the [wire protocol](/reference/protocol/) is
a specification you can implement yourself, which is what you would do to build an interoperating
peer.

The protocol is JavaScript-flavoured to roughly the same extent JSON is. Its value types are the
JavaScript built-ins, but nothing about the framing, the import/export tables or the expression
language requires a JavaScript peer.

The one genuinely language-dependent corner is *producing* a [`.map()`](/concepts/map/) recording.
The `["remap", ...]` expression that goes over the wire is plain data, so any implementation can
**evaluate** one. Turning a natural-looking lambda into that data structure is the hard part, and
JavaScript can only do it by [record-replay](/concepts/map/#how-the-heck-does-that-work) because it
cannot reflect on a function body. A language with first-class expression trees, such as C#, could
build the same structure directly from a lambda.
