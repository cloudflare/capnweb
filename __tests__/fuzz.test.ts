// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Model-based fuzz test for RpcSession's import/export bookkeeping. fast-check generates random
// sequences of operations (calls, pipelining, awaiting, map(), dup, dispose, passing stubs in both
// directions) and interleaves message delivery between the two peers one message at a time. After
// each sequence we dispose everything and check the invariants the refcount protocol is supposed
// to guarantee:
//
// - neither session aborted (e.g. "refcount would go negative")
// - every call settled, and calls that should succeed did
// - every increment was delivered exactly once, to the right counter
// - every RpcTarget was disposed exactly once, and never called after disposal
// - both import/export tables are back to just the main object
//
// A second property mixes in disconnects and aborts partway through. Calls may then fail, but
// every call must still settle, nothing may be delivered twice, and every target must still be
// disposed exactly once.
//
// Set FUZZ_RUNS to run more sequences, e.g. `FUZZ_RUNS=5000 pnpm vitest run fuzz`.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { RpcSession, RpcStub, RpcTarget } from "../src/index.js";

type Encoding = "string" | "jsonCompatible" | "structuredClonable";

// Transport where the test decides when each message is delivered. Each direction stays in order
// (like a WebSocket); the fuzzer chooses which direction delivers next.
class ManualTransport {
  partner!: ManualTransport;
  inbox: unknown[] = [];
  abortReason?: unknown;
  // Set once the peer is gone. Queued messages are still delivered, then receive() rejects.
  private closedWith?: Error;
  private waiter?: { resolve: (message: unknown) => void, reject: (error: Error) => void };

  constructor(readonly encodingLevel: Encoding) {}

  send(message: unknown): void {
    if (this.partner.closedWith) return;
    // Copy objects so the receiver never shares them with the sender, like a real transport.
    if (this.encodingLevel === "jsonCompatible") {
      message = JSON.parse(JSON.stringify(message));
    } else if (this.encodingLevel === "structuredClonable") {
      message = structuredClone(message);
    }
    this.partner.inbox.push(message);
  }

  receive(): Promise<unknown> {
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  // Like a real transport, closes the connection, letting already-queued messages (usually the
  // "abort" message) reach the peer first.
  abort(reason: unknown): void {
    this.abortReason = reason ?? "aborted";
    this.close(new Error("peer aborted"));
  }

  close(error: Error) {
    this.closedWith ??= error;
    this.partner.closedWith ??= error;
  }

  // Drops the connection without delivering anything still in flight.
  disconnect(error: Error) {
    this.close(error);
    this.inbox = [];
    this.partner.inbox = [];
  }

  // Hands the oldest queued message to the session, or the disconnect error once the queue is
  // empty. Returns false if there's nothing to hand over or the session isn't waiting in
  // receive().
  deliverOne(): boolean {
    let waiter = this.waiter;
    if (!waiter) return false;
    if (this.inbox.length > 0) {
      this.waiter = undefined;
      waiter.resolve(this.inbox.shift());
      return true;
    } else if (this.closedWith) {
      this.waiter = undefined;
      waiter.reject(this.closedWith);
      return true;
    }
    return false;
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

  makeCounters(ids: number[]) {
    return ids.map(id => new TaggedCounter(this.ledger, id));
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

  // Called when the session goes away.
  [Symbol.dispose]() {
    this.dropAll();
  }
}

// ---------------------------------------------------------------------------------------
// Model and real system

// A live client-side reference to some counter. `promise` is true for RpcPromises (which can be
// awaited) as opposed to stubs. `certain` is false when the reference came from getHeld(): the
// server may run hold()/drop()/getHeld() in a different order than they were sent (e.g. if hold()
// waits for a promise argument), so calls through it are allowed to fail.
interface HandleModel { counter: number; certain: boolean; promise: boolean; }

interface Model {
  handles: HandleModel[];  // parallel to Real.handles
  held: { key: number, counter: number, certain: boolean }[];
  expected: Map<number, { counters: number[], certain: boolean }>;  // tag -> where it should land
  nextCounter: number;
  nextTag: number;
  nextKey: number;
}

interface TrackedCall {
  what: string;
  certain: boolean;
  // Awaiting an RpcPromise that gets disposed first may legitimately reject as canceled.
  cancelable: boolean;
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
  awaited: any[];  // results of awaiting handles, disposed at teardown
  calls: TrackedCall[];
  faulted: boolean;  // a fault command ran, so calls are allowed to fail
}

function setup(encoding: Encoding): { model: Model, real: Real } {
  let ledger = new Ledger();
  let clientTransport = new ManualTransport(encoding);
  let serverTransport = new ManualTransport(encoding);
  clientTransport.partner = serverTransport;
  serverTransport.partner = clientTransport;

  let client = new RpcSession<FuzzMain>(clientTransport as any);
  let server = new RpcSession(serverTransport as any, new FuzzMain(ledger));

  return {
    model: {
      handles: [], held: [], expected: new Map(), nextCounter: 0, nextTag: 0, nextKey: 0,
    },
    real: {
      ledger, clientTransport, serverTransport, client, server,
      main: client.getRemoteMain(), handles: [], awaited: [], calls: [], faulted: false,
    },
  };
}

// Awaiting an RpcPromise sends a pull, so tracking a call also means it will resolve and release
// its import on its own.
function track(r: Real, what: string, certain: boolean, promise: PromiseLike<unknown>,
               onValue?: (value: unknown) => void) {
  let call: TrackedCall = { what, certain, cancelable: onValue !== undefined, state: "pending" };
  r.calls.push(call);
  promise.then(
      value => { call.state = "resolved"; onValue?.(value); },
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
const hasPromise = (m: Model) => m.handles.some(h => h.promise);
const hasHeld = (m: Model) => m.held.length > 0;

const operationCommands = [
  fc.constant(command("makeCounter", () => true, (m, r) => {
    let id = m.nextCounter++;
    m.handles.push({ counter: id, certain: true, promise: true });
    r.handles.push(r.main.makeCounter(id));
  })),

  fc.constant(command("makeLocalCounter", () => true, (m, r) => {
    let id = m.nextCounter++;
    m.handles.push({ counter: id, certain: true, promise: false });
    r.handles.push(new RpcStub(new TaggedCounter(r.ledger, id)));
  })),

  fc.nat().map(i => command(`increment(h${i})`, hasHandle, (m, r) => {
    let idx = i % m.handles.length;
    let { counter, certain } = m.handles[idx];
    let tag = m.nextTag++;
    m.expected.set(tag, { counters: [counter], certain });
    track(r, `increment tag ${tag}`, certain, r.handles[idx].increment(tag));
  })),

  fc.nat().map(i => command(`incrementVia(h${i})`, hasHandle, (m, r) => {
    let idx = i % m.handles.length;
    let { counter, certain } = m.handles[idx];
    let tag = m.nextTag++;
    m.expected.set(tag, { counters: [counter], certain });
    track(r, `incrementVia tag ${tag}`, certain, r.main.incrementVia(r.handles[idx], tag));
  })),

  // Pulls the promise. The handle itself stays live, so later commands also exercise using an
  // RpcPromise after it has resolved.
  fc.nat().map(i => command(`await(h${i})`, hasPromise, (m, r) => {
    let promises = m.handles.flatMap((h, idx) => h.promise ? [idx] : []);
    let idx = promises[i % promises.length];
    track(r, `await h${idx}`, m.handles[idx].certain, r.handles[idx],
          value => r.awaited.push(value));
  })),

  // Creates counters and increments each one with a map() callback, optionally going through a
  // captured stub (the main stub) instead of calling the element directly.
  fc.tuple(fc.integer({ min: 0, max: 3 }), fc.boolean(), fc.boolean()).map(
      ([count, viaMain, disposeNow]) => command(
          `mapIncrement(${count}${viaMain ? ", viaMain" : ""}${disposeNow ? ", disposeNow" : ""})`,
          () => true, (m, r) => {
    let ids = Array.from({ length: count }, () => m.nextCounter++);
    let tag = m.nextTag++;
    m.expected.set(tag, { counters: ids, certain: true });
    let list = r.main.makeCounters(ids);
    let mapped = viaMain ? list.map((c: any) => r.main.incrementVia(c, tag))
                         : list.map((c: any) => c.increment(tag));
    track(r, `map tag ${tag}`, true, mapped);
    if (disposeNow) {
      list[Symbol.dispose]();
    } else {
      r.awaited.push(list);
    }
  })),

  fc.nat().map(i => command(`dup(h${i})`, hasHandle, (m, r) => {
    let idx = i % m.handles.length;
    m.handles.push({ ...m.handles[idx], promise: false });
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
    m.handles.push({ counter, certain: false, promise: true });
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

const faultCommands = [
  // The network drops: anything in flight is lost and both sides see receive() fail.
  fc.constant(command("disconnect", () => true, async (_, r) => {
    r.faulted = true;
    r.clientTransport.disconnect(new Error("connection lost"));
    await settle();
  })),

  // Disposing the main stub shuts down the client session.
  fc.constant(command("disposeClientMain", () => true, async (_, r) => {
    r.faulted = true;
    r.main[Symbol.dispose]();
    await settle();
  })),
];

// ---------------------------------------------------------------------------------------
// Teardown and invariants

async function teardownAndCheck(m: Model, r: Real) {
  for (let stub of r.handles) stub[Symbol.dispose]();
  for (let value of r.awaited) (value as any)?.[Symbol.dispose]?.();
  r.handles = [];
  r.awaited = [];
  m.handles = [];
  if (!r.faulted) track(r, "dropAll", true, r.main.dropAll());
  await flush(r);

  expect(r.ledger.violations).toStrictEqual([]);

  for (let call of r.calls) {
    expect(call.state, `${call.what} never settled`).not.toBe("pending");
  }

  for (let [id, count] of r.ledger.disposeCounts) {
    expect(count, `counter ${id} dispose count`).toBe(1);
  }

  if (r.faulted) {
    // Calls may have failed, but nothing may be delivered twice or to the wrong counter.
    for (let [tag, { counters }] of m.expected) {
      let received = r.ledger.deliveries.get(tag) ?? [];
      expect(new Set(received).size, `tag ${tag} delivered twice`).toBe(received.length);
      for (let id of received) expect(counters, `tag ${tag} deliveries`).toContain(id);
    }
    return;
  }

  expect(r.clientTransport.abortReason, "client session aborted").toBeUndefined();
  expect(r.serverTransport.abortReason, "server session aborted").toBeUndefined();

  for (let call of r.calls) {
    if (!call.certain || call.state === "resolved") continue;
    if (call.cancelable && String(call.error).includes("RpcPromise was disposed")) continue;
    expect(call.error, `${call.what} rejected`).toBeUndefined();
  }

  for (let [tag, { counters, certain }] of m.expected) {
    let received = (r.ledger.deliveries.get(tag) ?? []).toSorted((a, b) => a - b);
    if (certain) {
      expect(received, `tag ${tag} deliveries`).toStrictEqual(counters);
    } else {
      expect([[], counters], `tag ${tag} deliveries`).toContainEqual(received);
    }
  }

  expect(r.client.getStats(), "client stats").toStrictEqual({ imports: 1, exports: 1 });
  expect(r.server.getStats(), "server stats").toStrictEqual({ imports: 1, exports: 1 });
}

function runProperty(encoding: Encoding, commands: fc.Arbitrary<Command>[]) {
  return fc.assert(
      // The default size only generates a handful of commands per sequence, which rarely gets
      // past creating a counter or two.
      fc.asyncProperty(fc.commands(commands, { maxCommands: 200, size: "large" }), async cmds => {
        let { model, real } = setup(encoding);
        await fc.asyncModelRun(() => ({ model, real }), cmds);
        await teardownAndCheck(model, real);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 200) });
}

describe.each<Encoding>(["string", "jsonCompatible", "structuredClonable"])("%s encoding", encoding => {
  it("random operation sequences keep refcounts and deliveries consistent", async () => {
    await runProperty(encoding, operationCommands);
  }, 120_000);

  it("disconnects and aborts partway through still settle and dispose everything", async () => {
    await runProperty(encoding, [...operationCommands, ...faultCommands]);
  }, 120_000);
});
