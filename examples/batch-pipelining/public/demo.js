// The two strategies being compared, and the fake network they run over.
// No DOM in this file -- main.js does the wiring, so this stays readable as
// an answer to "what is the actual difference between the two approaches?".
import { newHttpBatchRpcSession } from './vendor/capnweb.js';

export const RPC_URL = new URL('/rpc', location.href).href;

const JITTER_MS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` with `fetch` wrapped so each RPC POST is counted and padded with
 * simulated uplink and downlink latency. Restores the real fetch afterwards so
 * a failed run cannot leave the page in a patched state.
 *
 * Latency is simulated on this side on purpose: the server does exactly the
 * same work in both columns, so the difference you see is round trips and
 * nothing else.
 */
async function withSimulatedNetwork(rttMs, fn) {
	const realFetch = globalThis.fetch.bind(globalThis);
	const latency = () => rttMs + Math.random() * JITTER_MS;
	let posts = 0;

	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		if (url.startsWith(RPC_URL) && method === 'POST') {
			posts++;
			await sleep(latency());
			const response = await realFetch(input, init);
			await sleep(latency());
			return response;
		}
		return realFetch(input, init);
	};

	const started = performance.now();
	try {
		const value = await fn();
		return { value, posts, ms: performance.now() - started };
	} finally {
		globalThis.fetch = realFetch;
	}
}

// One session. `user` is never awaited before being used, so `user.id` is sent
// as a pipelined reference rather than a resolved value.
export const pipelined = (rttMs) =>
	withSimulatedNetwork(rttMs, async () => {
		const api = newHttpBatchRpcSession(RPC_URL);
		const user = api.authenticate('cookie-123');
		const profile = api.getUserProfile(user.id);
		const notifications = api.getNotifications(user.id);
		const [u, p, n] = await Promise.all([user, profile, notifications]);
		return { user: u, profile: p, notifications: n };
	});

// Three sessions, each awaited before the next can be built.
export const sequential = (rttMs) =>
	withSimulatedNetwork(rttMs, async () => {
		const user = await newHttpBatchRpcSession(RPC_URL).authenticate('cookie-123');
		const profile = await newHttpBatchRpcSession(RPC_URL).getUserProfile(user.id);
		const notifications = await newHttpBatchRpcSession(RPC_URL).getNotifications(user.id);
		return { user, profile, notifications };
	});
