// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Tests for the `generateForPackage` flow: validators are written into
// capnweb's `_typecheck-validators` subpath and the runtime auto-binds them
// by class name without an explicit registration call.

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
    workDir = mkdtempSync(join(tmpdir(), "capnweb-typecheck-"));
    inputFile = join(workDir, "worker.ts");
    writeFileSync(inputFile, FIXTURE);
  });

  afterAll(() => {
    resetTypecheckPackage();
  });

  it("writes validators that load from capnweb/_typecheck-validators", async () => {
    generateForPackage({ input: inputFile });

    // Re-import after writing — cache-bust by appending a query string.
    let mod = await import("capnweb/_typecheck-validators?nocache=" + Date.now()) as any;
    expect(mod.validators).toBeTruthy();
    expect(mod.validators.Echo).toBeTruthy();
    expect(Object.keys(mod.validators.Echo).sort()).toEqual(["add", "ping"]);
  });

  it("validates args based on the source method signature", async () => {
    generateForPackage({ input: inputFile });
    let mod = await import("capnweb/_typecheck-validators?nocache=" + Date.now()) as any;

    expect(() => mod.validators.Echo.ping.args(["hello"])).not.toThrow();
    expect(() => mod.validators.Echo.ping.args([])).toThrow(/expected 1 argument/);
    expect(() => mod.validators.Echo.ping.args([42])).toThrow(/expected string/);
  });

  it("reset restores the null-validators stub", async () => {
    generateForPackage({ input: inputFile });
    resetTypecheckPackage();

    let mod = await import("capnweb/_typecheck-validators?nocache=" + Date.now()) as any;
    expect(mod.validators).toBeNull();
  });

  it("validates recursive types through hoisted named validators", async () => {
    let recursiveDir = mkdtempSync(join(tmpdir(), "capnweb-recursive-"));
    let recursiveInput = join(recursiveDir, "worker.ts");
    writeFileSync(recursiveInput, `
import { RpcTarget } from "capnweb";

interface Tree { name: string; children: Tree[]; }

export class TreeApi extends RpcTarget {
  size(value: Tree): number { return 0; }
}
`);
    generateForPackage({ input: recursiveInput });
    let m = await import("capnweb/_typecheck-validators?nocache=" + Date.now()) as any;

    // Valid deeply nested tree.
    let tree = { name: "root", children: [{ name: "leaf", children: [] }] };
    expect(() => m.validators.TreeApi.size.args([tree])).not.toThrow();

    // Invalid: bad type at a deep level. Must reach the validator via the
    // hoisted named function calling itself recursively.
    let bad = { name: "root", children: [{ name: 42, children: [] }] };
    expect(() => m.validators.TreeApi.size.args([bad])).toThrow(/expected string/);
  });

  it("throws RpcValidationError with structured payload on argument failures", async () => {
    generateForPackage({ input: inputFile });
    let m = await import("capnweb/_typecheck-validators?nocache=" + Date.now()) as any;
    // Import RpcValidationError from `capnweb` (i.e., the built dist) — that's
    // the same module the generated validators import from. Importing from
    // `../src/index.js` would give a different class even though both
    // construct errors with the same shape, and instanceof would fail.
    let cw = await import("capnweb") as typeof import("../src/index.js");

    try {
      m.validators.Echo.ping.args([42]);
      throw new Error("expected validator to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(cw.RpcValidationError);
      expect(err).toBeInstanceOf(TypeError);
      let v = (err as InstanceType<typeof cw.RpcValidationError>);
      expect(v.name).toBe("RpcValidationError");
      expect(v.rpcValidation.expected).toBe("string");
      expect(v.rpcValidation.actual).toBe("number");
      expect(v.rpcValidation.path).toEqual(["input"]);
      expect(v.rpcValidation.value).toBe(42);
    }
  });

  it("marks strict=true in the generated module when --strict is passed", async () => {
    generateForPackage({ input: inputFile, strict: true });
    let mod = await import("capnweb/_typecheck-validators?nocache=" + Date.now()) as any;
    expect(mod.strict).toBe(true);

    // Default (no flag) should reset to non-strict.
    generateForPackage({ input: inputFile });
    let mod2 = await import("capnweb/_typecheck-validators?nocache=" + Date.now()) as any;
    expect(mod2.strict).toBe(false);
  });

  // pnpm installs packages as hardlinks to a content-addressable store. A
  // naive `writeFileSync` would truncate the shared inode, corrupting every
  // other project that depends on the same capnweb version. The generate
  // path must unlink first so the store entry stays intact.
  it("does not corrupt a hardlinked sibling of the validators file", () => {
    let req = createRequire(__filename);
    let validatorsPath = req.resolve("capnweb/_typecheck-validators");
    let sentinelDir = mkdtempSync(join(tmpdir(), "capnweb-pnpm-"));
    let sentinel = join(sentinelDir, "shared-inode.js");

    writeFileSync(validatorsPath, "export const validators = null;\n");
    let beforeInode = statSync(validatorsPath).ino;
    linkSync(validatorsPath, sentinel);
    expect(statSync(sentinel).ino).toBe(beforeInode);

    generateForPackage({ input: inputFile });

    expect(statSync(validatorsPath).ino).not.toBe(beforeInode);
    expect(readFileSync(sentinel, "utf8")).toContain("export const validators = null");
    expect(readFileSync(validatorsPath, "utf8")).toContain("Echo");
  });
});
