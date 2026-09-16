---
title: Custom Transports
description: Implement RpcTransport to run Cap'n Web over any bidirectional stream, and tune how much encoding it does for you.
sidebar:
  order: 4
---

You can implement a custom RPC transport across any bidirectional stream.

## The interface

A transport is two required methods, plus `abort()` if there is something useful to do with a
fatal error:

```ts
// Interface for an RPC transport, which is a simple bidirectional message stream.
export interface RpcTransport {
  // Sends a message to the other end.
  send(message: string): Promise<void>;

  // Receives a message sent by the other end.
  //
  // If and when the transport becomes disconnected, this will reject. The thrown
  // error will be propagated to all outstanding calls and future calls on any
  // stubs associated with the session. If there are no outstanding calls (and
  // none are made in the future), then the error does not propagate anywhere --
  // this is considered a "clean" shutdown.
  receive(): Promise<string>;

  // Indicates that the RPC system has suffered an error that prevents the session
  // from continuing. The transport should ideally try to send any queued messages
  // if it can, and then close the connection. (It's not strictly necessary to
  // deliver queued messages, but the last message sent before abort() is called is
  // often an "abort" message, which communicates the error to the peer, so if that
  // is dropped, the peer may have less information about what happened.)
  abort?(reason: any): void;
}
```

## Starting a session

Hand the transport to `RpcSession`, along with whatever you want the other end to be able to
call:

```ts
// Create the transport.
let transport: RpcTransport = new MyTransport();

// Create the main interface we will expose to the other end.
let localMain: RpcTarget = new MyMainInterface();

// Start the session.
let session = new RpcSession<RemoteMainInterface>(transport, localMain);

// Get a stub for the other end's main interface.
let stub: RemoteMainInterface = session.getRemoteMain();

// Now we can call methods on the stub.
```

Sessions are entirely symmetric: neither side is defined as the "client" nor the "server". Each side
can optionally expose a main interface to the other. In typical client/server scenarios, the server
exposes a main interface and the client does not.

## Encoding levels

By default, `send()` accepts a string and `receive()` returns a string, with Cap'n Web handling the
encoding all the way to and from strings. Transports that want more control over serialization can
declare an `encodingLevel` property:

| `encodingLevel`             | What the transport receives                              | Use when                                               |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `"string"` *(default)*      | Fully-serialized JSON strings.                           | HTTP batch and WebSocket use this.                     |
| `"jsonCompatible"`          | JavaScript value trees that are JSON-compatible.         | You serialize to CBOR, MessagePack, etc.               |
| `"jsonCompatibleWithBytes"` | Same, but byte arrays stay as `Uint8Array`.              | Your format has native binary; avoids base64 overhead. |
| `"structuredClonable"`      | Structured-clonable values, native types passed through. | `MessagePort` and similar.                             |

Details:

- **`"string"`**: full JSON round-trip. The transport deals in strings only; Cap'n Web handles all
  encoding and decoding.
- **`"jsonCompatible"`**: the transport works with JavaScript value trees, but they must be
  JSON-compatible. Cap'n Web still encodes special types, but skips the final `JSON.stringify`. The
  transport is responsible for serialization.
- **`"jsonCompatibleWithBytes"`**: like `"jsonCompatible"`, except byte arrays are left as
  `Uint8Array` instead of base64-encoded, avoiding the ~33% base64 size overhead and the
  encode/decode CPU cost. Handy with CBOR or MessagePack.
- **`"structuredClonable"`**: messages are structured-clonable values. Cap'n Web passes through
  native structured-clone types where possible, while still handling RPC-specific values such as
  stubs.

## Framing is your job

The protocol operates on a stream of **discrete messages**; it does not define how they are framed.
If your underlying stream is byte-oriented (a TCP socket, a serial line), you must add framing
using length prefixes or newline delimiting, as the built-in HTTP transport does.

## A worked example

A minimal transport over a pair of async queues:

```ts
class QueueTransport implements RpcTransport {
  #outgoing: (msg: string) => void;
  #incoming: string[] = [];
  #waiters: ((msg: string) => void)[] = [];

  constructor(outgoing: (msg: string) => void) {
    this.#outgoing = outgoing;
  }

  // Call this when the underlying stream delivers a message.
  deliver(message: string) {
    let waiter = this.#waiters.shift();
    if (waiter) waiter(message);
    else this.#incoming.push(message);
  }

  async send(message: string) {
    this.#outgoing(message);
  }

  receive(): Promise<string> {
    let queued = this.#incoming.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  abort(reason: any) {
    console.error('transport aborted', reason);
  }
}
```

:::caution
Apply payload size limits at the transport layer. Cap'n Web enforces a maximum incoming message size
before `JSON.parse`, but that check runs only after `receive()` has returned a *complete* message
string, so transport-level limits are the first line of defence against buffering very large
frames. See [Security considerations](/guides/security/).
:::
