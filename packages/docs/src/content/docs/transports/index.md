---
title: Transports
description: Choosing between HTTP batch, WebSocket, MessagePort, and custom transports, and the session model they share.
---

Cap'n Web runs over any bidirectional stream of discrete messages. Four options ship in the box, and
you can write your own.

| Transport                                     | Long-lived | Server can call client | Best for                                     |
| --------------------------------------------- | ---------- | ---------------------- | -------------------------------------------- |
| [HTTP batch](/transports/http-batch/)          | No         | No                     | A burst of calls, then done. Stateless edges. |
| [WebSocket](/transports/websocket/)            | Yes        | Yes                    | Interactive apps, subscriptions, callbacks.   |
| [MessagePort](/transports/message-port/)       | Yes        | Yes                    | Web Workers, iframes, same-process boundaries. |
| [Custom](/transports/custom/)                  | Up to you  | Yes                    | Anything else with two directions.             |

## Sessions are symmetric

Sessions are entirely symmetric: **neither side is defined as the "client" nor the "server".** Each
side can optionally expose a "main interface" to the other. In typical scenarios with a logical
client and server, the server exposes a main interface and the client does not.

The words "client" and "server" appear throughout these docs only as a convention to make
explanations natural. "Client" generally means the caller of an RPC or the importer of a stub;
"server" means the callee or exporter.

## Disposal ends the session

Disposing the root stub of a session closes the connection:

```ts
{
  using api = newWebSocketRpcSession<MyApi>('wss://example.com/api');
  // ... use api ...
} // connection closed here
```

Only the **root** stub behaves this way. Disposing any other stub releases the object it points at
on the peer, but leaves the connection open:

```ts
using api = newWebSocketRpcSession<PublicApi>('wss://example.com/api');

{
  using authed = api.authenticate(apiToken);
  // ...
} // AuthedApi released on the server; the session is still up.
```

For HTTP batch, the session ends when the batch completes, and all stubs are implicitly disposed at
that point. See [Disposal](/concepts/disposal/).

Session state is in-memory and lasts exactly as long as the session; there is nothing to persist
and no session store to run. [Sessions & reconnection](/guides/sessions/) covers what that means
for reconnecting, versioning and load balancing.

## Message framing

The protocol operates on a bidirectional stream of discrete messages, each a single JSON value. The
protocol itself does not define framing: that is the transport's job.

- Transports with native framing (WebSocket, `MessagePort`) map one transport message to one RPC
  message.
- The built-in HTTP transport is newline-delimited, packing a series of messages into a single
  request or response body. An empty body means zero messages.

See the [wire protocol reference](/reference/protocol/) for the full picture.
