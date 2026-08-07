---
title: Streaming
description: Pass ReadableStream and WritableStream over RPC with automatic flow control and multiplexing.
---

You may pass a `ReadableStream` or `WritableStream` over RPC. When you do, the RPC system
automatically creates an equivalent stream at the other end and pumps bytes — or arbitrarily typed
chunks — across.

```ts
class FileService extends RpcTarget {
  download(name: string): ReadableStream {
    return getFileStream(name);
  }

  async upload(name: string, data: ReadableStream) {
    await saveFileStream(name, data);
  }
}
```

On the client, these look like ordinary streams:

```ts
let stream = await api.download('report.csv');
for await (let chunk of stream) {
  // ...
}
```

## Flow control

Streaming is done in such a way as to ensure the available bandwidth is fully utilized while
minimizing buffer bloat, by observing the bandwidth-delay product and applying backpressure when too
much is written.

You do not configure this. Write to the stream and the RPC system throttles the writer for you.

## Multiplexing

Multiple streams can be sent across the same connection — they are multiplexed appropriately,
similar to HTTP/2 stream multiplexing. A large upload will not block small RPC calls happening
concurrently on the same session.

## Blobs

`Blob` is also supported by value. Because reading a `Blob`'s bytes is inherently asynchronous,
blobs always travel over the same pipe machinery as streams, even when small. The receiver collects
all chunks before delivering the value to application code.

## How it works on the wire

A `WritableStream` is exported as a `["writable", exportId]` expression whose target accepts
`write(chunk)`, `close()`, and `abort(reason?)` — mirroring `WritableStreamDefaultWriter`.

A `ReadableStream` is sent by first creating a pipe with a `["pipe"]` message, pumping data into the
writable end immediately, and referencing the readable end via `["readable", importId]`. This means
data starts flowing without waiting for a round trip.

If a writable export is released without `close()` having been called, the sender aborts the stream,
signalling abnormal termination such as a network disconnect.

See the [protocol reference](/reference/protocol/#writable) for details.
