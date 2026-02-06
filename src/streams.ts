// Copyright (c) 2025 Cloudflare, Inc.
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
// createWritableStreamFromHook - creates a proxy WritableStream that forwards to a remote hook

// Initial window size for flow control, in bytes of serialized message data.
// TODO: Implement auto-tuning to increase the window size dynamically.
const STREAM_WINDOW_SIZE = 256 * 1024;

function createWritableStreamFromHook(hook: StubHook): WritableStream {
  let pendingError: any = undefined;
  let hookDisposed = false;

  // Window-based flow control for remote writes. When a write is sent, the serialized message size
  // is subtracted from the window. When the write response comes back, the size is added back. If
  // the window goes non-positive, the write callback returns a promise that blocks until the window
  // recovers. The WritableStream spec guarantees write() won't be called again until the previous
  // call's returned promise resolves, so at most one write can be blocked at a time.
  let window = STREAM_WINDOW_SIZE;
  let windowResolver: (() => void) | undefined;

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

      if (size !== undefined) {
        // Remote call — use window-based flow control.
        window -= size;

        // When the response comes back, add size back to the window.
        promise.then(() => {
          window += size;
          if (window > 0 && windowResolver) {
            let r = windowResolver;
            windowResolver = undefined;
            r();
          }
        }, (err) => {
          if (pendingError === undefined) {
            pendingError = err;
            controller.error(err);
            disposeHook();
          }
        });

        // If the window went non-positive, return a promise that blocks until it recovers.
        if (window <= 0) {
          return new Promise<void>(resolve => {
            windowResolver = resolve;
          });
        }
      } else {
        // Local call — await the promise directly to serialize writes (no overlapping).
        // We still need to detect errors to set pendingError.
        return promise.catch((err) => {
          if (pendingError === undefined) {
            pendingError = err;
          }
          throw err;
        });
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
          state.stream.cancel(
              new Error("ReadableStream RPC stub was disposed without being consumed"))
              .catch(() => {});  // Ignore errors from cancel.
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
