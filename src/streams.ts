// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import {
  StubHook, RpcPayload, PropertyPath, ErrorStubHook, PayloadStubHook, PromiseStubHook, streamImpl
} from "./core.js";

// =======================================================================================
// WritableStreamStubHook - wraps a local WritableStream for export

// Many WritableStreamStubHooks could point at the same WritableStream. We store a refcount in a
// separate object that they all share.
type BoxedWriterState = {
  refcount: number;
  writer: WritableStreamDefaultWriter;
  closed: boolean;
};

class WritableStreamStubHook extends StubHook {
  private state?: BoxedWriterState;  // undefined when disposed

  // Creates a new WritableStreamStubHook that is not duplicated from an existing hook.
  static create(stream: WritableStream): WritableStreamStubHook {
    let writer = stream.getWriter();  // Locks the stream
    return new WritableStreamStubHook({ refcount: 1, writer, closed: false });
  }

  private constructor(state: BoxedWriterState, dupFrom?: WritableStreamStubHook) {
    super();
    this.state = state;
    if (dupFrom) {
      ++state.refcount;
    }
  }

  private getState(): BoxedWriterState {
    if (this.state) {
      return this.state;
    } else {
      throw new Error("Attempted to use a WritableStreamStubHook after it was disposed.");
    }
  }

  call(path: PropertyPath, args: RpcPayload): StubHook {
    try {
      let state = this.getState();

      if (path.length !== 1 || typeof path[0] !== "string") {
        throw new Error("WritableStream stub only supports direct method calls");
      }

      const method = path[0];

      if (method !== "write" && method !== "close" && method !== "abort") {
        args.dispose();
        throw new Error(`Unknown WritableStream method: ${method}`);
      }

      // Mark as closed if close() or abort() is called.
      if (method === "close" || method === "abort") {
        state.closed = true;
      }

      let func = state.writer[method] as Function;
      let promise = args.deliverCall(func, state.writer);
      return new PromiseStubHook(promise.then(payload => new PayloadStubHook(payload)));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }

  map(path: PropertyPath, captures: StubHook[], instructions: unknown[]): StubHook {
    // WritableStreams don't support map operations.
    for (let cap of captures) {
      cap.dispose();
    }
    return new ErrorStubHook(new Error("Cannot use map() on a WritableStream"));
  }

  get(path: PropertyPath): StubHook {
    // WritableStreams don't expose properties over RPC.
    return new ErrorStubHook(new Error("Cannot access properties on a WritableStream stub"));
  }

  dup(): StubHook {
    let state = this.getState();
    return new WritableStreamStubHook(state, this);
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    // WritableStreams can't be pulled - they're not promises.
    return Promise.reject(new Error("Cannot pull a WritableStream stub"));
  }

  ignoreUnhandledRejections(): void {
    // Nothing to do.
  }

  dispose(): void {
    let state = this.state;
    this.state = undefined;
    if (state) {
      if (--state.refcount === 0) {
        if (!state.closed) {
          // Abort the stream if not cleanly closed.
          state.writer.abort(new Error("WritableStream RPC stub was disposed without calling close()"))
              .catch(() => {});  // Ignore errors from abort.
        }
        state.writer.releaseLock();
      }
    }
  }

  onBroken(callback: (error: any) => void): void {
    // WritableStream stubs don't really have a "broken" state in the same way.
    // The caller would notice when write/close/abort fails.
  }
}

// =======================================================================================
// FlowController - BDP-based dynamic flow control for stream writes
//
// Estimates the bandwidth-delay product (BDP) of a stream by observing write sends and acks,
// and dynamically adjusts the window size to match. The window is set to the estimated BDP
// multiplied by a growth factor, so that the sender always pushes slightly more than the
// estimated capacity — naturally probing for increased bandwidth.
//
// The algorithm works in two phases:
// - Startup: The window is allowed to double each RTT (STARTUP_GROWTH_FACTOR = 2), enabling
//   rapid discovery of available bandwidth. Startup ends when the window stops growing
//   meaningfully for STARTUP_EXIT_ROUNDS consecutive RTT rounds.
// - Steady state: The window grows by at most STEADY_GROWTH_FACTOR (1.25) per RTT and
//   shrinks by at most DECAY_FACTOR (0.90) per RTT, providing stability.

// Flow control constants — tunable.
//
// Initial window size in bytes. Used before we have any bandwidth estimate.
const INITIAL_WINDOW = 256 * 1024;
// Maximum window size in bytes.
const MAX_WINDOW = 1024 * 1024 * 1024;
// Minimum window size in bytes.
const MIN_WINDOW = 64 * 1024;
// During startup, we allow the window to grow by up to this factor per RTT.
const STARTUP_GROWTH_FACTOR = 2;
// In steady state, we allow the window to grow by up to this factor per RTT.
const STEADY_GROWTH_FACTOR = 1.25;
// Allowed reduction in window size per RTT.
const DECAY_FACTOR = 0.90;
// Number of consecutive non-increasing ack rounds before exiting startup.
const STARTUP_EXIT_ROUNDS = 3;

// Opaque token returned by onSend() that must be passed back to onAck(). Carries the
// send-time snapshot needed to compute delivery rate and apply the window collar.
export type SendToken = {
  sentTime: number;
  size: number;
  deliveredAtSend: number;
  deliveredTimeAtSend: number;
  windowAtSend: number;
  windowFullAtSend: boolean;
};

// Exported for testing purposes only -- otherwise this is only used internally by
// createWritableStreamFromHook().
export class FlowController {
  // The current window size in bytes. The sender blocks when bytesInFlight >= window.
  window = INITIAL_WINDOW;

  // Total bytes currently in flight (sent but not yet acked).
  bytesInFlight = 0;

  // Whether we're still in the startup phase.
  inStartupPhase = true;

  // ----- BDP estimation state (private) -----

  // Total bytes acked so far.
  private delivered = 0;
  // Time of most recent ack.
  private deliveredTime = 0;
  // Time when the very first ack was received.
  private firstAckTime = 0;
  private firstAckDelivered = 0;
  // Global minimum RTT observed (milliseconds).
  private minRtt = Infinity;

  // For startup exit: count of consecutive RTT rounds where the window didn't meaningfully grow.
  private roundsWithoutIncrease = 0;
  // Window size at the start of the current round, for startup exit detection.
  private lastRoundWindow = 0;
  // Time when the current round started.
  private roundStartTime = 0;

  constructor(private now: () => number) {}

  // Called when a write of `size` bytes is about to be sent. Returns a token that must be
  // passed to onAck() when the ack arrives, and whether the sender should block (window full).
  onSend(size: number): { token: SendToken, shouldBlock: boolean } {
    this.bytesInFlight += size;

    let token: SendToken = {
      sentTime: this.now(),
      size,
      deliveredAtSend: this.delivered,
      deliveredTimeAtSend: this.deliveredTime,
      windowAtSend: this.window,
      windowFullAtSend: this.bytesInFlight >= this.window,
    };

    return { token, shouldBlock: token.windowFullAtSend };
  }

  // Called when a previously-sent write fails. Restores bytesInFlight without updating
  // any BDP estimates.
  onError(token: SendToken): void {
    this.bytesInFlight -= token.size;
  }

  // Called when an ack is received for a previously-sent write. Updates BDP estimates and
  // the window. Returns whether a blocked sender should now unblock.
  onAck(token: SendToken): boolean {
    let ackTime = this.now();

    // Update delivery tracking metrics.
    this.delivered += token.size;
    this.deliveredTime = ackTime;
    this.bytesInFlight -= token.size;

    // Update RTT estimate.
    let rtt = ackTime - token.sentTime;
    this.minRtt = Math.min(this.minRtt, rtt);

    // Update bandwidth estimate and window.
    if (this.firstAckTime === 0) {
      // This is the very first ack. We can't estimate bandwidth yet since we need to look
      // at the interval between acks.
      this.firstAckTime = ackTime;
      this.firstAckDelivered = this.delivered;
    } else {
      let baseTime;
      let baseDelivered;

      if (token.deliveredTimeAtSend === 0) {
        // This write was sent before any acks had been received, but wasn't the very first
        // write. We can estimate bandwidth starting from the first ack.
        baseTime = this.firstAckTime;
        baseDelivered = this.firstAckDelivered;
      } else {
        baseTime = token.deliveredTimeAtSend;
        baseDelivered = token.deliveredAtSend;
      }

      let interval = ackTime - baseTime;
      let bytes = this.delivered - baseDelivered;
      let bandwidth = bytes / interval;

      // Choose our target growth factor depending on whether we're at startup or steady
      // state.
      let growthFactor = this.inStartupPhase ? STARTUP_GROWTH_FACTOR : STEADY_GROWTH_FACTOR;

      // Calculate new window to be our calculated bandwidth-delay product, plus a growth
      // factor to account for the possibility that bandwidth is constrained only due to
      // the window having been too small.
      let newWindow = bandwidth * this.minRtt * growthFactor;

      // Don't allow the window to grow too quickly -- it can only grow by at most
      // `growthFactor` for each RTT.
      newWindow = Math.min(newWindow, token.windowAtSend * growthFactor);

      if (token.windowFullAtSend) {
        // Don't allow the window to shrink too quickly.
        newWindow = Math.max(newWindow, token.windowAtSend * DECAY_FACTOR);
      } else {
        // Don't allow the window to shrink at all if we weren't saturating it -- in this
        // case the sending app is not fully utilizing the connection, so no backpressure is
        // needed. We clamp to this.window here, not this.windowAtSend, since we don't want to
        // undo previous shrinkage, when alternating between sends that saturated and ones that
        // didn't.
        newWindow = Math.max(newWindow, this.window);
      }

      // Clamp to min/max values.
      this.window = Math.max(Math.min(newWindow, MAX_WINDOW), MIN_WINDOW);

      // Check if the startup phase is done.
      if (this.inStartupPhase && token.sentTime >= this.roundStartTime) {
        if (this.window > this.lastRoundWindow * STEADY_GROWTH_FACTOR) {
          // Saw a significant increase this round, so reset the counter.
          this.roundsWithoutIncrease = 0;
        } else {
          // Window size didn't increase enough this round.
          if (++this.roundsWithoutIncrease >= STARTUP_EXIT_ROUNDS) {
            // After three rounds with insufficient increase, exit startup mode.
            this.inStartupPhase = false;
          }
        }

        // Advance to next round.
        this.roundStartTime = ackTime;
        this.lastRoundWindow = this.window;
      }
    }

    return this.bytesInFlight < this.window;
  }
}

// =======================================================================================
// createWritableStreamFromHook - creates a proxy WritableStream that forwards to a remote hook

function createWritableStreamFromHook(hook: StubHook): WritableStream {
  let pendingError: any = undefined;
  let hookDisposed = false;

  let fc = new FlowController(() => performance.now());

  // If a previous write blocked waiting for the window to open, this resolver will unblock it.
  let windowResolve: (() => void) | undefined;
  let windowReject: ((e: unknown) => void) | undefined;

  const disposeHook = () => {
    if (!hookDisposed) {
      hookDisposed = true;
      hook.dispose();
    }
  };

  return new WritableStream({
    write(chunk, controller) {
      // If we already have an error, fail immediately.
      if (pendingError !== undefined) {
        throw pendingError;
      }

      const payload = RpcPayload.fromAppParams([chunk]);
      const { promise, size } = hook.stream(["write"], payload);

      if (size === undefined) {
        // Local call — await the promise directly to serialize writes (no overlapping).
        // We still need to detect errors to set pendingError.
        return promise.catch((err) => {
          if (pendingError === undefined) {
            pendingError = err;
          }
          throw err;
        });
      } else {
        // Remote call — use window-based flow control.
        let { token, shouldBlock } = fc.onSend(size);

        // When the response comes back, update the window size based on BDP estimates.
        promise.then(() => {
          let hasCapacity = fc.onAck(token);

          if (hasCapacity && windowResolve) {
            windowResolve();
            windowResolve = undefined;
            windowReject = undefined;
          }
        }, (err) => {
          fc.onError(token);
          if (pendingError === undefined) {
            pendingError = err;
            controller.error(err);
            disposeHook();
          }
          // Unblock any write waiting on backpressure -- reject it so the
          // stream finishes erroring instead of hanging forever.
          if (windowReject) {
            windowReject(err);
            windowResolve = undefined;
            windowReject = undefined;
          }
        });

        // If we've filled (or exceeded) the window, block until acks free up space.
        if (shouldBlock) {
          return new Promise<void>((resolve, reject) => {
            windowResolve = resolve;
            windowReject = reject;
          });
        }
      }
    },

    async close() {
      if (pendingError !== undefined) {
        disposeHook();
        throw pendingError;
      }

      // Send close(). Per the RPC protocol, if any previous write failed, close() will also
      // fail with that error -- so there's no need to await pending writes first.
      const { promise } = hook.stream(["close"], RpcPayload.fromAppParams([]));

      try {
        await promise;
      } catch (err) {
        // If a write error was detected (possibly while we were waiting for close()), prefer
        // throwing that, since the close error is likely just a consequence (e.g. "can't close
        // errored stream").
        throw pendingError ?? err;
      } finally {
        disposeHook();
      }
    },

    abort(reason) {
      if (pendingError !== undefined) {
        return;
      }

      pendingError = reason ?? new Error("WritableStream was aborted");
      if (windowReject) {
        windowReject(pendingError);
        windowResolve = undefined;
        windowReject = undefined;
      }

      const { promise } = hook.stream(["abort"], RpcPayload.fromAppParams([reason]));
      promise.then(() => disposeHook(), () => disposeHook());
    }
  });
}

// =======================================================================================
// ReadableStreamStubHook - wraps a local ReadableStream for disposal tracking
//
// This hook exists solely to live in RpcPayload.hooks so that the ReadableStream is properly
// disposed (canceled) when the payload is disposed. It does not handle any RPC operations --
// the actual data transfer is handled by pumping the stream into a pipe's WritableStream via
// pipeTo(). All methods other than dispose(), dup(), and ignoreUnhandledRejections() throw errors.

// Many ReadableStreamStubHooks could point at the same ReadableStream. We store a refcount in a
// separate object that they all share.
type BoxedReadableState = {
  refcount: number;
  stream: ReadableStream;
  canceled: boolean;
};

class ReadableStreamStubHook extends StubHook {
  private state?: BoxedReadableState;  // undefined when disposed

  // Creates a new ReadableStreamStubHook.
  static create(stream: ReadableStream): ReadableStreamStubHook {
    return new ReadableStreamStubHook({ refcount: 1, stream, canceled: false });
  }

  private constructor(state: BoxedReadableState, dupFrom?: ReadableStreamStubHook) {
    super();
    this.state = state;
    if (dupFrom) {
      ++state.refcount;
    }
  }

  call(path: PropertyPath, args: RpcPayload): StubHook {
    args.dispose();
    return new ErrorStubHook(new Error("Cannot call methods on a ReadableStream stub"));
  }

  map(path: PropertyPath, captures: StubHook[], instructions: unknown[]): StubHook {
    for (let cap of captures) {
      cap.dispose();
    }
    return new ErrorStubHook(new Error("Cannot use map() on a ReadableStream"));
  }

  get(path: PropertyPath): StubHook {
    return new ErrorStubHook(new Error("Cannot access properties on a ReadableStream stub"));
  }

  dup(): StubHook {
    let state = this.state;
    if (!state) {
      throw new Error("Attempted to dup a ReadableStreamStubHook after it was disposed.");
    }
    return new ReadableStreamStubHook(state, this);
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    return Promise.reject(new Error("Cannot pull a ReadableStream stub"));
  }

  ignoreUnhandledRejections(): void {
    // Nothing to do.
  }

  dispose(): void {
    let state = this.state;
    this.state = undefined;
    if (state) {
      if (--state.refcount === 0) {
        if (!state.canceled) {
          state.canceled = true;

          // Don't try to cancel the stream if it's locked. It won't work anyway -- it'll throw
          // an exception, which we'd ignore anyway.
          //
          // This is a little janky but it makes some sense: If someone has locked the stream, they
          // have taken responsibility for fully reading it. The only reason we really need to
          // cancel when this hook is disposed is to handle the case where an application receives
          // a ReadableStream but completely ignores it -- we want it to be canceled naturally when
          // the payload is disposed.
          if (!state.stream.locked) {
            state.stream.cancel(
                new Error("ReadableStream RPC stub was disposed without being consumed"))
                .catch(() => {});  // Ignore errors from cancel.
          }
        }
      }
    }
  }

  onBroken(callback: (error: any) => void): void {
    // ReadableStream stubs don't have a "broken" state.
  }
}

// =======================================================================================
// Install the implementations into streamImpl

streamImpl.createWritableStreamHook = WritableStreamStubHook.create;
streamImpl.createWritableStreamFromHook = createWritableStreamFromHook;
streamImpl.createReadableStreamHook = ReadableStreamStubHook.create;

export function forceInitStreams() {}
