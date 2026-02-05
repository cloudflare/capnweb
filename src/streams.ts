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

function createWritableStreamFromHook(hook: StubHook): WritableStream {
  let pendingError: any = undefined;
  let hookDisposed = false;

  const disposeHook = () => {
    if (!hookDisposed) {
      hookDisposed = true;
      hook.dispose();
    }
  };

  return new WritableStream({
    write(chunk, controller) {
      // If we already have an error, fail immediately
      if (pendingError !== undefined) {
        throw pendingError;
      }

      // Create payload for the write call
      const payload = RpcPayload.fromAppParams([chunk]);
      const resultHook = hook.call(["write"], payload);

      // Fire-and-forget the RPC, but pull the result so we can detect errors. If a write fails,
      // we set pendingError to stop the application from sending more futile writes.
      // Per the RPC protocol, if any write fails, the subsequent close() will also fail, so
      // there's no need to track pending writes or await them in close().
      (async () => {
        try {
          let result = await resultHook.pull();
          result.dispose();
        } catch (err) {
          // Store the error, abort the controller, and dispose the hook.
          // We dispose immediately because the stream is now broken and the caller
          // may not call close() or abort() after seeing the error.
          if (pendingError === undefined) {
            pendingError = err;
            controller.error(err);
            disposeHook();
          }
        }
      })();

      // Don't await - return immediately for pipelining.
      // Errors will be caught asynchronously and reported via controller.error().
      // TODO: Actually, return a promise for flow control purposes.
    },

    async close() {
      if (pendingError !== undefined) {
        disposeHook();
        throw pendingError;
      }

      // Send close(). Per the RPC protocol, if any previous write failed, close() will also
      // fail with that error -- so there's no need to await pending writes first.
      const payload = RpcPayload.fromAppParams([]);
      const resultHook = hook.call(["close"], payload);

      try {
        const result = await resultHook.pull();
        result.dispose();
      } catch (err) {
        // If a write error was detected (possibly while we were waiting for close()), prefer
        // throwing that, since the close error is likely just a consequence (e.g. "can't close
        // errored stream").
        throw pendingError ?? err;
      } finally {
        // Dispose the hook now that we're done
        disposeHook();
      }
    },

    abort(reason) {
      // If we already have an error, the hook has already been disposed.
      if (pendingError !== undefined) {
        return;
      }

      // Set pendingError so that any subsequent write() or close() calls fail immediately.
      pendingError = reason ?? new Error("WritableStream was aborted");

      // Send abort()
      const payload = RpcPayload.fromAppParams([reason]);
      const resultHook = hook.call(["abort"], payload);

      // Fire-and-forget, then dispose
      Promise.resolve(resultHook.pull()).then(
        (p: RpcPayload) => { p.dispose(); disposeHook(); },
        (_: any) => { disposeHook(); }
      );
    }
  });
}

// =======================================================================================
// Install the implementations into streamImpl

streamImpl.createWritableStreamHook = WritableStreamStubHook.create;
streamImpl.createWritableStreamFromHook = createWritableStreamFromHook;

export function forceInitStreams() {}
