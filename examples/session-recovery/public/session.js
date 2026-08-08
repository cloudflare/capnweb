// The whole point of this example, with no DOM in it.
//
// Everything a Cap'n Web client has to do about disconnection lives here:
// noticing one, throwing away the capabilities it invalidated, establishing a
// fresh session, and picking the event stream back up without a gap.

import { newWebSocketRpcSession, RpcTarget } from './vendor/capnweb.js';

/**
 * The object the server calls back into.
 *
 * Passing this over RPC gives the server a stub for it, and calling a method
 * on that stub is an RPC in the other direction. This is all "bidirectional
 * calling" is: there is no separate subscription mechanism.
 */
class EventSink extends RpcTarget {
  #onEvent;
  #onGap;

  constructor({ onEvent, onGap }) {
    super();
    this.#onEvent = onEvent;
    this.#onGap = onGap;
  }

  onEvent(event) {
    this.#onEvent(event);
  }

  onGap(sinceId) {
    this.#onGap(sinceId);
  }
}

/**
 * A client that reconnects.
 *
 * `report` is called with a log line for the UI; `onEvent` with each event as
 * it arrives. Everything else is internal.
 */
export class RecoveringClient {
  #url;
  #token;
  #report;
  #onEvent;
  #onStateChange;

  /** Set while connected. All four are invalidated together by a disconnect. */
  #socket = null;
  #api = null;
  #authed = null;
  #subscription = null;

  /**
   * The last authenticated stub we held, kept after teardown purely so the
   * demo can call a method on it and show what a dead stub does.
   */
  #staleAuthed = null;

  /**
   * The resume token: the id of the last event we actually processed.
   *
   * This is the only thing that survives a reconnect, and it survives because
   * it lives out here in our own state rather than in anything the session
   * owns. A stub cannot survive; a number can.
   */
  #cursor = null;

  /** Set when the caller asked to stop, to tell a deliberate close from a drop. */
  #closing = false;

  #state = 'offline';

  constructor({ url, token, report, onEvent, onStateChange }) {
    this.#url = url;
    this.#token = token;
    this.#report = report;
    this.#onEvent = onEvent;
    this.#onStateChange = onStateChange ?? (() => {});
  }

  get state() {
    return this.#state;
  }

  get cursor() {
    return this.#cursor;
  }

  #setState(state) {
    this.#state = state;
    this.#onStateChange(state);
  }

  /**
   * Connect, authenticate, and subscribe -- in one round trip.
   *
   * `authenticate()` returns a promise for the authenticated API, and we call
   * `subscribe()` on that promise without awaiting it first. That is promise
   * pipelining: the second call is sent immediately, carrying a reference to
   * the not-yet-existing result of the first.
   *
   * @param {{ resume?: boolean }} options
   *   `resume: false` deliberately throws the cursor away, so you can watch
   *   the gap appear that a resume token exists to prevent.
   */
  async connect({ resume = true } = {}) {
    if (this.#state !== 'offline') return;
    this.#closing = false;
    this.#setState('connecting');

    // We construct the socket ourselves rather than passing a URL string, so
    // that we hold it and can close it on demand. `newWebSocketRpcSession`
    // accepts either.
    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    const api = newWebSocketRpcSession(socket, undefined);
    this.#api = api;

    // Fires for any end of session: a clean close, a dropped connection, or a
    // protocol error. There is no separate "disconnected" event to listen for.
    api.onRpcBroken((error) => this.#onBroken(error));

    const sink = new EventSink({
      onEvent: (event) => {
        this.#cursor = event.id;
        this.#onEvent(event);
      },
      onGap: (sinceId) => {
        this.#report(
          `server dropped history before #${sinceId}: too far behind to replay`,
          'warn',
        );
      },
    });

    const sinceId = resume ? this.#cursor : null;

    try {
      const authed = api.authenticate(this.#token);
      const subscription = authed.subscribe(sinceId, sink);

      // One await, so everything above cost a single round trip.
      const user = await authed.whoami();

      this.#authed = authed;
      this.#subscription = subscription;
      this.#setState('online');

      this.#report(
        sinceId === null
          ? `connected as ${user.name}; streaming from now (no resume)`
          : `connected as ${user.name}; resuming after #${sinceId}`,
        'good',
      );
    } catch (error) {
      this.#report(`connect failed: ${error.message}`, 'bad');
      this.#teardown();
      this.#setState('offline');
    }
  }

  /**
   * Prove that the capability really is gone after a drop.
   *
   * Calling a method on a stub from a dead session does not hang or silently
   * no-op; it rejects. This is the check the demo runs to make the point.
   */
  async probeStaleStub() {
    const stub = this.#authed ?? this.#staleAuthed;
    if (!stub) return 'nothing to probe -- connect first';
    try {
      const user = await stub.whoami();
      return `stub still works: ${user.name}`;
    } catch (error) {
      return `stub is broken: ${error.message}`;
    }
  }

  /** Simulate losing the network. The socket dies without a clean handshake. */
  sever() {
    if (!this.#socket) return;
    this.#report('severing the connection', 'warn');
    this.#socket.close(4000, 'simulated network loss');
  }

  /** A deliberate shutdown, so `onRpcBroken` is not treated as a failure. */
  disconnect() {
    if (!this.#socket) return;
    this.#closing = true;
    this.#report('disconnecting', 'plain');

    // Disposing the main stub closes the session, and with it the connection.
    this.#api[Symbol.dispose]();
    this.#teardown();
    this.#setState('offline');
  }

  #onBroken(error) {
    if (this.#state === 'offline') return;

    this.#teardown();
    this.#setState('offline');

    if (this.#closing) return;

    this.#report(`session broken: ${error.message}`, 'bad');
    this.#report(
      this.#cursor === null
        ? 'every stub from that session is now dead'
        : `every stub from that session is now dead; cursor held at #${this.#cursor}`,
      'plain',
    );
  }

  /**
   * Drop our references to the session.
   *
   * Deliberately does *not* touch `#cursor`. Everything the session owned is
   * gone; the resume token is ours.
   */
  #teardown() {
    this.#staleAuthed = this.#authed ?? this.#staleAuthed;
    this.#socket = null;
    this.#api = null;
    this.#authed = null;
    this.#subscription = null;
  }
}
