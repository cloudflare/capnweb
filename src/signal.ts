// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Alternative for AbortSignal.any.
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (AbortSignal.any) {
    // Prefer the native version if available.
    return AbortSignal.any(signals);
  }

  let controller = new AbortController();

  for (let signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
  }

  for (let signal of signals) {
    signal.addEventListener("abort", () => {
      controller.abort(signal.reason);
    }, {
      once: true,

      // Drop this listener as soon as the composite aborts, whichever source caused it. Otherwise
      // a source signal that outlives the composite retains a listener.
      signal: controller.signal,
    });
  }

  return controller.signal;
}
