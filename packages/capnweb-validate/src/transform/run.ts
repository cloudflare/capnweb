// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Build-time driver used by the CLI. Walks the configured source set,
// runs the per-module transform, and writes results under `out`. Files
// the transform leaves alone are copied verbatim so `out/` is a complete
// drop-in replacement for the original source tree.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  createTransformContext,
  TransformContextOptions,
} from "./context.js";
import { transformModule } from "./transform-module.js";

export type BuildOptions = TransformContextOptions & {
  out: string;
};

export type BuildResult = {
  transformed: number;
  copied: number;
  /** Source files skipped because they map outside --out (outside cwd). */
  skipped: number;
};

function isInsideOrEqual(parent: string, child: string): boolean {
  let rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  let cwd = resolve(options.cwd ?? process.cwd());
  let out = resolve(cwd, options.out);
  if (isInsideOrEqual(out, cwd)) {
    throw new Error(
      `capnweb-validate: --out must not be the project directory or a parent ` +
      `of it (cwd=${cwd}, out=${out}).`,
    );
  }

  // Remove stale output before building. Do this before creating the TS Program
  // so deleted/renamed files from a previous run cannot stay in the source set.
  await rm(out, { recursive: true, force: true });

  let context = createTransformContext({
    ...options,
    tsconfig: options.tsconfig ?? "tsconfig.json",
  });
  let transformed = 0;
  let copied = 0;
  let skippedOutside: string[] = [];
  try {
    for (let id of context.listSourceFiles()) {
      if (isInsideOrEqual(out, id)) continue;
      let dest = resolve(out, relative(cwd, id));
      // A source file outside cwd (e.g. an included sibling dir) maps to a dest
      // that escapes --out and could clobber unrelated files. Skip it rather
      // than write outside the requested output tree; warned once below.
      if (!isInsideOrEqual(out, dest)) {
        skippedOutside.push(id);
        continue;
      }
      let code = await readFile(id, "utf8");
      let result = transformModule(context, id, code);
      await mkdir(dirname(dest), { recursive: true });
      if (result) {
        await writeFile(dest, result.code);
        transformed++;
      } else {
        await writeFile(dest, code);
        copied++;
      }
    }
  } finally {
    context.dispose();
  }
  // One consolidated warning, not one per file (shared sibling dirs are common).
  if (skippedOutside.length > 0) {
    console.warn(
      `capnweb-validate: skipped ${skippedOutside.length} file(s) outside the ` +
      `project directory (cwd=${cwd}); they cannot be written under --out, so ` +
      `they are not validated (e.g. ${skippedOutside[0]}).`,
    );
  }
  return { transformed, copied, skipped: skippedOutside.length };
}
