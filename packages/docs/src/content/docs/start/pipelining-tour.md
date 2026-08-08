---
title: Pipelining Tour
description: Chain dependent RPC calls into a single network round trip, including the record-replay trick behind .map().
---

This is the feature that makes Cap'n Web interesting. Read this page and the rest of the library
will make sense.

## The problem

A naive RPC client waits for each result before it can use it. Four dependent calls means four
round trips:

```ts
let authed = await api.authenticate(apiToken);   // round trip 1
let userId = await authed.getUserId();           // round trip 2
let profile = await api.getUserProfile(userId);  // round trip 3
let friends = await authed.getFriendIds();       // round trip 4
```

On a 100 ms link, that's 400 ms of doing nothing.

## The trick

Calling an RPC method returns an [`RpcPromise`](/concepts/promises/), not a regular `Promise`. An
`RpcPromise` is *also a stub for its own eventual result*. So you can call methods on it, read
properties of it, and pass it as an argument to other calls — all before it resolves.

When the peer receives a call whose arguments contain an unresolved promise, it substitutes the
resolved value before delivering the call to your application code.

```ts
import { newHttpBatchRpcSession } from 'capnweb';

let api = newHttpBatchRpcSession<PublicApi>('https://example.com/api');

// Call authenticate(), but don't await it. We can use the returned promise
// to make "pipelined" calls without waiting.
let authedApi: RpcPromise<AuthedApi> = api.authenticate(apiToken);

// Make a pipelined call to get the user's ID. Again, don't await it.
let userIdPromise: RpcPromise<number> = authedApi.getUserId();

// Fetch the user's public profile, based on the user ID. Notice how we can use
// `RpcPromise<T>` anywhere a `T` is expected. The promise will be replaced with
// its resolution before delivering the call.
let profilePromise = api.getUserProfile(userIdPromise);

// Another call to get the user's friends.
let friendsPromise = authedApi.getFriendIds();

// That only returns an array of user IDs, but we want all the profile info too,
// so use the magic .map() function to get them. Still one round trip.
let friendProfilesPromise = friendsPromise.map((id: RpcPromise<number>) => {
  return { id, profile: api.getUserProfile(id) };
});

// Now await. The batch is sent at this point.
let [profile, friendProfiles] = await Promise.all([profilePromise, friendProfilesPromise]);

console.log(`Hello, ${profile.name}!`);
```

Five logical calls, arbitrary depth of dependency, **one round trip**.

:::note
It's important to simultaneously await all promises for which you actually want the result. If you
don't await a promise before the batch is sent, the system detects this and doesn't ask the server
to send the return value back at all — it saves the bandwidth.
:::

## Properties pipeline too

You don't only pipeline calls. You can pipeline into a *property* of a pending result:

```ts
// In a single round trip, authenticate the user and fetch their public profile
// given their ID.
let user = api.authenticate(cookie);
let profile = await api.getUserProfile(user.id);
```

## How `.map()` can possibly work

`friendsPromise.map(...)` applies your callback to a value that doesn't exist yet on the client, and
it does so without sending any code over the wire. Cap'n Web does **not** ship arbitrary code.

The trick is **record-replay**:

1. On the calling side, Cap'n Web invokes your callback once in a special *recording* mode, passing
   a placeholder stub that records what you do with it.
2. During that invocation, any RPCs the callback invokes (on *any* stub) are not executed — they're
   recorded as actions the callback performs. Any stubs used are "captured" as well.
3. The recording plus the capture list is sent to the peer, where it can be replayed as needed for
   each individual result.

Because every not-yet-determined value the callback sees is an `RpcPromise`, the callback's
behaviour is deterministic. Real computation (arithmetic, branching) can't meaningfully consume
those promises, so it must produce the same result on every invocation — and it gets performed once
on the sending side, with the result baked into the recording.

So the split is: **your JavaScript runs on the calling side exactly once; the RPCs it recorded run
on the peer, once per element.** See
[Which side runs what](/concepts/map/#which-side-runs-what) for why that matters, and
[The magic `map()`](/concepts/map/) for the full rules and restrictions.

## With a WebSocket instead

Pipelining is not exclusive to batches. On a long-lived
[WebSocket session](/transports/websocket/) you get the same round-trip savings, but you're free to
await whenever you like:

```ts
using api = newWebSocketRpcSession<PublicApi>('wss://example.com/api');

// Authenticate and get the user ID in one round trip.
using authedApi: RpcPromise<AuthedApi> = api.authenticate(apiToken);
let userId: number = await authedApi.getUserId();

// ... continue calling other methods, now or in the future ...
```

:::caution
Pipelining makes it cheap for a malicious client to enqueue a *lot* of server work in one message.
Rate-limit expensive operations. See [Security considerations](/guides/security/).
:::
