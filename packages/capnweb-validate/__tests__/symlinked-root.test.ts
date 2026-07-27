// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Regression: a project reached through a symlinked directory (`/tmp` ->
// `/private/tmp` on macOS, or any linked checkout) makes bundlers report ids
// with symlinks resolved while the tsconfig-derived Program keeps the linked
// spelling. The rewrite used to silently no-op, so the decorator survived the
// build and the marker threw "called before it was transformed" at runtime.

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";

import { capnwebValidate } from "../src/plugin.js";

let fixture = join(import.meta.dirname, "fixtures", "symlinked-root");
let repoNodeModules = join(import.meta.dirname, "..", "..", "..", "node_modules");
let scratch = mkdtempSync(join(realpathSync(tmpdir()), "capnweb-validate-symlink-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("project reached through a symlinked directory", () => {
  it("still rewrites the decorator", async () => {
    // `real` is the path the bundler reports; `linked` is the path the plugin
    // options (and so the Program's file names) are spelled with.
    let real = join(scratch, "real");
    let linked = join(scratch, "linked");
    cpSync(fixture, real, { recursive: true });
    symlinkSync(repoNodeModules, join(real, "node_modules"));
    symlinkSync(real, linked);

    let outDir = join(scratch, "out");
    await build({
      root: linked,
      configFile: false,
      logLevel: "silent",
      resolve: {
        alias: {
          "cloudflare:workers": join(linked, "shims", "cloudflare-workers.js"),
        },
      },
      plugins: [capnwebValidate.vite({ tsconfig: join(linked, "tsconfig.json") })],
      build: {
        lib: { entry: "src/worker.ts", formats: ["es"], fileName: "worker" },
        minify: false,
        outDir,
        emptyOutDir: true,
      },
    });

    let code = readFileSync(join(outDir, "worker.mjs"), "utf8");
    expect(code).toContain("__validateRpcClass");
    expect(code).not.toMatch(/uncompiledDecoratorMarker/);
  });
});
