// Run with Node or Bun. Client and server communicate over loopback TCP.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import {
  RpcTarget,
  newHttpBatchRpcSession,
  newHttpBatchRpcResponse,
} from "capnweb";
import { client, respond } from "./transport.mjs";

const [
  sizeArg = "65536",
  pattern = "random",
  seedArg = "42",
  pairsArg = "10",
  countArg = "16",
] = process.argv.slice(2);
const size = Number(sizeArg),
  count = Number(countArg),
  pairs = Number(pairsArg);
let seed = Number(seedArg);
if (
  !Number.isSafeInteger(size) || size < 0 ||
  !Number.isSafeInteger(count) || count < 1 ||
  !Number.isSafeInteger(pairs) || pairs < 1 ||
  !Number.isInteger(seed) || seed < 1 || seed > 0xffffffff ||
  !["random", "pattern"].includes(pattern)
) {
  throw new RangeError(
    "Expected nonnegative integer bytes, random|pattern, seed 1..4294967295, " +
    "positive integer pairs and positive integer calls per POST",
  );
}
const values = Array.from({ length: count }, (_, i) =>
  Uint8Array.from({ length: size }, (_, j) => {
    if (pattern === "pattern") return (i + j) % 251;
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed & 255;
  }),
);
class Target extends RpcTarget {
  value(i) {
    return values[i];
  }
}
let posts = 0,
  bodyBytes = 0;
const server = createServer(async (req, res) => {
  try {
    posts++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = Buffer.concat(chunks);
    const request = new Request("http://localhost" + req.url, {
      method: "POST",
      headers: req.headers,
      body: input,
    });
    const reply =
      req.url === "/pack"
        ? await respond(request, new Target())
        : await newHttpBatchRpcResponse(request, new Target());
    const zipped = gzipSync(new Uint8Array(await reply.arrayBuffer()), {
      level: 6,
    });
    bodyBytes = input.length + zipped.length;
    res.writeHead(reply.status, {
      "content-type": reply.headers.get("content-type"),
      "content-encoding": "gzip",
      "content-length": zipped.length,
    });
    res.end(zipped);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = "http://127.0.0.1:" + server.address().port;
async function batch(codec) {
  const before = posts,
    start = performance.now();
  const api =
    codec === "pack"
      ? client(base + "/pack")
      : newHttpBatchRpcSession(base + "/json");
  try {
    const result = await Promise.all(values.map((_, i) => api.value(i)));
    const ms = performance.now() - start;
    assert.equal(posts, before + 1);
    result.forEach((v, i) => {
      assert(v instanceof Uint8Array);
      assert.equal(Buffer.compare(v, values[i]), 0);
    });
    return { ms, bodyBytes };
  } finally {
    api[Symbol.dispose]();
  }
}
try {
  for (const codec of ["json", "pack"]) await batch(codec);
  for (let i = 0; i < pairs; i++) {
    const row = { size, pattern, count, seed: Number(seedArg), i };
    for (const codec of (i + Number(seedArg)) % 2
      ? ["pack", "json"]
      : ["json", "pack"])
      row[codec] = await batch(codec);
    console.log(JSON.stringify(row));
  }
} finally {
  server.closeAllConnections();
  server.close();
}
