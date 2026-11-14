// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in LICENSE.txt.
import { encode, decode } from "@msgpack/msgpack";
import { RpcSession } from "capnweb";

const type = "application/vnd.capnweb.msgpack";
const maxBody = 8 * 1024 * 1024;

// Each frame is a four-byte big-endian length followed by one MessagePack value.
class Batch {
  encodingLevel = "jsonCompatibleWithBytes";
  parts = [];
  length = 0;
  send(message) {
    const data = encode(message);
    const length = data.length + 4;
    if (this.length + length > maxBody) throw new RangeError("Batch too large");
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, data.length);
    this.parts.push(header, data);
    this.length += length;
    return length;
  }
  body() {
    const result = new Uint8Array(this.length);
    let pos = 0;
    for (const part of this.parts) {
      result.set(part, pos);
      pos += part.length;
    }
    return result;
  }
}

async function* readFrames(message) {
  if (message.headers.get("content-type") !== type)
    throw new Error("Expected MessagePack batch");
  const reader = message.body?.getReader();
  if (!reader) return;
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBody) throw new RangeError("Batch too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    body.set(chunk, pos);
    pos += chunk.length;
  }
  const view = new DataView(body.buffer);
  for (pos = 0; pos < total;) {
    if (total - pos < 4) throw new Error("Truncated MessagePack frame header");
    const size = view.getUint32(pos);
    pos += 4;
    if (size > total - pos) throw new Error("Truncated MessagePack frame");
    yield decode(body.subarray(pos, pos + size), {
      maxArrayLength: 65536,
      maxMapLength: 65536,
    });
    pos += size;
  }
}

export function client(url) {
  const batch = new Batch();
  const controller = new AbortController();
  let sent = false;
  const incoming = (async function* () {
    // Allow pending thenables to enqueue their pull frames before taking the snapshot.
    await new Promise((resolve) => setImmediate(resolve));
    sent = true;
    const response = await fetch(url, {
      method: "POST",
      body: batch.body(),
      headers: { "content-type": type },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("RPC request failed: " + response.status);
    }
    yield* readFrames(response);
  })();
  return new RpcSession({
    encodingLevel: batch.encodingLevel,
    send(message) {
      if (!sent) return batch.send(message);
    },
    async receive() {
      const item = await incoming.next();
      if (item.done) throw new Error("Batch RPC request ended.");
      return item.value;
    },
    abort(reason) {
      controller.abort(reason);
    },
  }).getRemoteMain();
}

export async function respond(request, target) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("content-type") !== type)
    return new Response(null, { status: 415 });
  const frames = readFrames(request);
  const batch = new Batch();
  const end = Promise.withResolvers();
  const session = new RpcSession(
    {
      encodingLevel: batch.encodingLevel,
      send: (message) => batch.send(message),
      async receive() {
        const item = await frames.next();
        if (!item.done) return item.value;
        end.resolve();
        return new Promise(() => {});
      },
      abort: (reason) => end.reject(reason),
    },
    target,
  );
  await end.promise;
  await session.drain();
  return new Response(batch.body(), { headers: { "content-type": type } });
}
