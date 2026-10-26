// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Property-based round-trip tests for serialization. fast-check generates arbitrary trees of every
// pass-by-value type Cap'n Web supports and checks that they arrive intact:
//
// - through the standalone serialize()/deserialize() API
// - through an RpcSession echo call (params and return value) at every encoding level
//
// "Intact" allows for the normalizations the protocol applies on purpose (see `canon()` below):
// keys that shadow Object.prototype members or `toJSON` are dropped, error stacks aren't sent,
// and errors with an unrecognized `name` arrive as plain `Error`s.
//
// Set FUZZ_RUNS to run more cases, e.g. `FUZZ_RUNS=5000 pnpm vitest run serialize-fuzz`.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { RpcSession, RpcTarget, serialize, deserialize } from "../src/index.js";

type Encoding = "string" | "jsonCompatible" | "jsonCompatibleWithBytes" | "structuredClonable";

const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 300);

// Inputs that currently fail for known reasons are left out of the generators so the properties
// can find anything new. Set FUZZ_KNOWN_ISSUES=1 to generate them anyway.
//
// - Negative zero arrives as 0 at every level except structuredClonable, since JSON.stringify(-0)
//   is "0".
// - An error whose `name` or `message` isn't a string is put on the wire as-is, which the
//   receiver rejects (or JSON.stringify throws on), aborting the whole session.
const INCLUDE_KNOWN_ISSUES = !!process.env.FUZZ_KNOWN_ISSUES;

// ---------------------------------------------------------------------------------------
// Generators

// Plain string keys, plus keys the receiver treats specially or that tend to confuse code that
// builds objects by assignment.
const key = fc.oneof(
    { weight: 4, arbitrary: fc.string({ unit: "binary", maxLength: 8 }) },
    { weight: 1, arbitrary: fc.constantFrom(
        "__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "toJSON", "then",
        "length", "0", "") });

// Define keys as own properties, so "__proto__" becomes an ordinary key rather than setting the
// prototype.
function withOwnProperties<T extends object>(target: T, entries: [string, unknown][]): T {
  for (let [k, v] of entries) {
    Object.defineProperty(target, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return target;
}

const date = fc.date({ noInvalidDate: false });

const regexp = fc.tuple(
    fc.constantFrom("", "a+b", "\\d{2,}", "[/]", "\\/", "(?<x>.)\\k<x>", "^$", "\\p{L}", ".*?", "\n"),
    fc.subarray(["d", "g", "i", "m", "s", "u", "y"]))
    .map(([source, flags]) => {
      try {
        return new RegExp(source, flags.join(""));
      } catch {
        return new RegExp(source);
      }
    });

const url = fc.webUrl({ withQueryParameters: true, withFragments: true }).map(s => new URL(s));

const headers = fc.array(fc.tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/),
    fc.stringMatching(/^[!-~]([ -~]{0,8}[!-~])?$/)), { maxLength: 4 })
    .map(entries => new Headers(entries));

const TYPED_ARRAYS = {
  Uint8Array, Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

// Byte containers, usually as a view into the middle of a larger buffer. "Buffer" is a small Node
// Buffer, which Node allocates out of a shared pool.
const bytes = fc.record({
  kind: fc.constantFrom("ArrayBuffer", "DataView", "Buffer",
                        ...Object.keys(TYPED_ARRAYS) as (keyof typeof TYPED_ARRAYS)[]),
  before: fc.nat(3),
  length: fc.nat(6),
  after: fc.nat(3),
  seed: fc.uint8Array({ minLength: 96, maxLength: 96 }),
}).map(({ kind, before, length, after, seed }) => {
  if (kind === "Buffer") return Buffer.from(seed.subarray(0, length));
  let size = kind === "ArrayBuffer" || kind === "DataView" ? 1 : TYPED_ARRAYS[kind].BYTES_PER_ELEMENT;
  let buffer = seed.slice(0, (before + length + after) * size).buffer;
  if (kind === "ArrayBuffer") return buffer;
  if (kind === "DataView") return new DataView(buffer, before, length);
  return new TYPED_ARRAYS[kind](buffer, before * size, length);
});

const double = INCLUDE_KNOWN_ISSUES ? fc.double() : fc.double().map(d => Object.is(d, -0) ? 0 : d);

const leaf = fc.oneof(
    double, fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined),
    fc.string({ unit: "binary", maxLength: 20 }),
    fc.bigInt({ min: -(1n << 256n), max: 1n << 256n }),
    date, regexp, url, headers, bytes);

const ERROR_CLASSES = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError,
                       URIError, AggregateError];
const NO_CAUSE = Symbol("no cause");

const { value } = fc.letrec<{ value: unknown }>(tie => ({
  value: fc.oneof({ depthSize: "small", withCrossShrink: true },
      leaf, tie("array"), tie("sparseArray"), tie("object"), tie("set"), tie("error")),
  array: fc.array(tie("value"), { maxLength: 5 }),
  sparseArray: fc.sparseArray(tie("value"), { maxLength: 6 }),
  object: fc.array(fc.tuple(key, tie("value")), { maxLength: 5 })
      .map(entries => withOwnProperties({}, entries)),
  set: fc.array(tie("value"), { maxLength: 4 }).map(items => new Set(items)),
  error: fc.record({
    cls: fc.constantFrom(...ERROR_CLASSES),
    message: fc.string({ maxLength: 10 }),
    name: fc.option(fc.constantFrom("CustomError", "TypeError", "", "constructor")),
    props: fc.array(fc.tuple(key, tie("value")), { maxLength: 3 })
        .map(props => INCLUDE_KNOWN_ISSUES ? props
                                           : props.filter(([k]) => k !== "name" && k !== "message")),
    cause: fc.option(tie("value"), { nil: NO_CAUSE }),
    errors: fc.array(tie("value"), { maxLength: 3 }),
  }).map(({ cls, message, name, props, cause, errors }) => {
    let options = cause === NO_CAUSE ? undefined : { cause };
    let error = cls === AggregateError ? new AggregateError(errors, message, options)
                                       : new (cls as ErrorConstructor)(message, options);
    if (name !== null) error.name = name;
    return withOwnProperties(error, props);
  }),
})) as { value: fc.Arbitrary<unknown> };

// ---------------------------------------------------------------------------------------
// Comparison

const KNOWN_ERROR_NAMES = new Set(ERROR_CLASSES.map(cls => cls.name));
const isBlockedKey = (k: string) => k in Object.prototype || k === "toJSON";

// Converts a value into a plain tree that toStrictEqual() can compare exactly. With `sent` set, it
// also applies the normalizations the receiver is expected to make, so that
// canon(received, false) should equal canon(original, true).
function canon(v: unknown, sent: boolean): unknown {
  let c = (x: unknown) => canon(x, sent);

  switch (typeof v) {
    case "undefined": return { $: "undefined" };
    case "number":
      if (Number.isNaN(v)) return { $: "NaN" };
      if (Object.is(v, -0)) return { $: "-0" };
      return v;
    case "bigint": return { $: "bigint", value: v.toString() };
    case "string":
    case "boolean": return v;
  }
  if (v === null) return null;

  if (v instanceof Date) return { $: "date", time: Number.isNaN(v.getTime()) ? "NaN" : v.getTime() };
  if (v instanceof RegExp) return { $: "regexp", source: v.source, flags: v.flags };
  if (v instanceof URL) return { $: "url", href: v.href };
  if (v instanceof Headers) return { $: "headers", entries: [...v as any] };
  if (v instanceof ArrayBuffer) {
    return { $: "bytes", type: "ArrayBuffer", data: [...new Uint8Array(v)] };
  }
  if (ArrayBuffer.isView(v)) {
    // Buffers are sent as plain bytes; what kind of Uint8Array comes out depends on the runtime.
    let type = v instanceof Uint8Array && !(v instanceof Uint8ClampedArray) ? "Uint8Array"
                                                                             : Object.getPrototypeOf(v).constructor.name;
    return { $: "bytes", type, data: [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)] };
  }
  if (v instanceof Set) return { $: "set", items: [...v].map(c) };

  if (v instanceof Error) {
    let isAggregate = v instanceof AggregateError;
    let props: [string, unknown][] = [];
    for (let k of Object.keys(v)) {
      if (k === "name" || k === "message" || k === "stack" || k === "cause") continue;
      if (isAggregate && k === "errors") continue;
      props.push([k, (v as any)[k]]);
    }
    if ("cause" in v) props.push(["cause", v.cause]);
    if (isAggregate) props.push(["errors", (v as AggregateError).errors]);
    if (sent) props = props.filter(([k]) => !isBlockedKey(k));
    // Property order isn't meaningful for errors, and differs when an error arrives as a different
    // class than it was sent as (e.g. a renamed AggregateError).
    props.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return {
      $: "error",
      class: sent ? (KNOWN_ERROR_NAMES.has(v.name) ? v.name : "Error") : Object.getPrototypeOf(v).constructor.name,
      message: v.message,
      props: props.map(([k, x]) => [k, c(x)]),
    };
  }

  if (Array.isArray(v)) {
    return { $: "array", items: Array.from({ length: v.length }, (_, i) => c(v[i])) };
  }

  let keys = Object.keys(v as object);
  if (sent) keys = keys.filter(k => !isBlockedKey(k));
  return { $: "object", entries: keys.map(k => [k, c((v as any)[k])]) };
}

// ---------------------------------------------------------------------------------------
// Session harness

// Copies a jsonCompatibleWithBytes message the way a binary transport (CBOR, etc.) would: JSON
// values plus Uint8Arrays, copying exactly the bytes in each view.
function copyJsonWithBytes(v: unknown): unknown {
  if (v instanceof Uint8Array) return v.slice();
  if (Array.isArray(v)) return v.map(copyJsonWithBytes);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copyJsonWithBytes(x)]));
  }
  return v;
}

// In-memory transport that delivers immediately, copying each message the way a real transport
// at that encoding level would.
class LoopbackTransport {
  partner!: LoopbackTransport;
  abortReason?: unknown;
  private queue: unknown[] = [];
  private waiter?: () => void;

  constructor(readonly encodingLevel: Encoding) {}

  send(message: unknown): void {
    switch (this.encodingLevel) {
      case "jsonCompatible": message = JSON.parse(JSON.stringify(message)); break;
      case "jsonCompatibleWithBytes": message = copyJsonWithBytes(message); break;
      case "structuredClonable": message = structuredClone(message); break;
    }
    this.partner.queue.push(message);
    this.partner.waiter?.();
  }

  async receive(): Promise<unknown> {
    while (this.queue.length == 0) {
      await new Promise<void>(resolve => { this.waiter = resolve; });
    }
    this.waiter = undefined;
    return this.queue.shift();
  }

  abort(reason: unknown): void {
    this.abortReason = reason ?? "aborted";
  }
}

class Echo extends RpcTarget {
  received: unknown;

  echo(value: unknown) {
    this.received = value;
    return value;
  }
}

async function echoOverSession(encoding: Encoding, value: unknown) {
  let clientTransport = new LoopbackTransport(encoding);
  let serverTransport = new LoopbackTransport(encoding);
  clientTransport.partner = serverTransport;
  serverTransport.partner = clientTransport;

  let echo = new Echo();
  new RpcSession(serverTransport as any, echo);
  let client = new RpcSession<Echo>(clientTransport as any);
  let api = client.getRemoteMain();
  try {
    let result = await api.echo(value);
    return {
      serverReceived: echo.received, result,
      clientAbort: clientTransport.abortReason, serverAbort: serverTransport.abortReason,
    };
  } finally {
    // Shuts down the session (which records an abort), so read abort reasons first.
    api[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------------------
// Properties

it("serialize() then deserialize() round-trips any supported value", () => {
  fc.assert(fc.property(value, original => {
    let before = canon(original, false);
    let result = deserialize(serialize(original));
    expect(canon(original, false), "serialize() modified its input").toStrictEqual(before);
    expect(canon(result, false)).toStrictEqual(canon(original, true));
  }), { numRuns: NUM_RUNS });
});

describe.each<Encoding>(["string", "jsonCompatible", "jsonCompatibleWithBytes", "structuredClonable"])(
    "%s encoding", encoding => {
  it("an echo call returns any supported value intact", async () => {
    await fc.assert(fc.asyncProperty(value, async original => {
      let before = canon(original, false);
      let { serverReceived, result, clientAbort, serverAbort } =
          await echoOverSession(encoding, original);

      expect(clientAbort, "client session aborted").toBeUndefined();
      expect(serverAbort, "server session aborted").toBeUndefined();
      expect(canon(original, false), "sending modified the caller's value").toStrictEqual(before);
      expect(canon(serverReceived, false), "server received").toStrictEqual(canon(original, true));
      expect(canon(result, false), "client received").toStrictEqual(canon(original, true));
    }), { numRuns: NUM_RUNS });
  }, 120_000);
});
