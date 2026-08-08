# Session recovery

A Cap'n Web session over a WebSocket, with a button that kills it.

The other two examples are about making calls cheap. This one is about what happens when the
connection they travel over goes away.

## The point

A Cap'n Web session is per-connection memory. When the socket dies:

- every stub from that session is permanently broken, and calling one **rejects** rather than
  hanging or quietly reconnecting;
- the authenticated user, which lived on the object `authenticate()` returned, is gone;
- nothing is re-established automatically, because the library cannot know whether the object a
  stub pointed at still exists or should still be reachable by you.

Anything that has to survive that must live somewhere else. In this example the event log is
created at module scope and passed into each session, and the client keeps a cursor: the id of the
last event it actually processed. The cursor is what makes the reconnect gapless, and it works
precisely because it is a number in client-side state rather than anything the session owns.

Untick **Resume from cursor** in the page and disconnect again to watch the gap appear.

## Running it

From the repo root:

```sh
npm run build   # the example resolves `capnweb` to dist/
npx wrangler dev --cwd examples/session-recovery --ip 127.0.0.1 --port 8789
```

Then open <http://127.0.0.1:8789>. There is no build step for the page itself; it is plain ES
modules, and Wrangler stages the library next to it.

With a real Worker you can also turn your network off instead of pressing the button, and watch the
same thing happen.

## Files

| File                | What it is                                                           |
| ------------------- | -------------------------------------------------------------------- |
| `api.mjs`           | The RPC API, and the event log that lives outside any session        |
| `worker.js`         | The Worker: one endpoint, upgrading to a WebSocket                   |
| `public/session.js` | The client: connect, authenticate, subscribe, recover. No DOM in it. |
| `public/main.js`    | DOM wiring, kept separate so the file above stays about RPC          |

## Things worth reading the source for

**Authentication is a capability, not a header.** `authenticate()` returns an `AuthedApi` object,
and holding the stub *is* the authorization. The token crosses the wire once per connection; no
later call carries a credential.

**One round trip on connect.** `authenticate()` is not awaited before `subscribe()` is called on its
result. Both calls, plus `whoami()`, travel together.

**Callbacks are just objects passed by reference.** The client passes an `RpcTarget`; the server
gets a stub and calls methods on it. That is the entire server-push mechanism.

**`.dup()` is mandatory.** Stubs arriving as call parameters are disposed when the call returns, so
the subscription duplicates the sink to keep it. Its `[Symbol.dispose]()` releases the copy, and
also runs when the session dies; that is what stops the timer on an abrupt disconnect.

**Replay is bounded.** A resume token from a client that has been gone a long time is a request to
replay a long time. The server caps it and reports a gap rather than obliging.

## Caveats

The event log lives in module scope, which lasts as long as the isolate. That is fine for a demo and
wrong for production: isolates come and go, and two clients can land on two different ones. A real
deployment would put it in a Durable Object, a database, or a queue. The point being demonstrated is
only that it must not live *in the session*.

The docs playground runs both ends of the session inside one page, replacing the `WebSocket`
constructor for `/ws`. Everything except the Worker's upgrade handling is genuine, including the
disconnect.
