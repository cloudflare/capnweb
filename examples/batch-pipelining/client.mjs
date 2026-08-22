// Client demonstrating:
// - Batching + pipelining: multiple dependent calls, one round trip.
// - Non-batched sequential calls: multiple round trips.
//
// Usage (separate terminal from server):
//   node examples/batch-pipelining/client.mjs

import { performance } from 'node:perf_hooks';
import { newHttpBatchRpcSession } from 'capnweb';

// Mirror of the server API shape (for reference only).
// authenticate(sessionToken) -> { id, name }
// getUserProfile(userId)    -> { id, bio }
// getNotifications(userId)  -> string[]

const RPC_URL = process.env.RPC_URL || 'http://localhost:3000/rpc';
const SIMULATED_RTT_MS = Number(process.env.SIMULATED_RTT_MS ?? 120); // per-direction
const SIMULATED_RTT_JITTER_MS = Number(process.env.SIMULATED_RTT_JITTER_MS ?? 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jittered = () => SIMULATED_RTT_MS + (SIMULATED_RTT_JITTER_MS ? Math.random() * SIMULATED_RTT_JITTER_MS : 0);

// Wrap fetch to count RPC POSTs for clear logging.
const originalFetch = globalThis.fetch;
let fetchCount = 0;
globalThis.fetch = async (input, init) => {
  const method = init?.method || (input instanceof Request ? input.method : 'GET');
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(RPC_URL) && method === 'POST') {
    fetchCount++;
    // Simulate uplink and downlink latency for each RPC POST.
    await sleep(jittered());
    const resp = await originalFetch(input, init);
    await sleep(jittered());
    return resp;
  }
  return originalFetch(input, init);
};

async function runPipelined() {
  fetchCount = 0;
  const t0 = performance.now();

  const api = newHttpBatchRpcSession(RPC_URL);
  const user = api.authenticate('cookie-123');
  const profile = api.getUserProfile(user.id);
  const notifications = api.getNotifications(user.id);

  const [u, p, n] = await Promise.all([user, profile, notifications]);

  const t1 = performance.now();
  return { u, p, n, ms: t1 - t0, posts: fetchCount };
}

async function runSequential() {
  fetchCount = 0;
  const t0 = performance.now();

  // 1) Authenticate (1 round trip)
  const api1 = newHttpBatchRpcSession(RPC_URL);
  const u = await api1.authenticate('cookie-123');

  // 2) Fetch profile (2nd round trip)
  const api2 = newHttpBatchRpcSession(RPC_URL);
  const p = await api2.getUserProfile(u.id);

  // 3) Fetch notifications (3rd round trip)
  const api3 = newHttpBatchRpcSession(RPC_URL);
  const n = await api3.getNotifications(u.id);

  const t1 = performance.now();
  return { u, p, n, ms: t1 - t0, posts: fetchCount };
}

async function main() {
  console.log(`Simulated network RTT (each direction): ~${SIMULATED_RTT_MS}ms ±${SIMULATED_RTT_JITTER_MS}ms`);
  console.log('--- Running pipelined (batched, single round trip) ---');
  const pipelined = await runPipelined();
  console.log(`HTTP POSTs: ${pipelined.posts}`);
  console.log(`Time: ${pipelined.ms.toFixed(2)} ms`);
  console.log('Authenticated user:', pipelined.u);
  console.log('Profile:', pipelined.p);
  console.log('Notifications:', pipelined.n);

  console.log('\n--- Running sequential (non-batched, multiple round trips) ---');
  const sequential = await runSequential();
  console.log(`HTTP POSTs: ${sequential.posts}`);
  console.log(`Time: ${sequential.ms.toFixed(2)} ms`);
  console.log('Authenticated user:', sequential.u);
  console.log('Profile:', sequential.p);
  console.log('Notifications:', sequential.n);

  console.log('\nSummary:');
  console.log(`Pipelined: ${pipelined.posts} POST, ${pipelined.ms.toFixed(2)} ms`);
  console.log(`Sequential: ${sequential.posts} POSTs, ${sequential.ms.toFixed(2)} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
