---
title: Wire Protocol
description: The complete Cap'n Web wire protocol, covering serialization, import/export tables, top-level messages, and expressions.
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 3
---

This page documents what actually goes over the socket. You do not need it to use Cap'n Web, but you
do need it to implement an interoperating peer, or to debug traffic in a network inspector.

## Serialization

The protocol uses JSON as its basic serialization, with a preprocessing step to support non-JSON
types.

Why not a binary format? While the author is a big fan of optimized binary protocols in other
contexts, it cannot be denied that in a browser, JSON has big advantages. Being built into the
browser gives it a leg up in performance, code size, and developer tooling.

The usual argument for binary is size on the wire, and it is weaker here than it looks:

- `JSON.parse` and `JSON.stringify` are native. A binary codec written in JavaScript has to beat
  optimized C++ from inside the JS engine, which is a hard start.
- In a browser, **the code you ship is part of the cost**. A binary format that saves bytes per
  message but adds kilobytes to the bundle can easily lose, especially for an application that is
  not chatty.
- The obvious redundancy (the same property names repeating in every message) is exactly what
  compression is good at. Where it is available, WebSocket `permessage-deflate` or HTTP content
  encoding removes most of it without the protocol having to. (Availability is not universal:
  Cloudflare Workers' `WebSocketPair` does not negotiate compression extensions.)

You also get to read the traffic in your browser's network inspector, which is not nothing.

Non-JSON types are encoded using arrays. The first element of the array contains a string type code,
and the remaining elements contain the parameters needed to construct that type. For example, a
`Date` might be encoded as:

```json
["date", 1749342170815]
```

To encode an array, the array must be wrapped in a second layer of array to create an array
expression:

```json
[["just", "an", "array"]]
```

## Client vs. server

The protocol does not have a "client" or a "server"; it is fully bidirectional. Either side can call
interfaces exported by the other.

With that said, for documentation purposes, we often use the words "client" and "server" when
describing specific interactions, in order to make the language easier to understand. The word
"client" generally refers to the caller of an RPC, or the importer of a stub. The word "server"
refers to the callee, or the exporter. This is merely a convention to make explanations more
natural.

## Transport and framing

The protocol operates on a bidirectional stream of discrete messages. Each message is a single JSON
value, typically an array. The protocol does not define how messages are framed on the wire; this is
the responsibility of the transport layer.

For transports that natively provide message framing, such as WebSocket or `MessagePort`, each
transport-level message corresponds to exactly one RPC message.

The built-in HTTP transport is **newline-delimited**, packing a series of messages into a single
HTTP request or response body. Each message is serialized as a single line of JSON with no embedded
newlines, and messages are separated by a newline character (`\n`). An empty body is interpreted as
zero messages.

Other transports are free to use other framing strategies.

## Imports and exports

Each side of an RPC session maintains two tables: **imports** and **exports**. One side's exports
correspond to the other side's imports. Imports and exports are assigned sequential numeric IDs.
However, in some cases an ID needs to be chosen by the importing side, and in some cases by the
exporting side. To avoid conflicts:

- When the **importing** side chooses the ID, it chooses the next **positive** ID, starting from 1
  and going up.
- When the **exporting** side chooses the ID, it chooses the next **negative** ID, starting from -1
  and going down.
- ID **zero** is automatically assigned to the "main" interface.

To be more specific:

- The importing side chooses the ID when it initiates a call: the ID represents the result of the
  call.
- The exporting side chooses the ID when it sends a message containing a stub: the ID represents the
  target of the stub.

For comparison, in CapTP and Cap'n Proto there are four tables instead of two: imports, exports,
questions, and answers. In this library, questions are unified with imports, and answers with
exports.

By convention, when describing the meaning of any RPC message, we always take the perspective of the
sender. So if a message contains an "import ID", it is an import from the perspective of the sender,
and an export from the perspective of the recipient.

Note that IDs are never reused. This differs from Cap'n Proto, which always tries to choose the
smallest available ID. We assume no session will ever exceed 2^53 IDs, so assigning sequentially is
fine.

## Push and pull

An RPC call follows this sequence:

1. The client sends the server a **push** message containing an expression to evaluate.
   - The push is implicitly assigned the next positive ID in the client's import table.
   - The expression expresses the call to make.
   - Upon receipt, the server evaluates the expression and delivers the call to the application.
2. The client subsequently sends a **pull** message specifying the import ID just created by the
   push. This expresses that the client is interested in receiving the result as a **resolve**
   message.
3. The client may subsequently refer to the import ID in pipelined requests.
4. When the server is done executing the call, it sends a **resolve** message specifying the export
   ID of the push and an expression for its result.
5. Upon receiving the resolution, the client no longer needs the import table entry, so it sends a
   **release** message. Upon receipt, the server disposes its copy of the return value, if
   necessary.

Some notes:

- The client does not need to send a pull message if it doesn't care to receive the results. In
  practice, if the application never awaits the promise, it is never pulled. **The promise can still
  be used in pipelining without pulling.**
- Technically, the pushed expression can contain any number of calls, including none. A client
  could, for example, push a large data structure containing no calls, then subsequently make
  multiple calls that use this data structure via pipelining, avoiding sending the same data
  multiple times.
- If the call throws an exception, the server sends a **reject** message instead of resolve.
- Resolve and reject are the same messages used to resolve exported promises (that is, a promise
  introduced when it was sent as part of some other RPC message). Thus, calls and exported promises
  work the same. This differs from Cap'n Proto, where returning from a call and resolving an
  exported promise were entirely different messages, with a lot of duplicated semantics.

## Top-level messages

The following are the top-level messages that can be sent over the RPC transport.

### push

```json
["push", expression]
```

Asks the recipient to evaluate the given expression. The expression is implicitly assigned the next
sequential import ID, in the positive direction. The recipient evaluates the expression, delivering
any calls therein to the application. The final result can be pulled, or used in promise pipelining.

### pull

```json
["pull", importId]
```

Signals that the sender would like to receive a resolve message for the resolution of the given
import, which must refer to a promise. This is normally only used for imports created by a push, as
exported promises are pulled automatically.

### resolve

```json
["resolve", exportId, expression]
```

Instructs the recipient to evaluate the given expression and then use it as the resolution of the
given promise export.

### reject

```json
["reject", exportId, expression]
```

Instructs the recipient to evaluate the given expression and then use it to reject the given promise
export. The expression is not permitted to contain stubs. It typically evaluates to an `Error`,
although technically JavaScript does not require that thrown values are `Error`s.

### release

```json
["release", importId, refcount]
```

Instructs the recipient to release the given entry in the import table, disposing whatever it is
connected to. If the import is a promise, the recipient is no longer obliged to send a resolve
message for it, though it is still permitted to do so.

`refcount` is the total number of times this import ID has been "introduced": the number of times
it has been the subject of an `export` or `promise` expression, plus 1 if it was created by a push.
The refcount must be sent to avoid a race condition if the receiving side has recently exported the
same ID again. The exporter remembers how many times it has exported this ID, decrements by the
refcount of any release messages received, and only actually releases the ID when the count reaches
zero.

### stream

```json
["stream", expression]
```

Like push, asks the recipient to evaluate the given expression, and the expression is implicitly
assigned the next sequential positive import ID. However, unlike push:

- Promise pipelining on the result is **not** supported. The caller must not refer to the import ID
  in subsequent expressions.
- The expression is automatically considered pulled. No separate pull message is needed.
- Once the recipient sends a resolve or reject for the result, the export is implicitly released
  with a refcount of 1. No separate release message is needed.

This message type is designed for streaming writes, where the result is expected to be empty and the
overhead of separate pull and release messages is high.

### pipe

```json
["pipe"]
```

Creates a "pipe" on the remote end. A pipe consists of a `ReadableStream` end and a `WritableStream`
end. The pipe is implicitly assigned the next sequential positive import ID, similar to push.

The new import is **not** a promise. It is immediately usable as if it were a `WritableStream`; the
sender can call `write`, `close`, and/or `abort` on it, using the same interface described for the
[`writable`](#writable) expression.

The readable end of the pipe can be referenced in a subsequent message using the
[`readable`](#readable) expression. That expression can only be used once per pipe.

The purpose of the pipe mechanism is to support sending `ReadableStream` over RPC. When a message
contains a `ReadableStream`, the sender first sends a `["pipe"]` message to establish the writable
end, then begins pumping the stream's data through it, and includes the readable end in the
subsequent message via `["readable", importId]`. This allows data to start flowing immediately
without waiting for a network round trip.

### abort

```json
["abort", expression]
```

Indicates that the sender has experienced an error causing it to terminate the session. The
expression evaluates to the error which caused the abort. No further messages will be sent nor
received.

## Expressions

Expressions are JSON-serializable object trees. All JSON types except arrays are interpreted
literally. Arrays are further evaluated into a final value as follows.

### array

```json
[[...]]
```

An array expression. The inner array contains expressions, one for each array element, which are
individually evaluated to produce the final array value.

For example, this expression represents an object containing an array:

```json
{
  "key": [[
    "abc",
    ["date", 1757214689123],
    [[0]]
  ]]
}
```

- The 1st item in the array expression is an expression for the string `"abc"`.
- The 2nd item is an expression for a date object.
- The 3rd item is another array expression containing an integer expression representing zero.

It evaluates to:

```js
{
  key: [
    "abc",
    Date(1757214689123),
    [0]
  ]
}
```

### undefined

```json
["undefined"]
```

The literal value `undefined`.

### inf, -inf, nan

```json
["inf"], ["-inf"], ["nan"]
```

The values `Infinity`, `-Infinity`, and `NaN`.

### bytes

```json
["bytes", base64]
["bytes", base64, type]
```

A byte container, represented as a base64-encoded string. If `type` is omitted, the receiver should
deserialize bytes as its default `Uint8Array` for backwards compatibility. Otherwise, `type`
preserves the byte container type across the wire.

Supported `type` values: `ArrayBuffer`, `DataView`, `Int8Array`, `Uint8Array`, `Uint8ClampedArray`,
`Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array`, `BigInt64Array`, `BigUint64Array`,
`Float32Array`, `Float64Array`.

Multi-byte typed array elements are encoded in **little-endian** byte order.

### blob

```json
["blob", type, readableExpression]
```

A `Blob` value. `type` is the MIME type string (`blob.type`), which may be an empty string.
`readableExpression` evaluates to a `ReadableStream` carrying the blob's bytes; in practice the
encoder always uses a [`readable`](#readable) expression backed by a pipe.

Because reading a `Blob`'s bytes is inherently asynchronous, the pipe path is always used. There is
no inline fast path even for small blobs. The receiver must collect all chunks from the stream before
delivering the value to application code.

### bigint

```json
["bigint", decimal]
```

A `bigint` value, represented as a decimal string. Receivers cap the maximum length of this string to
bound parsing cost.

### date

```json
["date", number]
```

A JavaScript `Date` value. The number is milliseconds since the Unix epoch.

### error

```json
["error", type, message, stack?, props?]
```

A JavaScript `Error` value. `type` is the name of the specific well-known `Error` subclass, e.g.
`"TypeError"`. `message` is the error message. `stack` may optionally contain the stack trace,
though **by default stacks are redacted for security reasons**.

`props` is an optional fifth element carrying any extra data attached to the error. It is a JSON
object whose keys are the error's own enumerable properties (plus the standard non-enumerable
`cause` slot, and `errors` for `AggregateError`), and whose values are themselves valid expressions
of this protocol, so they round-trip naturally. Property values that cannot be represented are
silently dropped from `props`; the error itself always reaches the receiver.

When `props` is present, `stack` is normalised to `null` if absent, so that positional indexing for
`props` is unambiguous. When there are no extras, the legacy 3- or 4-element form is emitted
unchanged.

### url

```json
["url", href]
```

A `URL` object. `href` is the fully-serialized, normalized URL string, the value of the URL's
`href` property. The receiver reconstructs it with `new URL(href)`. For example:

```json
["url", "https://example.com/path?q=1"]
```

### headers

```json
["headers", pairs]
```

A `Headers` object from the Fetch API. `pairs` is an array of `[name, value]` pairs, where both are
strings. For example:

```json
["headers", [["content-type", "text/plain"], ["x-custom", "hello"]]]
```

### request

```json
["request", url, init]
```

A `Request` object from the Fetch API. `url` and `init` are the parameters to pass to `Request`'s
constructor. The sender should omit properties from `init` when their value would be the default
anyway.

`init.headers`, if present, must contain an array of pairs suitable to pass to the `Headers`
constructor. `init.body`, if present, is an expression for the body, which must evaluate to `null`,
a string, `Uint8Array`, or `ReadableStream`. Other properties of `init` must be plain values; they
are not evaluated as expressions before being passed to the constructor.

At this time, `init.signal` is not supported and must not be sent, though that will change when
`AbortSignal` gains support for serialization.

### response

```json
["response", body, init]
```

A `Response` object from the Fetch API. `body` and `init` are the parameters to pass to `Response`'s
constructor. `body` is an expression which must evaluate to `null`, a string, `Uint8Array`, or
`ReadableStream`. `init.headers`, if present, must contain an array of pairs suitable for the
`Headers` constructor. Other properties of `init` must be plain values.

At this time, `init.webSocket` (a Cloudflare Workers extension) is not supported and must not be
sent, though that may change if `WebSocket` gains support for serialization.

### import / pipeline

```json
["import", importId, propertyPath, callArguments]
["pipeline", importId, propertyPath, callArguments]
```

References an entry on the import table, from the perspective of the sender, possibly performing
actions on it.

If the type is `import`, the expression evaluates to a **stub**. If it is `pipeline`, the expression
evaluates to a **promise**. The difference is important because promises must be replaced with their
resolution before delivering the message to the application, whereas stubs are delivered as stubs
without waiting for any resolution.

`propertyPath` is optional. If specified, it is an array of property names (strings or numbers)
leading to a specific property of the import's target. The expression evaluates to that property,
unless `callArguments` is also specified.

`callArguments` is also optional. If specified, the given property is called as a function.
`callArguments` is an array of expressions, evaluated to produce the arguments to the call.

### remap

```json
["remap", importId, propertyPath, captures, instructions]
```

Implements the [`.map()`](/concepts/map/) operation. We call it "remap" so as not to confuse it with
the serialization of a `Map` object.

`importId` and `propertyPath` are the same as for `import`; they identify the particular property to
be mapped. `captures` and `instructions` define the mapper function to apply to the target value.

`captures` defines the set of stubs which the mapper function has captured, in the sense of a lambda
capture. The body of the function may call these stubs. The format is an array where each member is
either `["import", importId]` or `["export", exportId]`, referring to an entry on the sender's import
or export table respectively.

`instructions` contains a list of expressions to evaluate in order to execute the mapper on a
particular input value. Each instruction is an expression in the same format described here, but with
special handling of imports and exports. For the purpose of mapper instructions, **there is no export
table**, and the import table is defined as follows:

| Index    | Refers to                                                    |
| -------- | ------------------------------------------------------------ |
| Negative | The `captures` list, starting from -1 (`-1` is `captures[0]`). |
| Zero     | The input value of the map function.                           |
| Positive | The result of a previous instruction (`1` is `instructions[0]`). |

The instructions are always evaluated in order. Each instruction may only import results of
instructions that came before it. The last instruction evaluates to the return value of the map
function.

### export

```json
["export", exportId]
```

The sender is exporting a new stub, or re-exporting a stub that was exported before. The expression
evaluates to a stub.

### promise

```json
["promise", exportId]
```

Like `export`, but the expression evaluates to a promise. Promises must be replaced with their
resolution before the message is finally delivered to the application.

The `exportId` in this case is always a newly-allocated ID. The sender will proactively send a
resolve or reject message for this ID when the promise resolves, unless it is released first. The
recipient does not need to pull the promise explicitly; it is assumed the recipient always wants the
resolution.

### writable

```json
["writable", exportId]
```

Represents a `WritableStream`. The sender has called `getWriter()` on the stream, locking it, and
holds the writer to handle incoming operations. The `exportId` refers to an export table entry that
accepts the following method calls:

| Method            | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `write(chunk)`    | Write a chunk. The chunk can be any RPC-compatible value.     |
| `close()`         | Close the stream normally; all data has been written.         |
| `abort(reason?)`  | Abort the stream with an optional reason.                     |

These correspond to the methods of `WritableStreamDefaultWriter`.

If the export is released without `close()` having been called, the sender aborts the stream,
indicating abnormal termination such as a network disconnect.

The receiver does not need to wait for each `write()` call to complete before sending the next one,
nor before sending `close()`. The sender processes writes in order. The receiver should wait for
`close()` to complete to verify that all writes were successful; if any write failed, `close()` also
fails with that error.

### readable

```json
["readable", importId]
```

References the readable end of a pipe previously created by a [`pipe`](#pipe) message. `importId`
must refer to an import table entry that was created as a pipe. The expression evaluates to a
`ReadableStream`.

This expression can only be used **once per pipe**. Once the readable end has been retrieved, it is
removed from the pipe entry.
