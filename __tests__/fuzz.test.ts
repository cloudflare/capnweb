// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Model-based fuzz test for RpcSession's import/export bookkeeping. fast-check generates random
// sequences of operations (calls, pipelining, dup, dispose, passing stubs in both directions) and
// interleaves message delivery between the two peers one message at a time. After each sequence
// we dispose everything and check the invariants the refcount protocol is supposed to guarantee:
//
// - neither session aborted (e.g. "refcount would go negative")
// - every call settled, and calls that should succeed did
// - every increment was delivered exactly once, to the right counter
// - every RpcTarget was disposed exactly once, and never called after disposal
// - both import/export tables are back to just the main object
//
// Set FUZZ_RUNS to run more sequences, e.g. `FUZZ_RUNS=5000 pnpm vitest run fuzz`.

import { expect, it } from "vitest";
import fc from "fast-check";
import { RpcSession, RpcStub, RpcTarget, type RpcTransport } from "../src/index.js";

// Transport where the test decides when each message is delivered. Each direction stays in order
// (like a WebSocket); the fuzzer chooses which direction delivers next.
class ManualTransport implements RpcTransport {
  partner!: ManualTransport;
  inbox: string[] = [];
  abortReason?: unknown;
  private waiter?: (message: string) => void;

  send(message: string): void {
    this.partner.inbox.push(message);
  }

  receive(): Promise<string> {
    return new Promise(resolve => { this.waiter = resolve; });
  }

  abort(reason: unknown): void {
    this.abortReason = reason ?? "aborted";
  }

  // Hands the oldest queued message to the session. Returns false if nothing is queued or the
  // session isn't currently waiting in receive().
  deliverOne(): boolean {
    if (this.inbox.length == 0 || !this.waiter) return false;
    let waiter = this.waiter;
    this.waiter = undefined;
    waiter(this.inbox.shift()!);
    return true;
  }
}

// Bookkeeping written by the targets on both sides, so the final checks can see exactly what was
// delivered where.
class Ledger {
  deliveries = new Map<number, number[]>();  // tag -> ids of counters that received it
  disposeCounts = new Map<number, number>();  // counter id -> times disposed
  violations: string[] = [];
}

// Every increment carries a unique tag so we can check exactly-once delivery.
class TaggedCounter extends RpcTarget {
  constructor(private ledger: Ledger, private id: number) {
    super();
    ledger.disposeCounts.set(id, 0);
  }

  increment(tag: number) {
    if (this.ledger.disposeCounts.get(this.id)! > 0) {
      this.ledger.violations.push(`counter ${this.id} called after dispose (tag ${tag})`);
    }
    let received = this.ledger.deliveries.get(tag) ?? [];
    received.push(this.id);
    this.ledger.deliveries.set(tag, received);
    return tag;
  }

  [Symbol.dispose]() {
    this.ledger.disposeCounts.set(this.id, this.ledger.disposeCounts.get(this.id)! + 1);
  }
}

class FuzzMain extends RpcTarget {
  private held = new Map<number, RpcStub<TaggedCounter>>();

  constructor(private ledger: Ledger) {
    super();
  }

  makeCounter(id: number) {
    return new TaggedCounter(this.ledger, id);
  }

  // Calls back through a stub the client passed in, which may point back at this server.
  incrementVia(counter: RpcStub<TaggedCounter>, tag: number) {
    return counter.increment(tag);
  }

  // Params are disposed when the call returns, so keep a dup.
  hold(key: number, counter: RpcStub<TaggedCounter>) {
    this.drop(key);
    this.held.set(key, counter.dup());
  }

  drop(key: number) {
    this.held.get(key)?.[Symbol.dispose]();
    this.held.delete(key);
  }

  getHeld(key: number) {
    let counter = this.held.get(key);
    if (!counter) throw new Error(`nothing held under key ${key}`);
    return counter.dup();
  }

  dropAll() {
    for (let key of [...this.held.keys()]) this.drop(key);
  }
}

// ---------------------------------------------------------------------------------------
// Model and real system

// A live client-side reference to some counter. `certain` is false when the reference came from
// getHeld(): the server may run hold()/drop()/getHeld() in a different order than they were sent
// (e.g. if hold() waits for a promise argument), so calls through it are allowed to fail.
interface HandleModel { counter: number; certain: boolean; }

interface Model {
  handles: HandleModel[];  // parallel to Real.handles
  held: { key: number, counter: number, certain: boolean }[];
  expected: Map<number, { counter: number, certain: boolean }>;  // tag -> where it should land
  nextCounter: number;
  nextTag: number;
  nextKey: number;
}

interface TrackedCall {
  what: string;
  certain: boolean;
  state: "pending" | "resolved" | "rejected";
  error?: unknown;
}

interface Real {
  ledger: Ledger;
  clientTransport: ManualTransport;
  serverTransport: ManualTransport;
  client: RpcSession<FuzzMain>;
  server: RpcSession;
  main: RpcStub<FuzzMain>;
  handles: any[];  // RpcStub or RpcPromise for a TaggedCounter
  calls: TrackedCall[];
}

function setup(): { model: Model, real: Real } {
  let ledger = new Ledger();
  let clientTransport = new ManualTransport();
  let serverTransport = new ManualTransport();
  clientTransport.partner = serverTransport;
  serverTransport.partner = clientTransport;

  let client = new RpcSession<FuzzMain>(clientTransport);
  let server = new RpcSession(serverTransport, new FuzzMain(ledger));

  return {
    model: {
      handles: [], held: [], expected: new Map(), nextCounter: 0, nextTag: 0, nextKey: 0,
    },
    real: {
      ledger, clientTransport, serverTransport, client, server,
      main: client.getRemoteMain(), handles: [], calls: [],
    },
  };
}

// Awaiting an RpcPromise sends a pull, so tracking a call also means it will resolve and release
// its import on its own.
function track(r: Real, what: string, certain: boolean, promise: PromiseLike<unknown>) {
  let call: TrackedCall = { what, certain, state: "pending" };
  r.calls.push(call);
  promise.then(
      () => { call.state = "resolved"; },
      error => { call.state = "rejected"; call.error = error; });
}

// Let all pending microtasks run, including the read loops getting back to receive().
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// Deliver messages in both directions until both sides go quiet.
async function flush(r: Real) {
  for (let round = 0; round < 10_000; round++) {
    await settle();
    let toServer = r.serverTransport.deliverOne();
    let toClient = r.clientTransport.deliverOne();
    if (!toServer && !toClient) return;
  }
  throw new Error("sessions never went quiet");
}

// ---------------------------------------------------------------------------------------
// Commands

type Command = fc.AsyncCommand<Model, Real>;

function command(label: string, check: (m: Model) => boolean,
                 run: (m: Model, r: Real) => void | Promise<void>): Command {
  return { check, run: async (m, r) => { await run(m, r); }, toString: () => label };
}

const hasHandle = (m: Model) => m.handles.length > 0;
const hasHeld = (m: Model) => m.held.length > 0;

const allCommands = [
  fc.constant(command("makeCounter", () => true, (m, r) => {
    let id = m.nextCounter++;
    m.handles.push({ counter: id, certain: true });
    r.handles.push(r.main.makeCounter(id));
  })),

  fc.constant(command("makeLocalCounter", () => true, (m, r) => {
    let id = m.nextCounter++;
    m.handles.push({ counter: id, certain: true });
    r.handles.push(new RpcStub(new TaggedCounter(r.ledger, id)));
  })),

  fc.nat().map(i => command(`increment(h${i})`, hasHandle, (m, r) => {
    let idx = i % m.handles.length;
    let { counter, certain } = m.handles[idx];
    let tag = m.nextTag++;
    m.expected.set(tag, { counter, certain });
    track(r, `increment tag ${tag}`, certain, r.handles[idx].increment(tag));
  })),

  fc.nat().map(i => command(`incrementVia(h${i})`, hasHandle, (m, r) => {
    let idx = i % m.handles.length;
    let { counter, certain } = m.handles[idx];
    let tag = m.nextTag++;
    m.expected.set(tag, { counter, certain });
    track(r, `incrementVia tag ${tag}`, certain, r.main.incrementVia(r.handles[idx], tag));
  })),

  fc.nat().map(i => command(`dup(h${i})`, hasHandle, (m, r) => {
    let idx = i % m.handles.length;
    m.handles.push({ ...m.handles[idx] });
    r.handles.push(r.handles[idx].dup());
  })),

  fc.nat().map(i => command(`dispose(h${i})`, hasHandle, (m, r) => {
    let idx = i % m.handles.length;
    m.handles.splice(idx, 1);
    let [stub] = r.handles.splice(idx, 1);
    stub[Symbol.dispose]();
  })),

  fc.nat().map(i => command(`hold(h${i})`, hasHandle, (m, r) => {
    let idx = i % m.handles.length;
    let { counter, certain } = m.handles[idx];
    let key = m.nextKey++;
    m.held.push({ key, counter, certain });
    track(r, `hold key ${key}`, certain, r.main.hold(key, r.handles[idx]));
  })),

  fc.nat().map(k => command(`drop(k${k})`, hasHeld, (m, r) => {
    let [{ key }] = m.held.splice(k % m.held.length, 1);
    track(r, `drop key ${key}`, true, r.main.drop(key));
  })),

  fc.nat().map(k => command(`getHeld(k${k})`, hasHeld, (m, r) => {
    let { key, counter } = m.held[k % m.held.length];
    m.handles.push({ counter, certain: false });
    r.handles.push(r.main.getHeld(key));
  })),

  fc.constant(command("deliverToServer", () => true, async (_, r) => {
    r.serverTransport.deliverOne();
    await settle();
  })),

  fc.constant(command("deliverToClient", () => true, async (_, r) => {
    r.clientTransport.deliverOne();
    await settle();
  })),

  fc.constant(command("flush", () => true, (_, r) => flush(r))),
];

// ---------------------------------------------------------------------------------------
// Teardown and invariants

async function teardownAndCheck(m: Model, r: Real) {
  for (let stub of r.handles) stub[Symbol.dispose]();
  r.handles = [];
  m.handles = [];
  track(r, "dropAll", true, r.main.dropAll());
  await flush(r);

  expect(r.clientTransport.abortReason, "client session aborted").toBeUndefined();
  expect(r.serverTransport.abortReason, "server session aborted").toBeUndefined();
  expect(r.ledger.violations).toStrictEqual([]);

  for (let call of r.calls) {
    expect(call.state, `${call.what} never settled`).not.toBe("pending");
    if (call.certain) expect(call.error, `${call.what} rejected`).toBeUndefined();
  }

  for (let [tag, { counter, certain }] of m.expected) {
    let received = r.ledger.deliveries.get(tag) ?? [];
    if (certain) {
      expect(received, `tag ${tag} deliveries`).toStrictEqual([counter]);
    } else {
      expect([[], [counter]], `tag ${tag} deliveries`).toContainEqual(received);
    }
  }

  for (let [id, count] of r.ledger.disposeCounts) {
    expect(count, `counter ${id} dispose count`).toBe(1);
  }

  expect(r.client.getStats(), "client stats").toStrictEqual({ imports: 1, exports: 1 });
  expect(r.server.getStats(), "server stats").toStrictEqual({ imports: 1, exports: 1 });
}

it("random operation sequences keep refcounts and deliveries consistent", async () => {
  await fc.assert(
      // The default size only generates a handful of commands per sequence, which rarely gets
      // past creating a counter or two.
      fc.asyncProperty(fc.commands(allCommands, { maxCommands: 200, size: "large" }), async cmds => {
        let { model, real } = setup();
        await fc.asyncModelRun(() => ({ model, real }), cmds);
        await teardownAndCheck(model, real);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 200) });
}, 120_000);
