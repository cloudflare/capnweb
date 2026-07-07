// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Tests for the receive-side resource limits that guard against untrusted-peer resource
// exhaustion (issue #184): bigint length cap, message nesting depth, and max message size. See
// `RpcLimits` / `DEFAULT_LIMITS` in src/serialize.ts.

import { expect, it, describe } from "vitest"
import { deserialize, serialize, RpcSession, RpcTransport, RpcTarget, DEFAULT_LIMITS,
         DEFAULT_MAX_DEPTH, type RpcLimits } from "../src/index.js"

// Builds the wire string for a value nested inside `depth` escaped-array layers. Each escaped
// array `[[ inner ]]` adds one level of recursion to the deserializer (evaluateImpl recurses into
// its single element). The innermost value is the number 1.
function nestedEscapedArrays(depth: number): string {
  return `${"[[".repeat(depth)}1${"]]".repeat(depth)}`;
}

// Builds a pipeline call whose sole argument is another pipeline call, repeated `depth` times.
// This crosses the call-argument RpcPayload boundary at every level.
function nestedCallArgs(depth: number): string {
  return `["pipeline",0,["echo"],[`.repeat(depth) + "1" + "]]".repeat(depth);
}

// A one-shot transport that feeds a single pre-baked frame to the session and then blocks, while
// capturing everything the session sends back. Lets us assert exactly how the session reacts to a
// hostile incoming message.
class ScriptedTransport implements RpcTransport {
  sent: string[] = [];
  aborted = false;
  private toReceive: string[];
  private blockForever = new Promise<string>(() => {});

  constructor(frames: string[]) {
    this.toReceive = [...frames];
  }

  async send(message: string): Promise<void> {
    this.sent.push(message);
  }

  async receive(): Promise<string> {
    let next = this.toReceive.shift();
    return next === undefined ? this.blockForever : next;
  }

  abort(reason: any): void {
    this.aborted = true;
  }

  // Resolves once the session has sent an ["abort", ...] frame, or rejects after a spin budget.
  async waitForAbort(): Promise<string> {
    for (let i = 0; i < 200; i++) {
      let abortFrame = this.sent.find(m => m.startsWith('["abort"'));
      if (abortFrame !== undefined) return abortFrame;
      await Promise.resolve();
    }
    throw new Error(`session did not abort; sent: ${JSON.stringify(this.sent)}`);
  }

  async expectNoAbort(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    let abortFrame = this.sent.find(m => m.startsWith('["abort"'));
    expect(abortFrame, "session unexpectedly aborted").toBeUndefined();
    expect(this.aborted, "transport unexpectedly aborted").toBe(false);
  }
}

// Drives a server session that processes a single ["push", expr] frame, returning the transport so
// the caller can inspect the reaction.
function pushFrame(expr: string, limits?: Partial<RpcLimits>): ScriptedTransport {
  let transport = new ScriptedTransport([`["push",${expr}]`]);
  new RpcSession(transport, new EchoTarget(), limits ? { limits } : undefined);
  return transport;
}

class EchoTarget extends RpcTarget {
  echo(value: unknown) { return value; }
}

describe("bigint deserialization limits", () => {
  it("accepts a decimal bigint at the default digit limit", () => {
    let digits = "9".repeat(DEFAULT_LIMITS.maxBigIntDigits);
    let value = deserialize(`["bigint","${digits}"]`);
    expect(value).toBe(BigInt(digits));
  });

  it("rejects a bigint over the default digit limit", () => {
    let digits = "9".repeat(DEFAULT_LIMITS.maxBigIntDigits + 1);
    expect(() => deserialize(`["bigint","${digits}"]`))
        .toThrowError(/bigint exceeds maximum length/);
  });

  it("round-trips bigints through the decimal wire format", () => {
    let values = [
      0n,
      255n,
      -255n,
      (1n << 4096n) + 123456789n,
      -((1n << 4096n) + 123456789n),
    ];

    for (let value of values) {
      let wire = serialize(value);
      expect(wire).toMatch(/^\["bigint","-?[0-9]+"\]$/);
      expect(deserialize(wire)).toBe(value);
    }
  });

  it("accepts decimal bigint strings", () => {
    expect(deserialize('["bigint","123"]')).toBe(123n);
    expect(deserialize('["bigint","-123"]')).toBe(-123n);
  });

  it("honors a per-session override of maxBigIntDigits", async () => {
    // The cap counts the full wire string length. "1234" is 4 characters.
    await pushFrame('["bigint","1234"]', { maxBigIntDigits: 4 }).expectNoAbort();

    let aborted = await pushFrame('["bigint","12345"]', { maxBigIntDigits: 4 }).waitForAbort();
    expect(aborted).toMatch(/bigint exceeds maximum length/);

    // The leading "-" counts toward the length, so "-123" is 4 characters (within a limit of 4)
    // while "-1234" is 5 and aborts.
    await pushFrame('["bigint","-123"]', { maxBigIntDigits: 4 }).expectNoAbort();

    let abortedNeg = await pushFrame('["bigint","-1234"]', { maxBigIntDigits: 4 }).waitForAbort();
    expect(abortedNeg).toMatch(/bigint exceeds maximum length/);

    // The 5-digit value is well under the default limit, so it does NOT abort by default.
    await pushFrame('["bigint","12345"]').expectNoAbort();
  });
});

describe("message depth limits", () => {
  it("accepts nesting just under the default depth limit", () => {
    // The top value sits at depth 0, so maxDepth-1 escaped-array layers stay within the limit.
    let value = deserialize(nestedEscapedArrays(DEFAULT_LIMITS.maxDepth - 1));
    expect(value).toBeInstanceOf(Array);
  });

  it("rejects nesting over the default depth limit", () => {
    expect(() => deserialize(nestedEscapedArrays(DEFAULT_LIMITS.maxDepth + 5)))
        .toThrowError(/maximum allowed message depth/);
  });

  it("honors a per-session override of maxDepth", async () => {
    // Override depth to a small value; nesting beyond it aborts the session.
    let deep = nestedEscapedArrays(10);
    let aborted = await pushFrame(deep, { maxDepth: 4 }).waitForAbort();
    expect(aborted).toMatch(/maximum allowed message depth/);

    // The same depth is well within the default, so by default it does not abort.
    await pushFrame(deep).expectNoAbort();
  });

  it("does not reset depth across nested call arguments", async () => {
    let aborted = await pushFrame(nestedCallArgs(8), { maxDepth: 8 }).waitForAbort();
    expect(aborted).toMatch(/maximum allowed message depth/);
  });

  it("accepts nested call arguments within the default depth limit", async () => {
    await pushFrame(nestedCallArgs(64)).expectNoAbort();
  });

  it("accepts near-limit call arguments that the default sender can serialize", async () => {
    let appArg = deserialize(nestedEscapedArrays(DEFAULT_MAX_DEPTH - 2));
    let wireArgs = JSON.parse(serialize([appArg]))[0];
    await pushFrame(`["pipeline",0,["echo"],${JSON.stringify(wireArgs)}]`).expectNoAbort();
  });
});

describe("message size limits", () => {
  it("aborts the session on a message over the size limit", async () => {
    // The pushed expression is a long-but-valid JSON string literal, so the resulting frame is
    // valid JSON and well over the 64-char override. The size check runs (and aborts) before
    // JSON.parse, so this exercises the size guard specifically, not a parse error.
    let aborted = await pushFrame(`"${"a".repeat(200)}"`, { maxMessageSize: 64 }).waitForAbort();
    expect(aborted).toMatch(/exceeds maximum size/);
  });

  it("does not abort on a message under the size limit", async () => {
    await pushFrame('"small"', { maxMessageSize: 1024 }).expectNoAbort();
  });
});

describe("limits backwards compatibility", () => {
  it("DEFAULT_LIMITS has the documented values", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(256);
    expect(DEFAULT_LIMITS).toStrictEqual({
      maxBigIntDigits: 16384,
      maxDepth: DEFAULT_MAX_DEPTH,
      maxMessageSize: 32 * 1024 * 1024,
    });
  });

  it("standalone deserialize round-trips normal values unchanged with no config", () => {
    expect(deserialize('["bigint","123"]')).toBe(123n);
    expect(deserialize(serialize(12345678901234567890n))).toBe(12345678901234567890n);
    expect(deserialize('[[[[123,456]]]]')).toStrictEqual([[123, 456]]);
    expect(deserialize('{"foo":{"bar":123}}')).toStrictEqual({foo: {bar: 123}});
  });

  it("a session constructed with no options behaves exactly as before", async () => {
    // A legitimate bigint, normal nesting, and a normal call all flow through a default session
    // without aborting.
    using harness = new SessionPair(new EchoTarget());

    let stub = harness.stub as any;
    expect(await stub.echo(123n)).toBe(123n);
    expect(await stub.echo([[1, 2, 3]])).toStrictEqual([[1, 2, 3]]);
    expect(await stub.echo({a: {b: {c: 1}}})).toStrictEqual({a: {b: {c: 1}}});

    await harness.dispose();
  });

  it("a session constructed with an empty options object behaves identically", async () => {
    using harness = new SessionPair(new EchoTarget(), {});
    let stub = harness.stub as any;
    expect(await stub.echo(999n)).toBe(999n);
    await harness.dispose();
  });
});

// A minimal in-memory bidirectional session pair, sufficient for the round-trip checks above.
class PairTransport implements RpcTransport {
  partner!: PairTransport;
  private queue: string[] = [];
  private waiter?: () => void;

  async send(message: string): Promise<void> {
    this.partner.queue.push(message);
    this.partner.waiter?.();
    this.partner.waiter = undefined;
  }

  async receive(): Promise<string> {
    while (this.queue.length === 0) {
      await new Promise<void>(resolve => { this.waiter = resolve; });
    }
    return this.queue.shift()!;
  }
}

class SessionPair {
  private clientTransport = new PairTransport();
  private serverTransport = new PairTransport();
  private client: RpcSession;
  private server: RpcSession;
  stub: ReturnType<RpcSession["getRemoteMain"]>;

  constructor(target: RpcTarget, options?: { limits?: Partial<RpcLimits> }) {
    this.clientTransport.partner = this.serverTransport;
    this.serverTransport.partner = this.clientTransport;
    this.client = new RpcSession(this.clientTransport);
    this.server = new RpcSession(this.serverTransport, target, options);
    this.stub = this.client.getRemoteMain();
  }

  async dispose() {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  }

  [Symbol.dispose]() {}
}
