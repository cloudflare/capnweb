// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    vite: "src/vite.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2023",
  platform: "node",
  splitting: false,
  treeshake: true,
  minify: false,
  external: ["typescript", "capnweb", "capnweb/internal/typecheck"],
});
