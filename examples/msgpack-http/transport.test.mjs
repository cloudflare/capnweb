import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { respond } from "./transport.mjs";

const mediaType = "application/vnd.capnweb.msgpack";
const request = (body) => new Request("http://localhost/pack", {
  method: "POST",
  headers: { "content-type": mediaType },
  body,
});

test("empty batches and unsupported requests", async () => {
  assert.equal((await respond(new Request("http://localhost/pack"), {})).status, 405);
  assert.equal((await respond(new Request("http://localhost/pack", { method: "POST" }), {})).status, 415);
  const response = await respond(request(new Uint8Array()), {});
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});

test("reject incomplete frame headers and payloads", async () => {
  for (const size of [1, 2, 3]) {
    await assert.rejects(respond(request(new Uint8Array(size)), {}), /Truncated MessagePack frame header/);
  }
  await assert.rejects(respond(request(Uint8Array.of(0, 0, 0, 8, 0)), {}), /Truncated MessagePack frame/);
});

test("cancel oversized input streams", async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(respond(new Request("http://localhost/pack", {
    method: "POST",
    headers: { "content-type": mediaType },
    body,
    duplex: "half",
  }), {}), /Batch too large/);
  assert.equal(canceled, true);
});

test("reject invalid benchmark arguments before starting a server", () => {
  for (const args of [
    ["-1"],
    ["1.5"],
    ["32", "unknown"],
    ["32", "random", "0"],
    ["32", "random", "4294967296"],
    ["32", "random", "42", "0"],
    ["32", "random", "42", "1", "0"],
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./benchmark.mjs", import.meta.url)), ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected nonnegative integer bytes/);
    assert.equal(result.stdout, "");
  }
});
