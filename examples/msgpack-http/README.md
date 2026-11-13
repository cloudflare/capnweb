# MessagePack over HTTP

This example sends Cap'n Web frames through a custom HTTP batch transport. A client and server
that agree on this encoding can pass byte arrays as MessagePack binary values. The example uses
the public `RpcSession` interface and keeps the codec dependency in this directory.

## Run the comparison

Build the library from the repository root, then install the example's dependencies locally.

```sh
pnpm install --frozen-lockfile
pnpm run build
cd examples/msgpack-http
npm install --prefix . --no-package-lock --ignore-scripts
node benchmark.mjs 65536 random 947 8 16
bun benchmark.mjs 65536 random 947 8 16
```

Arguments are bytes per return value, data pattern (`random` or `pattern`), seed, number of
measurement pairs and calls per POST. The server binds to an ephemeral IPv4 loopback port and
closes when the comparison finishes. It compresses each response with gzip level 6. Requests
are uncompressed. Each JSON output line gives both batch latencies in milliseconds and the sum
of request and compressed response body bytes. HTTP headers are excluded.

Each codec gets a warmup batch. Subsequent pairs alternate order and check the request count and
every returned byte. Timing ends when the client receives all results. Try a single call and a
batch to see how much HTTP overhead your application amortizes.

## Wire format

Both endpoints use a dedicated route and the example media type
`application/vnd.capnweb.msgpack`. A batch is a sequence of four-byte unsigned big-endian lengths,
each followed by one encoded RPC frame. A zero-byte body represents an empty batch. The
`jsonCompatibleWithBytes` encoding level leaves byte arrays available to the codec.

The example buffers one batch and caps it at 8 MiB before decoding. Client and server must agree
on the encoding. The built-in JSON endpoint is served separately. Compression belongs to the
HTTP server in this example.
