// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/index-workers.ts'],
  format: ['esm'],
  external: ['cloudflare:workers'],
  dts: true,
  sourcemap: true,
  clean: true,

  // ES2023 includes Explicit Resource Management. Note that the library does not actually use
  // the `using` keyword, but does use `Symbol.dispose`, and automatically polyfills it if it is
  // missing.
  target: 'es2023',

  // Works in browsers, Node, and Cloudflare Workers
  platform: 'neutral',

  splitting: false,
  treeshake: true,
  minify: false, // Keep readable for debugging
})