# Bidirectional WebSocket calls

A WebSocket session can expose an RPC interface on both ends of the connection. The second argument
to `newWebSocketRpcSession()` is the local interface offered to the peer, and the return value is a
stub for the peer's interface.

In this example, the client calls `greet()` on the server. Before the server returns the greeting,
it calls `showNotification()` on the client over the same WebSocket.

Build Cap'n Web from the repository root:

```sh
npm run build
```

Start the server:

```sh
node examples/websocket-bidirectional/server-node.mjs
```

Then run the client in another terminal:

```sh
node examples/websocket-bidirectional/client.mjs
```

The client prints both the server-to-client notification and the response to its original call:

```text
Notification: The server received Ada.
Response: Hello, Ada!
```

The client's local interface remains available for the lifetime of the session. A callback passed
as a method argument has a shorter default lifetime: if the receiver needs to retain that callback
after the method returns, it must call `.dup()` as described in
[Holding on to a callback past the call that delivered it](../../README.md#holding-on-to-a-callback-past-the-call-that-delivered-it).
