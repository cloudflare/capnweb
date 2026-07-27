// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Vite 8 lowers TypeScript with oxc, which refuses to lower native decorators.
// The transform runs before the bundler sees the file, so `@validateRpc()` is
// already gone by then and oxc never has to lower anything. Without the plugin
// the decorator reaches oxc untouched and the marker throws at runtime with
// "called before it was transformed".

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite8";

import { capnwebValidate } from "../src/plugin.js";

let fixture = join(import.meta.dirname, "fixtures", "vite8");
let repoNodeModules = join(import.meta.dirname, "..", "..", "..", "node_modules");
let scratch = mkdtempSync(join(realpathSync(tmpdir()), "capnweb-validate-vite8-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function buildFixture(name: string, withPlugin: boolean) {
  let root = join(scratch, name);
  cpSync(fixture, root, { recursive: true });
  symlinkSync(repoNodeModules, join(root, "node_modules"));

  let outDir = join(root, "dist");
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    resolve: {
      alias: { "cloudflare:workers": join(root, "shims", "cloudflare-workers.js") },
    },
    plugins: withPlugin
      ? [capnwebValidate.vite({ tsconfig: join(root, "tsconfig.json") })]
      : [],
    build: {
      lib: { entry: "src/worker.ts", formats: ["es"], fileName: "worker" },
      minify: false,
      outDir,
      emptyOutDir: true,
    },
  });

  return readFileSync(join(outDir, "worker.mjs"), "utf8");
}

describe("vite 8", () => {
  it("lowers the decorator when the plugin is installed", async () => {
    let code = await buildFixture("with-plugin", true);
    expect(code).toContain("__validateRpcClass");
    expect(code).not.toMatch(/@validateRpc\(\)/);
    expect(code).not.toMatch(/uncompiledDecoratorMarker/);
  });

  it("leaves the decorator for oxc when the plugin is missing", async () => {
    let code = await buildFixture("no-plugin", false);
    expect(code).not.toContain("__validateRpcClass");
    expect(code).toMatch(/@validateRpc\(\)/);
  });
});
