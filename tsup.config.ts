// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { defineConfig } from 'tsup'

const common = {
  format: ['esm', 'cjs'] as const,
  dts: true,
  sourcemap: true,
  target: 'es2023' as const,
  splitting: false,
  treeshake: true,
  minify: false,
}

export default defineConfig([
  {
    ...common,
    entry: [
      'src/index.ts',
      'src/index-workers.ts',
      'src/index-bun.ts',
      // `internal-typecheck` is built only for its `.d.ts`; the `package.json`
      // exports map points the runtime path of `capnweb/internal/typecheck` at
      // `dist/index.js` so the validator runtime is shared with the main bundle.
      'src/internal-typecheck.ts',
    ],
    external: ['cloudflare:workers'],
    clean: true,
    // Works in browsers, Node, and Cloudflare Workers
    platform: 'neutral',
  },
  {
    ...common,
    entry: {
      cli: 'src/typecheck/cli.ts',
      vite: 'src/typecheck/vite.ts',
    },
    external: ['typescript'],
    clean: false,
    platform: 'node',
  },
])
