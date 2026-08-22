// The RPC API for the session-recovery example, shared by the Cloudflare
// Worker (`worker.js`) and the in-page playground in the docs.
//
// `capnweb` is a bare specifier here rather than a relative path into `dist/`.
// Under Node it resolves through the repo's own workspace self-link; under
// Workers it is mapped to the workerd build by the `alias` block in
// `wrangler.jsonc`. Either way there is exactly one copy of the library, which
// matters because `RpcTarget` identity is checked at the session boundary.

import { RpcTarget } from 'capnweb';

/** The only credential this demo knows about. */
const TOKENS = new Map([
  ['demo-token', { id: 'u_1', name: 'Ada Lovelace' }],
  ['other-token', { id: 'u_2', name: 'Alan Turing' }],
]);

const HEADLINES = [
  'Order filled',
  'Deployment finished',
  'Invoice paid',
  'Container recycled',
  'Cache purged',
  'Alert cleared',
  'Backup completed',
  'Certificate renewed',
];

/**
 * How much history a client may ask for in one go. A resume token from a
 * client that has been gone for a week should not turn into an unbounded
 * replay: past this, the client is told it fell too far behind and should
 * resynchronize from scratch.
 */
export const MAX_REPLAY = 40;

/**
 * The event log.
 *
 * Deliberately created *outside* any session and passed in, because that is
 * the whole point of the example: an RPC session is per-connection memory that
 * dies with the socket, and anything that must outlive a disconnect has to
 * live somewhere else.
 *
 * Events are derived from the clock rather than stored, so this needs no
 * timer, no storage, and behaves identically whether it is running in a Worker
 * isolate or inside the docs page. Event `n` is defined to have happened at
 * `epoch + n * intervalMs`.
 */
export function createEventLog({ intervalMs = 1200, epoch = Date.now() } = {}) {
  const at = (id) => ({
    id,
    at: epoch + id * intervalMs,
    text: `${HEADLINES[id % HEADLINES.length]} #${1000 + id}`,
  });

  return {
    intervalMs,

    /** Sequence number of the most recent event that has already happened. */
    latestId() {
      return Math.max(0, Math.floor((Date.now() - epoch) / intervalMs));
    },

    /**
     * Everything after `sinceId`. Returns `{ events, truncated }` so the caller
     * can tell "nothing happened" apart from "you missed more than we keep".
     */
    since(sinceId) {
      const latest = this.latestId();
      const from = Math.max(sinceId, latest - MAX_REPLAY);
      const events = [];
      for (let id = from + 1; id <= latest; id++) events.push(at(id));
      return { events, truncated: from > sinceId };
    },

    /** Milliseconds until event `id` happens. Negative if it already has. */
    msUntil(id) {
      return epoch + id * intervalMs - Date.now();
    },
  };
}

/**
 * A live subscription.
 *
 * Returned by `AuthedApi.subscribe()` rather than being a fire-and-forget
 * call, so the client holds a capability it can dispose. Disposal happens
 * either explicitly or when the session drops -- see `[Symbol.dispose]`.
 */
class Subscription extends RpcTarget {
  #log;
  #sink;
  #lastId;
  #timer = null;
  #stopped = false;

  constructor(log, sink, sinceId) {
    super();
    this.#log = log;
    this.#sink = sink;
    this.#lastId = sinceId;
    this.#pump();
  }

  /** The highest event id delivered so far. The client's resume token. */
  get cursor() {
    return this.#lastId;
  }

  #pump() {
    if (this.#stopped) return;

    const { events, truncated } = this.#log.since(this.#lastId);
    if (truncated) {
      // Fire-and-forget, but still settled -- see the note in the loop below.
      this.#sink.onGap(this.#lastId).catch(() => {});
    }

    for (const event of events) {
      this.#lastId = event.id;

      // The client's sink is a stub, so this is an RPC back to the browser.
      // We do not need the result, but we do settle the promise: an RPC
      // promise that is never awaited and never disposed keeps an entry in the
      // session's tables alive for as long as the session lasts.
      this.#sink.onEvent(event).catch(() => {});
    }

    const wait = Math.max(20, this.#log.msUntil(this.#lastId + 1));
    this.#timer = setTimeout(() => this.#pump(), wait);
  }

  /**
   * Runs when the client disposes this stub, and also when the session dies,
   * which is what stops the timer on an abrupt disconnect.
   */
  [Symbol.dispose]() {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#sink[Symbol.dispose]();
  }
}

/**
 * The authenticated API.
 *
 * The client can only obtain one of these by calling `authenticate()` with a
 * valid token. Holding the stub *is* the authorization: there is no session
 * cookie, no bearer header on subsequent calls, and no way to reach these
 * methods without the capability. It also means the credential crosses the
 * wire exactly once per connection.
 */
class AuthedApi extends RpcTarget {
  #log;
  #user;

  constructor(log, user) {
    super();
    this.#log = log;
    this.#user = user;
  }

  whoami() {
    return { ...this.#user };
  }

  /**
   * Start streaming events after `sinceId`.
   *
   * Pass `sinceId: null` to start from the present and accept a gap; pass the
   * last id you actually processed to have the gap replayed.
   */
  subscribe(sinceId, sink) {
    const from = sinceId === null || sinceId === undefined ? this.#log.latestId() : sinceId;

    // Stubs received as parameters are disposed when the call returns, so a
    // callback that will be used later has to be duplicated first.
    return new Subscription(this.#log, sink.dup(), from);
  }
}

/** The interface a fresh connection starts with. */
export class PublicApi extends RpcTarget {
  #log;

  constructor(log) {
    super();
    this.#log = log;
  }

  /** Exchange a token for the authenticated API. */
  authenticate(token) {
    const user = TOKENS.get(token);
    if (!user) throw new Error(`Unknown API token: ${token}`);
    return new AuthedApi(this.#log, user);
  }

  /** Available without authenticating, so the page has something to show. */
  serverInfo() {
    return { intervalMs: this.#log.intervalMs, maxReplay: MAX_REPLAY };
  }
}
