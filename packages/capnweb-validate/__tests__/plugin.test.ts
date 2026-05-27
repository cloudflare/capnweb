// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Surface tests for marker exports, plugin adapters, transform context, and
// build orchestration. Per-module rewrite behavior is covered separately.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  newHttpBatchRpcResponse,
  newHttpBatchRpcSession,
  newMessagePortRpcSession,
  newWebSocketRpcSession,
  newWorkersRpcResponse,
  newWorkersWebSocketRpcResponse,
  nodeHttpBatchRpcResponse,
  RpcSession,
  RpcValidationError,
} from "../src/capnweb.js";
import { capnwebValidate } from "../src/plugin.js";
import { createTransformContext } from "../src/transform/context.js";
import { runBuild } from "../src/transform/run.js";
import { transformModule } from "../src/transform/transform-module.js";

describe("marker APIs throw before the transform runs", () => {
  // Each marker is `uncompiledMarker` underneath. Calling any of them at
  // runtime means the plugin/CLI didn't rewrite this module; the right
  // failure mode is a loud Error pointing at the misconfiguration.
  let markers: Array<[string, (...args: unknown[]) => unknown]> = [
    ["RpcSession", RpcSession as unknown as () => unknown],
    ["newWebSocketRpcSession", newWebSocketRpcSession as (...a: unknown[]) => unknown],
    ["newHttpBatchRpcSession", newHttpBatchRpcSession as (...a: unknown[]) => unknown],
    ["newMessagePortRpcSession", newMessagePortRpcSession as (...a: unknown[]) => unknown],
    ["newWorkersRpcResponse", newWorkersRpcResponse as (...a: unknown[]) => unknown],
    ["newWorkersWebSocketRpcResponse", newWorkersWebSocketRpcResponse as (...a: unknown[]) => unknown],
    ["newHttpBatchRpcResponse", newHttpBatchRpcResponse as (...a: unknown[]) => unknown],
    ["nodeHttpBatchRpcResponse", nodeHttpBatchRpcResponse as (...a: unknown[]) => unknown],
  ];
  for (let [name, marker] of markers) {
    it(`${name} throws with a configure-the-plugin message`, () => {
      expect(() => marker()).toThrow(/capnweb-validate marker API was called before it was transformed/);
    });
  }
});

describe("RpcValidationError", () => {
  it("extends TypeError so legacy instanceof catches still match", () => {
    let err = new RpcValidationError("nope", {
      path: ["args", 0],
      expected: "string",
      actual: "number",
      value: 42,
    });
    expect(err).toBeInstanceOf(TypeError);
    expect(err.name).toBe("RpcValidationError");
  });

  it("attaches structured rpcValidation detail", () => {
    let err = new RpcValidationError("nope", {
      path: ["returns"],
      expected: "User",
      actual: "null",
      value: null,
    });
    expect(err.rpcValidation.path).toEqual(["returns"]);
    expect(err.rpcValidation.expected).toBe("User");
    expect(err.rpcValidation.actual).toBe("null");
    expect(err.rpcValidation.value).toBeNull();
  });
});

describe("TransformContext stub", () => {
  it("createTransformContext returns the documented surface", () => {
    let ctx = createTransformContext({ cwd: "/tmp" });
    expect(ctx.options).toEqual({ cwd: "/tmp" });
    expect(typeof ctx.listSourceFiles).toBe("function");
    expect(typeof ctx.invalidateFile).toBe("function");
    expect(typeof ctx.dispose).toBe("function");
  });

  it("listSourceFiles yields the Program's source files", () => {
    // Point at an empty fixture dir so the snapshot is deterministic. With
    // no `.ts` files in scope the Program reports zero source files.
    let dir = mkdtempSync(join(tmpdir(), "capnweb-validate-ctx-"));
    try {
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        files: [],
      }));
      let ctx = createTransformContext({ tsconfig: join(dir, "tsconfig.json"), cwd: dir });
      try {
        expect([...ctx.listSourceFiles()]).toEqual([]);
      } finally {
        ctx.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidateFile and dispose are safe no-ops", () => {
    let ctx = createTransformContext();
    expect(() => ctx.invalidateFile("/whatever.ts")).not.toThrow();
    expect(() => ctx.dispose()).not.toThrow();
    // dispose must be idempotent so the plugin can call it on every rebuild.
    expect(() => ctx.dispose()).not.toThrow();
  });
});

describe("transformModule fast bail-outs", () => {
  it("returns null for files that don't mention the package", () => {
    let ctx = createTransformContext();
    let result = transformModule(ctx, "/src/anywhere.ts",
        `export const x = 1;`);
    expect(result).toBeNull();
  });

  it("returns null when the file isn't in the Program", () => {
    // Use an empty Program so this fast-path test does not parse the whole
    // repository when the full suite is running under CI load.
    let dir = mkdtempSync(join(tmpdir(), "capnweb-validate-fast-bail-"));
    try {
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        files: [],
      }));
      let ctx = createTransformContext({
        tsconfig: join(dir, "tsconfig.json"),
        cwd: dir,
      });
      try {
        let result = transformModule(ctx, "/src/not-in-program.ts",
            `import { newWorkersRpcResponse } from "capnweb-validate";`);
        expect(result).toBeNull();
      } finally {
        ctx.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("unplugin adapters", () => {
  // Sanity-check that the universal plugin compiles to every adapter
  // `unplugin` advertises. Each adapter is just a property on the result of
  // `createUnplugin(...)` so this is a fast smoke test, not an integration
  // test against a real bundler.
  for (let name of ["vite", "rollup", "webpack", "rspack", "esbuild", "farm"] as const) {
    it(`exposes a ${name} adapter`, () => {
      let factory = (capnwebValidate as Record<string, unknown>)[name];
      expect(typeof factory).toBe("function");
      expect((factory as () => unknown)()).toBeDefined();
    });
  }
});


describe("CLI bin", () => {
  let workspaceBin = join(process.cwd(), "dist/cli.cjs");
  let repoBin = join(process.cwd(), "packages/capnweb-validate/dist/cli.cjs");
  let bin = existsSync(workspaceBin) ? workspaceBin : repoBin;

  it.skipIf(!existsSync(bin))("runs the published CJS help path", () => {
    let result = spawnSync(process.execPath, [bin, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("capnweb-validate build --out <dir>");
  });
});

describe("runBuild orchestration", () => {
  it("returns zero counts when the source set is empty", async () => {
    // Use an empty fixture dir + a tsconfig that includes nothing so the
    // Program's source set is empty regardless of where the test runs from.
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    let out = mkdtempSync(join(tmpdir(), "capnweb-validate-out-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        files: [],
      }));
      let result = await runBuild({ cwd: src, tsconfig: join(src, "tsconfig.json"), out });
      expect(result).toEqual({ transformed: 0, copied: 0 });
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });


  it("cleans stale output before writing the current source set", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["**/*.ts"],
      }));
      writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(src, "out"), "placeholder");
      rmSync(join(src, "out"), { force: true });
      mkdirSync(join(src, "out"), { recursive: true });
      writeFileSync(join(src, "out", "stale.ts"), "export const stale = true;\n");

      await expect(runBuild({ cwd: src, tsconfig: join(src, "tsconfig.json"), out: "out" }))
        .resolves.toEqual({ transformed: 0, copied: 1 });

      expect(existsSync(join(src, "out", "a.ts"))).toBe(true);
      expect(existsSync(join(src, "out", "stale.ts"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("refuses to use the project directory as output", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        files: [],
      }));
      await expect(runBuild({ cwd: src, tsconfig: join(src, "tsconfig.json"), out: "." }))
        .rejects.toThrow(/--out must not be the project directory/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("does not recurse into an output tree matched by tsconfig", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["**/*.ts"],
      }));
      writeFileSync(join(src, "a.ts"), "export const a = 1;\n");

      let options = {
        cwd: src,
        tsconfig: join(src, "tsconfig.json"),
        out: ".wrangler/validate",
      };
      await expect(runBuild(options)).resolves.toEqual({ transformed: 0, copied: 1 });
      await expect(runBuild(options)).resolves.toEqual({ transformed: 0, copied: 1 });

      expect(existsSync(join(src, ".wrangler/validate/a.ts"))).toBe(true);
      expect(existsSync(join(src, ".wrangler/validate/.wrangler/validate/a.ts"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
