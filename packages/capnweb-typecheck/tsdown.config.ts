// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli.ts",
    // Universal plugin and per-bundler shim entry points. Each shim re-
    // exports the matching adapter from `unplugin` so users can pick the
    // entry name that matches their bundler.
    "src/plugin.ts",
    "src/plugins/vite.ts",
    "src/plugins/rollup.ts",
    "src/plugins/webpack.ts",
    "src/plugins/rspack.ts",
    "src/plugins/esbuild.ts",
    "src/plugins/farm.ts",
    // Private runtime helpers. The transform inserts imports from
    // "capnweb-typecheck/internal" into user modules; users never import
    // this subpath directly.
    "src/internal/runtime.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  target: "es2023",
  treeshake: true,
  clean: true,
  platform: "node",
  external: ["typescript", "capnweb"],
});
