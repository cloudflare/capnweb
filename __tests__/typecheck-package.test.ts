// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Tests for the `generateForPackage` flow: validators are written into the
// resolved `capnweb-typecheck` placeholder and the runtime auto-binds them by
// class name without an explicit registration call.

import { linkSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateForPackage,
  resetTypecheckPackage,
} from "../src/typecheck/generate.js";

const FIXTURE = `
import { RpcTarget } from "capnweb";

export class Echo extends RpcTarget {
  ping(input: string): string {
    return input;
  }
  add(a: number, b: number): number {
    return a + b;
  }
}
`;

describe("generateForPackage", () => {
  let workDir: string;
  let inputFile: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "capnweb-pkg-"));
    inputFile = join(workDir, "worker.ts");
    writeFileSync(inputFile, FIXTURE);
  });

  afterAll(() => {
    resetTypecheckPackage();
  });

  it("writes validators that load from capnweb-typecheck", async () => {
    generateForPackage({ input: inputFile });

    // Re-import after writing — cache-bust by appending a query string.
    let mod = await import("capnweb-typecheck?nocache=" + Date.now()) as any;
    expect(mod.validators).toBeTruthy();
    expect(mod.validators.Echo).toBeTruthy();
    expect(Object.keys(mod.validators.Echo).sort()).toEqual(["add", "ping"]);
  });

  it("validates args based on the source method signature", async () => {
    generateForPackage({ input: inputFile });
    let mod = await import("capnweb-typecheck?nocache=" + Date.now()) as any;

    // Valid call passes.
    expect(() => mod.validators.Echo.ping.args(["hello"])).not.toThrow();
    // Wrong arity throws.
    expect(() => mod.validators.Echo.ping.args([])).toThrow(/expected 1 argument/);
    // Wrong type throws.
    expect(() => mod.validators.Echo.ping.args([42])).toThrow(/expected string/);
  });

  it("reset restores the null-validators stub", async () => {
    generateForPackage({ input: inputFile });
    resetTypecheckPackage();

    let mod = await import("capnweb-typecheck?nocache=" + Date.now()) as any;
    expect(mod.validators).toBeNull();
  });

  // pnpm installs packages as hardlinks to a content-addressable store. A
  // naive `writeFileSync` would truncate the shared inode, corrupting every
  // other project that depends on the same capnweb-typecheck version. The
  // generate path must unlink first so the store entry stays intact.
  it("does not corrupt a hardlinked sibling of capnweb-typecheck/index.js", () => {
    let req = createRequire(__filename);
    let pkgIndex = req.resolve("capnweb-typecheck");
    let pkgDir = dirname(pkgIndex);
    let sentinelDir = mkdtempSync(join(tmpdir(), "capnweb-pnpm-"));
    let sentinel = join(sentinelDir, "shared-inode.js");

    // Put a stub in place we control, then hardlink the sentinel to it.
    writeFileSync(pkgIndex, "export const validators = null;\n");
    let beforeInode = statSync(pkgIndex).ino;
    linkSync(pkgIndex, sentinel);
    expect(statSync(sentinel).ino).toBe(beforeInode);

    generateForPackage({ input: inputFile });

    // After codegen, the package index lives at a fresh inode and the
    // hardlinked sentinel still points at the original stub content.
    expect(statSync(pkgIndex).ino).not.toBe(beforeInode);
    expect(readFileSync(sentinel, "utf8")).toContain("export const validators = null");
    expect(readFileSync(pkgIndex, "utf8")).toContain("Echo");
  });
});
