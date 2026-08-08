---
title: Security Considerations
description: Authentication over WebSocket, denial-of-service from pipelining, payload limits, and why types are not validation.
---

Cap'n Web is an object-capability system, which gives you strong tools for authorization, but there
are a handful of things you must get right yourself.

## Authenticate in-band, not with cookies

The WebSocket API in browsers always permits cross-site connections, and does not permit setting
headers. Because of this, you generally **cannot use cookies nor other headers for
authentication.**

Instead, we highly recommend authenticating in-band, via an RPC method that returns the
authenticated API:

```ts
interface PublicApi {
  // Authenticate the API token, and return the authenticated API.
  authenticate(apiToken: string): AuthedApi;

  // Doesn't require authentication.
  getUserProfile(userId: string): Promise<UserProfile>;
}
```

```ts
// The client never gets an AuthedApi without presenting a valid token.
using api = newWebSocketRpcSession<PublicApi>('wss://example.com/api');
using authed = api.authenticate(apiToken);
```

On the server, `authenticate()` checks the credential once and returns a **new object holding the
result**:

```ts
class PublicApi extends RpcTarget {
  authenticate(apiToken: string): AuthedApi {
    let user = verifyToken(apiToken);    // throws if invalid
    return new AuthedApi(user);
  }
}

class AuthedApi extends RpcTarget {
  constructor(private user: User) { super(); }

  // No token, no re-check. Holding this object is the proof.
  getUserId() { return this.user.id; }
}
```

This is the object-capability pattern doing real work: the returned `AuthedApi` stub *is* the
authorization. There is no ambient authority to confuse, and no way to call an authenticated method
without holding the capability. Thanks to [pipelining](/concepts/promises/), it also costs no extra
round trip.

Yes, this means the server holds state, but only in memory, and only for the lifetime of that one
session: the WebSocket connection, or the single HTTP batch. Nothing is persisted, and there is no
session store to secure or expire. See [Sessions & reconnection](/guides/sessions/).

## Rate-limit, because pipelining is cheap for attackers

Cap'n Web's pipelining can make it easy for a malicious client to enqueue a large amount of work to
occur on a server, in a single message.

To mitigate this, implement **rate limits on expensive operations**. Note that limits applied by a
load balancer or gateway will not help here: they count requests or frames, and pipelining makes
one frame arbitrarily expensive. The limit has to live in the application.

Two amplifiers worth knowing about:

- **Nested `.map()` multiplies.** A map over N elements whose callback maps over M produces N × M
  server-side calls from one client message. Unbounded *recursion* is less dangerous than it looks:
  [the recording is built on the caller's stack](/concepts/map/#nesting-and-recursion), so a runaway
  callback overflows the client first. But a deliberately crafted deep recording is not
  self-limiting.
- **Un-awaited calls accumulate.** Every outstanding promise and every stub the peer holds pins an
  entry in your export table, and the object behind it, for the life of the session. A peer that
  never settles or disposes anything grows your memory monotonically.

  There is no library setting for this. `RpcSessionOptions.limits` covers message size, nesting
  depth and bigint digits (not reference counts), so if you need a bound on how much one session
  can pin, you have to enforce it in your own code. Attaching disposers to the objects you return
  gives you something to count.

If using Cloudflare Workers, also consider configuring
[per-request CPU limits](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
to be lower than the default 30s. Note that in stateless Workers (that is, not Durable Objects),
the system considers an entire WebSocket session to be one "request" for CPU limit purposes.

## Set transport payload limits

Cap'n Web applies receiver-side resource limits before expensive message processing, including a
maximum incoming message size before `JSON.parse`.

If your app is exposed to untrusted peers, **also configure native transport or socket payload
limits where available**:

| Runtime           | Option                                           |
| ----------------- | ------------------------------------------------ |
| Node.js `ws`      | `new WebSocketServer({ maxPayload })`            |
| Bun               | `Bun.serve({ websocket: { maxPayloadLength } })` |
| Browsers / others | The runtime's built-in WebSocket cap             |

Cap'n Web's own check runs *after* `RpcTransport.receive()` has returned a complete message string,
so transport-level limits are still the first line of defence against buffering very large frames.

## Types are not validation

Cap'n Web currently does not provide any runtime type checking. When using TypeScript, keep in mind
that **types are checked only at compile time**. A malicious client can send types you did not
expect, and this could cause your application to behave in unexpected ways.

For example, MongoDB uses special property names to express queries; placing attacker-provided
values directly into queries can result in query injection vulnerabilities, similar to SQL
injection. Of course, JSON has always had the same problem, and there exists tooling to solve it.

Consider a runtime type-checking framework like [Zod](https://zod.dev/), or the companion package
[`capnweb-validate`](/guides/validation/), which generates validators from your TypeScript types at
build time. In the future we hope to explore auto-generating type-checking code based on TypeScript
types in the core library.

Can a peer pass a callback where you declared a `string`? Yes. It will arrive as an `RpcStub`, your
code will do something surprising with it, and TypeScript will have told you nothing. Validate at
the boundary.

### What the protocol does guarantee

Type confusion is your problem, but prototype pollution is not. The protocol hardens two things
regardless of what you do:

- **`Object.prototype` members are unreachable.** Any property name that exists on
  `Object.prototype` (`constructor`, `__proto__`, `valueOf`, `hasOwnProperty` and friends) is
  blocked both when resolving a property path and when deserializing an object literal. This holds
  even if the target object has legitimately overridden the name.
- **`toJSON` is stripped on the way in.** It is not an `Object.prototype` member, but it would let a
  peer influence how your values serialize, so an incoming object carrying one has it removed. Note
  that this applies to deserialization only, not to property paths.
- **Array paths accept only non-negative integer indices**, matching what serialization can produce.

What is reachable *on* an object depends on what kind of object it is, and the two rules are
opposites: an `RpcTarget` exposes its **prototype** members and explicitly refuses instance
properties, while a plain object exposes its **own** properties only. That distinction decides where
it is safe to put a secret, so read [RpcTarget](/concepts/rpc-target/) rather than guessing.

## `private` and `.map()`

**`private` is not private.** TypeScript's `private` is erased at runtime and does not hide a method
from RPC. Use `#`-prefixed names for genuinely private members. See
[RpcTarget](/concepts/rpc-target/).

**Stubs captured by `.map()` are handed to the peer.** Any stubs you use in a `.map()` callback, and
any parameters you pass to them, are sent to the peer, and a malicious peer can use them for
anything, not just calling your callback. Typically it only makes sense to invoke stubs that came
from that same peer originally. See [The magic `map()`](/concepts/map/).

## Reporting vulnerabilities

Please report security issues in Cap'n Web according to the
[project's security policy](https://github.com/cloudflare/capnweb/blob/main/SECURITY.md).
