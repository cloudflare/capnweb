---
title: The magic map()
description: Transform a remote value in place with .map(), the rules it imposes, and the record-replay mechanism that makes it possible.
---

Every RPC promise has a special method `.map()` which can be used to remotely transform a value,
without pulling it back locally.

```ts
// Get a list of user IDs.
let idsPromise = api.listUserIds();

// Look up the username for each one.
let names = await idsPromise.map(id => [id, api.getUserName(id)]);
```

This calls one API method to get a list of user IDs, then, for each user ID in the list, makes
another RPC call to look up the user's name, producing a list of id/name pairs.

**All this happens in a single network round trip.**

## Semantics

`promise.map(func)` transfers a representation of `func` to the peer, where it is executed on the
promise's result. Specifically:

- If the promise resolves to an **array**, the mapper executes on each element. The overall `.map()`
  returns a promise for an array of the results.
- If the promise resolves to **`null` or `undefined`**, the mapper is not executed at all. The
  result is the same value.
- If the promise resolves to **any other value**, the mapper executes once on that value, returning
  the result.

So `map()` handles both arrays and nullable values — it doubles as an "optional chaining" operator
across the network.

## Restrictions

:::caution
- The callback must have **no side effects** other than calling RPCs.
- The callback must be **synchronous**. It cannot await anything.
- The input to the callback is an `RpcPromise`, so the callback cannot actually operate on it, other
  than to invoke its RPC methods, or use it in the params of other RPC methods.
- Any stubs you use in the callback — and any parameters you pass to them — **will be sent to the
  peer**. A malicious peer can use these stubs for anything, not just calling your callback.
  Typically it only makes sense to invoke stubs that came from the same peer originally, since that
  is what saves the round trip.
:::

Because the callback's input is an opaque promise, you cannot branch on it:

```ts
// ❌ Doesn't do what you want: `id` is an RpcPromise, always truthy.
ids.map(id => (id > 100 ? api.getBigUser(id) : api.getUser(id)));

// ✅ Do the branching on the server side instead.
ids.map(id => api.getUser(id));
```

## How the heck does that work?

Cap'n Web does **NOT** send arbitrary code over the wire.

The trick is **record-replay**. On the calling side, Cap'n Web invokes your callback once, in a
special "recording" mode, passing in a placeholder stub that records what you do with it. During
that invocation:

- Any RPCs invoked by the callback (on *any* stub) are not actually executed, but recorded as an
  action the callback performs.
- Any stubs you use during the recording are "captured" as well.

Once the callback returns, the recording and the capture list are sent to the peer, where the
recording can be replayed as needed to process individual results.

Since all of the not-yet-determined values seen by the callback are represented as `RpcPromise`s,
the callback's behaviour is deterministic. Any actual computation (arithmetic, branching, etc.)
can't possibly use these promises as meaningful inputs, so it would logically produce the same
result for every invocation. Any such computation ends up being performed on the sending side, just
once, with the results baked into the recording.

The wire format for this is the `["remap", ...]` expression — see the
[protocol reference](/reference/protocol/#remap).
