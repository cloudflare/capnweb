---
title: Sessions & Reconnection
description: How long RPC state lives, what a dropped connection destroys, how to reconnect and resume, and how to evolve and scale a Cap'n Web service.
---

Cap'n Web keeps state, but only for the life of one session, and never on disk. Understanding
exactly how long "one session" is answers most operational questions about it.

## Nothing is persistent

Each side of a session maintains [import and export tables](/reference/protocol/) mapping IDs to
live objects. Those tables exist only in memory, only for that session:

| Transport                                  | A session lasts                                     |
| ------------------------------------------ | ---------------------------------------------------- |
| [WebSocket](/transports/websocket/)         | The lifetime of the socket                           |
| [HTTP batch](/transports/http-batch/)       | A single HTTP request/response                       |
| [MessagePort](/transports/message-port/)    | The lifetime of the port                             |

So there is no persistence story, because there is nothing to persist. You do **not** need a
database, a session store, or a serialization format for the tables. You could not write one
anyway. An export ID is a reference to a live object in a live process. Serializing it would be
like serializing a file descriptor.

Server-side state naturally attaches to the objects you export, and dies with them:

```ts
class PublicApi extends RpcTarget {
  authenticate(token: string): AuthedApi {
    let user = verifyToken(token);       // throws if bad
    return new AuthedApi(user);          // state lives on this object
  }
}

class AuthedApi extends RpcTarget {
  constructor(private user: User) { super(); }

  getUserId() { return this.user.id; }   // no token re-check needed
}
```

The client's ability to call `getUserId()` *is* the `AuthedApi` reference it holds. That object
(and the `user` it closed over) lives until the session ends or the client disposes the stub. On an
HTTP batch it lives for a few milliseconds. See
[Security considerations](/guides/security/#authenticate-in-band-not-with-cookies).

## Design for the session going away

Because a session can end at any moment:

:::tip
**It must always be possible to reconnect and reconstruct.** Never design an interaction where
losing the session part-way through leaves the client unable to recover, or the system in a state
nobody can repair.
:::

In practice that means:

- Don't hand out a capability that can only ever be obtained once. If the client's only route to
  some object is a one-shot method, a dropped socket strands them permanently.
- Make mutations idempotent, or give them a client-supplied ID, so a retry after an ambiguous
  failure is safe.
- Anything long-running should be resumable from a checkpoint the client already knows about.

## Reconnecting

Cap'n Web does not reconnect automatically, and it deliberately does not try to re-establish your
stubs for you: it cannot know whether the objects they referred to still make sense.

When a session drops, **every stub from that session is permanently broken.** Pending calls reject,
and new calls on old stubs fail immediately. Detect it with `onRpcBroken`:

```ts
stub.onRpcBroken((error) => {
  console.error('connection lost:', error);
});
```

Recovery means creating a new session and calling the methods again to get fresh objects. The
pattern that makes this bearable is to have exactly one place that owns the root stub, and derive
everything else from it:

```ts
function connect(): RpcStub<PublicApi> {
  return newWebSocketRpcSession<PublicApi>('wss://example.com/api');
}
```

### The React pattern

Hold the root stub in state at the top of the tree and pass it down as a prop. Child components
call the methods they need off that stub rather than storing sub-stubs of their own.

```tsx
function connect(onBroken: () => void): RpcStub<PublicApi> {
  let api = newWebSocketRpcSession<PublicApi>('wss://example.com/api');
  api.onRpcBroken(onBroken);
  return api;
}

function App() {
  let [api, setApi] = useState(() => connect(reconnect));

  function reconnect() {
    // The thunk is load-bearing -- see below.
    setApi(() => connect(reconnect));
  }

  return <Dashboard api={api} />;
}
```

On reconnect you set a *new* root stub, React re-renders the tree, and every child re-derives its
own capabilities from the new session. There is no per-component reconnection logic, and no risk of
a component holding a stub from the previous session.

:::danger[Three things that will bite you here]
**A stub is callable.** `RpcStub` is a `Proxy` whose target is a function, so
`typeof stub === 'function'` is true. React's state setters treat a function argument as an *updater
callback*, which means `setApi(newStub)` calls your stub instead of storing it; because the
call returns an `RpcPromise` rather than throwing, you get a rejected promise in state and no
obvious error. Always `setApi(() => newStub)`.

**Don't dispose the session in an effect cleanup.** Disposing the root stub closes the connection.
React StrictMode runs effects mount → cleanup → mount in development, so a cleanup that disposes
would tear down a session the remounted component then keeps using, and every later call throws.
Tie disposal to real unmount or page unload, not to an effect. (StrictMode also double-invokes
`useState` initializers, so expect one extra socket in development.)

**`onRpcBroken` cannot be unregistered.** It returns nothing, and registering twice on the same stub
fires twice. Register it where the session is created (as `connect()` does above) rather than in
an effect that might re-run.
:::

### Resumable subscriptions

A subscription that just pushes events will silently lose whatever happened while the client was
disconnected. Design the API so the caller can say where it left off:

```ts
interface AuthedApi {
  // Deliver every event after `sinceId`, then keep streaming live ones.
  subscribe(sinceId: string | null, sink: EventSink): void;
}
```

On reconnect the client passes the ID of the last event it actually processed, and the server
replays the gap. This costs you nothing when nothing was missed, and is the difference between a
subscription that survives a train tunnel and one that does not.

## Versioning and deploys

Cap'n Web has no schema, so it also has no schema-evolution mechanism: no field numbers, no
reserved tags, no wire-level compatibility rules to learn. The rules are the ones you already know
for **evolving a JavaScript API without breaking existing callers.**

| Safe                                            | Breaking                                       |
| ------------------------------------------------ | ---------------------------------------------- |
| Add a new method \*                               | Rename or remove a method                      |
| Add a new **optional** parameter at the end       | Add a required parameter                       |
| Add a property to a returned object               | Remove or rename a returned property           |
| Accept a wider type than before                   | Accept a narrower type than before             |
| Return a new capability alongside the old one     | Change what an existing method returns         |

\* These are the rules for Cap'n Web itself. If you use [`capnweb-validate`](/guides/validation/),
its generated validators are stricter; a peer whose validator was built before you added a method
will refuse the call. Its own compatibility table is under
[Schema evolution](/guides/validation/#schema-evolution), and you should read both.

Two deployment realities to plan for:

- **Both versions run at once** during a rolling deploy, so a client may talk to an old instance on
  one connection and a new one on the next.
- **WebSocket clients can be very old.** A browser tab left open for a week is still holding a
  session against whatever you deployed a week ago. Add capabilities; don't take them away.

## Load balancing and scaling

Nothing persists, but a WebSocket session *is* in-memory state, which means it is pinned to one
process for its lifetime. The consequences are the ordinary ones for stateful connections, plus one
that is specific to pipelining.

- **Every frame of a socket must reach the same backend.** Any load balancer that routes a
  WebSocket as a single connection already does this. Do not put a session behind something that
  can re-route mid-stream.
- **Scale-in is the awkward part.** Long-lived connections do not drain by themselves, so an
  instance can stay alive for hours waiting for the last tab to close. Since clients must handle
  reconnection anyway, you can lean on it: cap session age, then close with a normal closure and
  let clients come back on a fresh instance.
- **Request-count metrics will lie to you.** [Pipelining](/concepts/promises/) means one message can
  carry an enormous amount of work, so a load balancer counting requests, or a rate limiter counting
  frames, sees almost nothing. Rate-limit expensive *operations* inside the application. See
  [Security considerations](/guides/security/#rate-limit-because-pipelining-is-cheap-for-attackers).
- **Budget memory per session.** Everything the peer holds a reference to is pinned in your export
  table until it is released, and the library has no export-count limit to set; bounding what a
  single session may accumulate is your own bookkeeping. See
  [Security considerations](/guides/security/).

[HTTP batch](/transports/http-batch/) sidesteps all of this: a batch is one request, any instance
can serve it, and everything is released when the response is written. It is the right transport
for a stateless edge deployment.

On Cloudflare Workers, a [Durable Object](/servers/workers/) gives a session a natural, addressable
home.
