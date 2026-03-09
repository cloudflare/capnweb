// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Polyfill types for Uint8Array.toBase64() / Uint8Array.fromBase64(), which have started landing
// in JS runtimes but are not supported everywhere just yet.
//
// This file is intentionally not imported by any source file. It is picked up by tsconfig.json's
// include glob for our own compilation, but excluded from the published declaration bundle (which
// only traces the import graph from entry points). This avoids leaking the optional toBase64 /
// fromBase64 declarations into consumers' global types.

declare global {
  interface Uint8Array {
    toBase64?(options?: {
      alphabet?: "base64" | "base64url",
      omitPadding?: boolean
    }): string;
  }

  interface Uint8ArrayConstructor {
    fromBase64?(text: string, options?: {
      alphabet?: "base64" | "base64url",
      lastChunkHandling?: "loose" | "strict" | "stop-before-partial"
    }): Uint8Array;
  }
}

// mark this file as a module so augmentation works correctly
export {};
