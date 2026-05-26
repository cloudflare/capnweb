// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Universal bundler plugin (vite / rollup / webpack / rspack / esbuild / farm)
// built on `unplugin`. Rewrites user modules that import marker APIs from
// "capnweb-typecheck"; nothing is written to disk.

import { sep } from "node:path";
import { createUnplugin } from "unplugin";
import {
  createTransformContext,
  type TransformContext,
  type TransformContextOptions,
} from "./transform/context.js";
import { transformModule } from "./transform/transform-module.js";

export type CapnwebTypecheckPluginOptions = TransformContextOptions;

/**
 * Universal `unplugin` plugin for capnweb-typecheck. Bundler-specific shims
 * under `src/plugins/` re-export `capnwebTypecheck.vite`, `.rollup`, etc.
 */
export const capnwebTypecheck = createUnplugin<
    CapnwebTypecheckPluginOptions | undefined>((rawOptions) => {
  let options: CapnwebTypecheckPluginOptions = rawOptions ?? {};
  let context: TransformContext | null = null;

  return {
    name: "capnweb-typecheck",
    enforce: "pre",

    transformInclude(id) {
      let cleanId = id.split("?", 1)[0]!.split("#", 1)[0]!;
      if (!/\.(?:ts|tsx|mts|cts)$/.test(cleanId)) return false;
      if (/\.d\.(?:ts|mts|cts)$/.test(cleanId)) return false;
      if (cleanId.includes(`${sep}node_modules${sep}`)) return false;
      return true;
    },

    transform(code, id) {
      // Fast bail-out: modules that don't even mention the package can't need
      // a rewrite.
      if (!code.includes("capnweb-typecheck")) return null;

      if (!context) context = createTransformContext(options);
      let result = transformModule(context, id, code);
      if (!result) return null;
      return { code: result.code };
    },

    watchChange(id) {
      if (context) context.invalidateFile(id);
    },

    buildEnd() {
      if (context) {
        context.dispose();
        context = null;
      }
    },
  };
});

export default capnwebTypecheck;
