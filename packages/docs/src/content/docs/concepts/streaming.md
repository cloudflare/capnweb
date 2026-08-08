---
title: Streaming
description: Pass ReadableStream and WritableStream over RPC with automatic flow control and multiplexing.
---

You may pass a `ReadableStream` or `WritableStream` over RPC. When you do, the RPC system
automatically creates an equivalent stream at the other end and pumps bytes (or arbitrarily typed
chunks) across.

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

Streaming is done in such a way as to ensure the available bandwidth is fully used while
minimizing buffer bloat, by observing the bandwidth-delay product and applying backpressure when too
much is written.

You do not configure this. Write to the stream and the RPC system throttles the writer for you.

## Multiplexing

Multiple streams can be sent across the same connection; they are multiplexed appropriately,
similar to HTTP/2 stream multiplexing. A large upload will not block small RPC calls happening
concurrently on the same session.

## Blobs

`Blob` is also supported by value. Because reading a `Blob`'s bytes is asynchronous,
blobs always travel over the same pipe machinery as streams, even when small. The receiver collects
all chunks before delivering the value to application code.

## Async generators are not streams

`ReadableStream` is the supported way to stream. Async iteration is not an RPC concept, and the two
ways of getting it wrong fail very differently:

- **An async generator** is not a supported type. Returning one fails loudly, with
  `Cannot serialize value: [object AsyncGenerator]`.
- **A plain object that merely implements `Symbol.asyncIterator`** is worse. As far as the
  serializer is concerned it is an ordinary object, and symbol-keyed properties are not sent, so it
  arrives at the peer as `{}` with no error at all.

Either way, wrap it in a stream:

```ts
class LogService extends RpcTarget {
  tail(): ReadableStream {
    let lines = this.#lines();
    return new ReadableStream({
      async pull(controller) {
        let { value, done } = await lines.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        // The peer went away. Let the generator clean up.
        lines.return(undefined);
      },
    });
  }

  async *#lines() { /* ... */ }
}
```

Do not skip the `cancel` handler. A consumer dropping the stream, including the peer releasing it
or the session dying, is the normal way a `tail()` ends, and without `cancel` the generator is
never finalized, so anything it holds open leaks.

This only constrains what you *return*. The receiving side iterates a stream with `for await` just
fine, as at the top of this page.

## Callbacks, when a stream is the wrong shape

Streams are for a sequence of chunks flowing one way. When you want the peer to call *you* (events,
progress, subscriptions), pass an object by reference instead and let it call your methods:

```ts
// Client
class ProgressSink extends RpcTarget {
  onProgress(pct: number) { updateBar(pct); }
  onDone() { celebrate(); }
}

await api.startJob(jobId, new ProgressSink());
```

```ts
// Server
class JobService extends RpcTarget {
  // Stubs in params are disposed when the call returns, so dup() to hold on.
  async startJob(jobId: string, sink: RpcStub<ProgressSink>) {
    using held = sink.dup();
    await this.#run(jobId, held);
  }   // `held` disposed here, releasing the client's ProgressSink
}
```

This is more general than streaming, since the peer can call any method you expose in any order, but
it gives you no backpressure. Awaiting every call costs a round trip per event and underuses the
link; awaiting none lets the queue grow without bound. If what you actually have is a sequence of
chunks, use a stream and let the flow control above do the work.

Disposal doubles as a lifetime signal: your object's `[Symbol.dispose]()` runs when the peer
releases it, including when the session drops, so you can detect an abandoned job. See
[Disposal](/concepts/disposal/) and [Sessions](/guides/sessions/).

## How it works on the wire

A `WritableStream` is exported as a `["writable", exportId]` expression whose target accepts
`write(chunk)`, `close()`, and `abort(reason?)`, mirroring `WritableStreamDefaultWriter`.

A `ReadableStream` is sent by first creating a pipe with a `["pipe"]` message, pumping data into the
writable end immediately, and referencing the readable end via `["readable", importId]`. This means
data starts flowing without waiting for a round trip.

If a writable export is released without `close()` having been called, the sender aborts the stream,
signalling abnormal termination such as a network disconnect.

See the [protocol reference](/reference/protocol/#writable) for details.
