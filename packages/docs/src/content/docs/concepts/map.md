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

:::danger[Some of this fails loudly. The dangerous half fails silently.]
The callback parameter is typed as a placeholder rather than a value, so TypeScript rejects the more
obvious abuses — but not all of them, and the ones it misses are the quiet ones:

| You wrote            | What actually happens                              | TypeScript |
| -------------------- | -------------------------------------------------- | ---------- |
| `if (id)`            | Always true — every object is truthy                | Compiles   |
| `` `user-${id}` ``   | The string `"user-[object RpcPromise]"`             | Compiles   |
| `id > 100`           | Always false                                        | Error      |
| `[...id]`            | Throws — the placeholder is not iterable            | Error      |

`id.length` is a third case: it is neither an error nor a mistake, because property access on a
placeholder is a legitimate pipelined operation. It just gives you a promise for the length, not a
number you can branch on.

Use TypeScript for `.map()` — and don't assume it caught everything.
:::

Two mistakes are caught at runtime rather than silently:

```ts
// ❌ Throws: "RPC map() callbacks cannot be async."
ids.map(async id => await api.getUser(id));

// ❌ Throws: can't construct an RpcTarget or RPC callback inside a mapper.
ids.map(id => api.subscribe(id, new MyListener()));

// ✅ Create the stub outside, then use it inside.
using listener = new RpcStub(new MyListener());
ids.map(id => api.subscribe(id, listener.dup()));
```

The `.dup()` in that last line is not decoration. Stubs captured by a recording are consumed when
the map completes, so passing `listener` bare leaves your outer stub disposed, and the next thing
you do with it throws `Attempted to use an RPC StubHook after it was disposed.`

## Which side runs what

This is the question that trips people up most, and the answer has two halves:

- **Your JavaScript runs on the calling side, exactly once**, when the recording is made.
- **The RPC calls it recorded run on the receiving side, once per element.**

So local computation is not repeated per element — it is evaluated once and the result is baked
into the recording:

```ts
let n = 0;

ids.map(id => api.log(id, n++, new Date().toISOString()));
```

Every element receives `n === 0` and the *same* timestamp, taken from the **caller's** clock. `n`
ends up as `1`, not `ids.length`. Anything locale- or environment-dependent —
`toLocaleString()`, `Math.random()`, `Date.now()` — samples the calling side once. That is usually
not what you want inside a map, so compute it on the peer instead by calling a method.

RPC calls, including calls on stubs you captured from outside the callback, *do* run once per
element:

```ts
let counter = new RpcStub(new Counter(0));

// counter.increment() is called once per element, not once total.
await ids.map(id => { counter.increment(); return api.getUser(id); });
```

There is also **no index argument.** `.map()` passes one parameter, and TypeScript will reject a
callback that declares two. An index would have to be a promise for the index, which you could not
do arithmetic on anyway. If you need positions, have the peer return them.

## Why only `.map()`?

`.map()` is the only array combinator Cap'n Web special-cases, and that is a deliberate stopping
point rather than a to-do item.

`.map()` works precisely because the common case *does no computation on the values* — it just
pipelines each element into another RPC, which is exactly what a recording can express. `filter()`,
`find()`, `reduce()` and `sort()` all require actually evaluating something about each value, and
the callback never sees values.

Making those work would mean shipping an expression library in the protocol — `eq`, `gt`, `and`,
`not`, arithmetic, and then everything anyone ever wants next. That library would only ever grow,
it would bloat every implementation, and every operator is new surface for a peer to abuse.

The supported answer is to expose the operation as an ordinary RPC method, which you can then call
from inside a map callback:

```ts
// On the server.
class Api extends RpcTarget {
  // Filtering as an explicit method that takes the whole array.
  getActiveUsers(ids: number[]): User[] {
    return ids.map(lookup).filter(u => u.active);
  }
}

// On the client — still one round trip.
using active = await api.getActiveUsers(api.listUserIds());
```

This is better than a generic filter anyway: the server does the work in one query instead of
answering a predicate N times, and you get to name the operation.

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
[protocol reference](/reference/protocol/#remap). Because the recording is data rather than code,
no arbitrary code ever crosses the wire, and a non-JavaScript peer could evaluate one — see
[How it compares](/guides/comparisons/#is-it-a-protocol-or-a-javascript-library).

## Nesting and recursion

`.map()` callbacks may contain further `.map()` calls, and this works exactly as you would hope:

```ts
await api.listTeams().map(team =>
  team.memberIds.map(id => api.getUserName(id)));
```

:::caution
Nesting **multiplies** server-side work. A map over N elements whose callback maps over M produces
N × M calls from a single client message, which is the cheapest denial-of-service in the library.
[Rate-limit expensive operations](/guides/security/#rate-limit-because-pipelining-is-cheap-for-attackers).

Unbounded *recursion* is comparatively harmless: recording happens on the calling side, so an
infinitely recursive callback overflows the caller's own stack before anything is sent. That
protects you from your own bug, not from a peer who crafts a large recording deliberately. Server-side
resource limits remain your responsibility.
:::
