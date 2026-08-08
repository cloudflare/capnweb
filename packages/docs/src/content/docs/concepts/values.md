---
title: What Can Be Passed
description: The types Cap'n Web serializes by value, the types it passes by reference, and the types it deliberately refuses.
---

Values crossing an RPC boundary are either **passed by value** (serialized, producing a copy at the
receiving end) or **passed by reference** (replaced with a stub pointing back at the original).

## Passed by value

The following types can be passed over RPC, in arguments or return values:

- Primitive values: strings, numbers, booleans, `null`, `undefined`
- Plain objects (e.g. from object literals)
- Arrays
- `bigint`
- `Date`
- `ArrayBuffer`, `DataView`, and typed arrays
- `Error` and its well-known subclasses
- `Blob`
- `ReadableStream` and `WritableStream`, with automatic flow control (see
  [Streaming](/concepts/streaming/))
- `URL`
- `Headers`, `Request`, and `Response` from the Fetch API

## Passed by reference

- Classes that extend [`RpcTarget`](/concepts/rpc-target/)
- Functions
- Existing [`RpcStub`](/concepts/stubs/) and [`RpcPromise`](/concepts/promises/) values

Anything passed by reference produces a **stub** on the far side, and stubs must be
[disposed](/concepts/disposal/).

## Not supported yet

These may be added in the future:

- `Map` and `Set`
- `RegExp`

## Intentionally not supported

- **Application-defined classes that do not extend `RpcTarget`.** There is no safe, general way to
  reconstruct an arbitrary class on the other side. Convert to a plain object, or extend
  `RpcTarget` to pass it by reference.
- **Cyclic values.** Messages are serialized strictly as trees, like JSON.

## Errors

`Error` and its well-known subclasses survive the trip, including the error `message` and error
subclass name. Extra own enumerable properties, `cause`, and `AggregateError`'s `errors` are carried
along too; values that cannot be represented are silently dropped, but the error itself always
arrives.

Stack traces are **redacted by default** for security reasons, so a client cannot learn about your
server's internals from a thrown error.

## On the wire

All of this is JSON with a preprocessing step: non-JSON types become arrays whose first element is a
type tag, like `["date", 1749342170815]`. You can read your own traffic in the browser network tab.
See the [wire protocol reference](/reference/protocol/) for the full encoding.
