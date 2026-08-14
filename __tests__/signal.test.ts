// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Tests for `anySignal()`, the `AbortSignal.any` shim in src/signal.ts. Covers both the native
// path (when `AbortSignal.any` exists) and the hand-rolled fallback used on runtimes that lack it.

import { expect, it, describe, afterEach } from "vitest"
import { anySignal } from "../src/signal.js"

// Run the given callback with `AbortSignal.any` removed, forcing `anySignal()` down its fallback
// path. The original is always restored, even if the callback throws.
function withoutNativeAny(fn: () => void) {
  let original = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  // @ts-expect-error - deleting an optional static for the duration of the test.
  delete AbortSignal.any;
  try {
    expect(AbortSignal.any).toBeUndefined();
    fn();
  } finally {
    if (original) Object.defineProperty(AbortSignal, "any", original);
  }
}

describe("anySignal", () => {
  afterEach(() => {
    // Guard against a test leaving `AbortSignal.any` deleted if it somehow escaped the finally.
    expect(typeof AbortSignal.any).toBe("function");
  });

  describe("native path", () => {
    it("aborts when any source aborts", () => {
      let a = new AbortController();
      let b = new AbortController();
      let composite = anySignal([a.signal, b.signal]);

      expect(composite.aborted).toBe(false);
      b.abort(new Error("boom"));
      expect(composite.aborted).toBe(true);
      expect((composite.reason as Error).message).toBe("boom");
    });

    it("is already aborted when a source is already aborted", () => {
      let a = new AbortController();
      a.abort(new Error("pre"));
      let composite = anySignal([a.signal, new AbortController().signal]);

      expect(composite.aborted).toBe(true);
      expect((composite.reason as Error).message).toBe("pre");
    });
  });

  describe("fallback path (AbortSignal.any unavailable)", () => {
    it("aborts when any source aborts later, propagating the reason", () => {
      withoutNativeAny(() => {
        let a = new AbortController();
        let b = new AbortController();
        let composite = anySignal([a.signal, b.signal]);

        expect(composite.aborted).toBe(false);
        b.abort(new Error("boom"));
        expect(composite.aborted).toBe(true);
        expect((composite.reason as Error).message).toBe("boom");
      });
    });

    it("is already aborted when a source is already aborted, propagating the reason", () => {
      withoutNativeAny(() => {
        let a = new AbortController();
        a.abort(new Error("pre"));
        let composite = anySignal([a.signal, new AbortController().signal]);

        expect(composite.aborted).toBe(true);
        expect((composite.reason as Error).message).toBe("pre");
      });
    });

    it("only fires once even if multiple sources abort", () => {
      withoutNativeAny(() => {
        let a = new AbortController();
        let b = new AbortController();
        let composite = anySignal([a.signal, b.signal]);

        let reasons: unknown[] = [];
        composite.addEventListener("abort", () => { reasons.push(composite.reason); });

        a.abort(new Error("first"));
        b.abort(new Error("second"));

        expect(reasons.length).toBe(1);
        expect((reasons[0] as Error).message).toBe("first");
      });
    });

    it("stops listening to a source once the composite has aborted", () => {
      withoutNativeAny(() => {
        let a = new AbortController();
        let b = new AbortController();
        let composite = anySignal([a.signal, b.signal]);

        a.abort(new Error("first"));

        // `b` outlives the composite; aborting it must not touch the already-settled reason, and
        // its listener should have been dropped when the composite aborted.
        b.abort(new Error("second"));
        expect((composite.reason as Error).message).toBe("first");
      });
    });
  });
});
