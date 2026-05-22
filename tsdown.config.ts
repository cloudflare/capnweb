// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { defineConfig, type UserConfig } from 'tsdown'

const common = {
  format: ['esm', 'cjs'],
  // Bun is type-only in source, but emitted declarations import it.
  deps: { neverBundle: ['cloudflare:workers', 'bun'] },
  dts: true,
  sourcemap: true,
  clean: true,

  // ES2023 includes Explicit Resource Management. Note that the library does not actually use
  // the `using` keyword, but does use `Symbol.dispose`, and automatically polyfills it if it is
  // missing.
  target: 'es2023',

  // Works in browsers, Node, and Cloudflare Workers
  platform: 'neutral',

  treeshake: true,
  minify: false, // Keep readable for debugging
} satisfies Omit<UserConfig, 'entry'>

// Build each entry independently so the published runtime entry points stay self-contained.
// In particular, workerd loads dist/index-workers.js directly and cannot resolve generated
// shared chunks that are emitted when multiple entries are bundled together.
export default defineConfig([
  {
    ...common,
    entry: ['src/index.ts'],
  },
  {
    ...common,
    entry: ['src/index-workers.ts'],
  },
  {
    ...common,
    entry: ['src/index-bun.ts'],
  },
])
