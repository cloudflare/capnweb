// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Universal bundler plugin (vite / rollup / webpack / rspack / esbuild / farm)
// built on `unplugin`. Rewrites capnweb-validate decorators, server markers,
// and explicit validateStub() calls; nothing is written to disk.

import { sep } from "node:path";
import { createUnplugin } from "unplugin";
import {
  createTransformContext,
  fileMatchesTransformFilters,
  type TransformContext,
  type TransformContextOptions,
} from "./transform/context.js";
import { transformModule } from "./transform/transform-module.js";

export type CapnwebValidatePluginOptions = TransformContextOptions;

/** Drop a bundler query/hash suffix (`foo.ts?worker`, `foo.ts#frag`) from an id. */
function stripIdSuffix(id: string): string {
  return id.split("?", 1)[0]!.split("#", 1)[0]!;
}

/**
 * Universal `unplugin` plugin for capnweb-validate. Bundler-specific shims
 * under `src/plugins/` re-export `capnwebValidate.vite`, `.rollup`, etc.
 */
export const capnwebValidate = createUnplugin<
  CapnwebValidatePluginOptions | undefined
>((rawOptions) => {
  let options: CapnwebValidatePluginOptions = rawOptions ?? {};
  let context: TransformContext | null = null;

  return {
    name: "capnweb-validate",
    enforce: "pre",

    transformInclude(id) {
      let cleanId = stripIdSuffix(id);
      if (!/\.(?:ts|tsx|mts|cts)$/.test(cleanId)) return false;
      if (/\.d\.(?:ts|mts|cts)$/.test(cleanId)) return false;
      if (cleanId.includes(`${sep}node_modules${sep}`)) return false;
      return fileMatchesTransformFilters(cleanId, options);
    },

    transform(code, id) {
      // Fast bail-out: only modules that mention the validation package can
      // need a rewrite.
      if (!code.includes("capnweb-validate") && !code.includes("capnweb")) {
        return null;
      }
      // Strip any bundler query/hash (e.g. Vite's `?worker`) so the id matches
      // the TypeScript program's file name; otherwise getSourceFile misses and
      // the transform silently no-ops.
      let cleanId = stripIdSuffix(id);
      if (!fileMatchesTransformFilters(cleanId, options)) return null;

      if (!context) context = createTransformContext(options);
      let result = transformModule(context, cleanId, code);
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
