// The RPC API shared by every entry point in this example: the Node server
// (`server-node.mjs`) and the Cloudflare Worker (`worker.js`).
//
// `capnweb` is a bare specifier here rather than a relative path into `dist/`.
// Under Node it resolves through the repo's own workspace self-link; under
// Workers it is mapped to the workerd build by the `alias` block in
// `wrangler.jsonc`. Either way there is exactly one copy of the library, which
// matters because `RpcTarget` identity is checked at the session boundary.

import { RpcTarget } from 'capnweb';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const USERS = new Map([
  ['cookie-123', { id: 'u_1', name: 'Ada Lovelace' }],
  ['cookie-456', { id: 'u_2', name: 'Alan Turing' }],
]);

const PROFILES = new Map([
  ['u_1', { id: 'u_1', bio: 'Mathematician & first programmer' }],
  ['u_2', { id: 'u_2', bio: 'Mathematician & computer science pioneer' }],
]);

const NOTIFICATIONS = new Map([
  ['u_1', ["Welcome to Cap'n Web!", 'You have 2 new followers']],
  ['u_2', ['New feature: pipelining!', 'Security tips for your account']],
]);

/** Per-method artificial latency, in milliseconds. */
export const DEFAULT_DELAYS = { auth: 80, profile: 120, notifications: 120 };

/**
 * Pull delay overrides out of an environment-shaped record. Works for both
 * `process.env` (strings) and Workers `env` (numbers from `vars`).
 */
export function delaysFrom(source = {}) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    auth: num(source.DELAY_AUTH_MS, DEFAULT_DELAYS.auth),
    profile: num(source.DELAY_PROFILE_MS, DEFAULT_DELAYS.profile),
    notifications: num(source.DELAY_NOTIFS_MS, DEFAULT_DELAYS.notifications),
  };
}

export class Api extends RpcTarget {
  #delays;

  constructor(delays = DEFAULT_DELAYS) {
    super();
    this.#delays = { ...DEFAULT_DELAYS, ...delays };
  }

  // Simulate authentication from a session cookie/token.
  async authenticate(sessionToken) {
    await sleep(this.#delays.auth);
    const user = USERS.get(sessionToken);
    if (!user) throw new Error('Invalid session');
    return user; // { id, name }
  }

  async getUserProfile(userId) {
    await sleep(this.#delays.profile);
    const profile = PROFILES.get(userId);
    if (!profile) throw new Error('No such user');
    return profile; // { id, bio }
  }

  async getNotifications(userId) {
    await sleep(this.#delays.notifications);
    return NOTIFICATIONS.get(userId) ?? [];
  }
}
