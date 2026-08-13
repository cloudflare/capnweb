// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Install these before defining computed Symbol.dispose methods below. Browsers without Explicit
// Resource Management would otherwise create the handles with an undefined property key.
if (!Symbol.dispose) {
  (Symbol as any).dispose = Symbol.for('dispose');
}
if (!Symbol.asyncDispose) {
  (Symbol as any).asyncDispose = Symbol.for('asyncDispose');
}

export const NOOP_DISPOSABLE: Disposable = {
  [Symbol.dispose]() {}
};

export function makeDisposable(callback: () => void): Disposable {
  let active = true;
  return {
    [Symbol.dispose]() {
      if (active) {
        active = false;
        callback();
      }
    }
  };
}

// A disposable whose implementation may become available later, such as an onRpcBroken()
// registration made on an unresolved promise. If it is disposed before set() is called, the
// eventual implementation is disposed immediately.
export class DeferredDisposable implements Disposable {
  private inner?: Disposable;
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  set(inner: Disposable): void {
    if (this.disposed) {
      inner[Symbol.dispose]();
    } else {
      this.inner = inner;
    }
  }

  [Symbol.dispose](): void {
    if (!this.disposed) {
      this.disposed = true;
      this.inner?.[Symbol.dispose]();
      this.inner = undefined;
    }
  }
}
