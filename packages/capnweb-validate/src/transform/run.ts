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

  let context = createTransformContext(options);
  let transformed = 0;
  let copied = 0;
  try {
    for (let id of context.listSourceFiles()) {
      if (isInsideOrEqual(out, id)) continue;
      let code = await readFile(id, "utf8");
      let result = transformModule(context, id, code);
      let dest = resolve(out, relative(cwd, id));
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
  return { transformed, copied };
}
