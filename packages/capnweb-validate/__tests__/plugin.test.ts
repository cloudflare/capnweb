// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Surface tests for marker exports, plugin adapters, transform context, and
// build orchestration. Per-module rewrite behavior is covered separately.

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("capnweb", () => ({
  deserialize() {},
  serialize() {},
  RpcPromise: function RpcPromise() {},
  RpcSession: function RpcSession() {},
  RpcStub: function RpcStub() {},
  RpcTarget: class RpcTarget {},
  newHttpBatchRpcResponse() {},
  newHttpBatchRpcSession() {},
  newMessagePortRpcSession() {},
  newWebSocketRpcSession() {},
  newWorkersRpcResponse() {},
  newWorkersWebSocketRpcResponse() {},
  nodeHttpBatchRpcResponse() {},
}));

import {
  newHttpBatchRpcResponse,
  newWorkersRpcResponse,
  newWorkersWebSocketRpcResponse,
  nodeHttpBatchRpcResponse,
} from "../src/capnweb.js";
import { __validateStub } from "../src/internal/core.js";
import { validateStub } from "../src/index.js";
import { capnwebValidate } from "../src/plugin.js";
import { createTransformContext } from "../src/transform/context.js";
import { runBuild } from "../src/transform/run.js";
import { transformModule } from "../src/transform/transform-module.js";
import { createVirtualTransformContext } from "./helpers.js";

describe("marker APIs throw before the transform runs", () => {
  // Each marker is `uncompiledMarker` underneath. Calling any of them at
  // runtime means the plugin/CLI didn't rewrite this module; the right
  // failure mode is a loud Error pointing at the misconfiguration.
  let markers: Array<[string, (...args: unknown[]) => unknown]> = [
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

describe("validateStub marker API", () => {
  it("throws before the transform runs", () => {
    expect(() => validateStub<unknown>({})).toThrow(
      /capnweb-validate validateStub\(\) was called before it was transformed/
    );
  });

  it("is exported from the internal runtime for transformed code", () => {
    expect(typeof __validateStub).toBe("function");
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
    let ctx = createVirtualTransformContext();
    try {
      let result = transformModule(ctx, "/src/anywhere.ts",
          `export const x = 1;`);
      expect(result).toBeNull();
    } finally {
      ctx.dispose();
    }
  });

  it("returns null when the file isn't in the Program", () => {
    let ctx = createVirtualTransformContext({
      worker: `export const inProgram = true;`,
    });
    try {
      let result = transformModule(ctx, "/src/not-in-program.ts",
          `import { newWorkersRpcResponse } from "capnweb-validate";`);
      expect(result).toBeNull();
    } finally {
      ctx.dispose();
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

  it("honors include and exclude in transformInclude", () => {
    let cwd = "/capnweb-validate-plugin";
    let plugin = capnwebValidate.vite({
      cwd,
      include: ["src/**"],
      exclude: ["src/skip.ts"],
    }) as { transformInclude(id: string): boolean };
    expect(plugin.transformInclude(join(cwd, "src/app.ts"))).toBe(true);
    expect(plugin.transformInclude(join(cwd, "src/skip.ts"))).toBe(false);
    expect(plugin.transformInclude(join(cwd, "other.ts"))).toBe(false);
  });
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
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        files: [],
      }));
      let result = await runBuild({ cwd: src, tsconfig: join(src, "tsconfig.json"), out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 0, skipped: 0 });
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("defaults to cwd/tsconfig.json when tsconfig is omitted", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, "src", "a.ts"), "export const a = 1;\n");

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 1, skipped: 0 });
      expect(existsSync(join(src, ".out/src/a.ts"))).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("reports an actionable error when cwd has no tsconfig.json", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      await expect(runBuild({ cwd: src, out: ".out" }))
        .rejects.toThrow(/tsconfig not found/);
    } finally {
      rmSync(src, { recursive: true, force: true });
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
        .resolves.toEqual({ transformed: 0, copied: 1, skipped: 0 });

      expect(existsSync(join(src, "out", "a.ts"))).toBe(true);
      expect(existsSync(join(src, "out", "stale.ts"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("rejects output paths under a symlinked parent before cleanup", async () => {
    let workspace = mkdtempSync(join(tmpdir(), "capnweb-validate-ws-"));
    let app = join(workspace, "app");
    let external = join(workspace, "external");
    try {
      mkdirSync(app, { recursive: true });
      mkdirSync(join(external, "validate"), { recursive: true });
      writeFileSync(join(external, "validate", "sentinel.txt"), "keep\n");
      symlinkSync(external, join(app, ".wrangler"));

      await expect(runBuild({ cwd: app, out: ".wrangler/validate" }))
        .rejects.toThrow(/--out must not be inside a symlinked directory/);
      expect(existsSync(join(external, "validate", "sentinel.txt"))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("copies non-TypeScript assets into the output tree", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src", "icons"), { recursive: true });
      writeFileSync(join(src, "src", "worker.ts"), `import email from "./email.txt?raw";
export { default as logo } from "./icons/logo.svg#asset";
const dynamic = import("./dynamic.html");
const icon = new URL("./icons/icon.bin?url", import.meta.url);
export { dynamic, email, icon };
`);
      writeFileSync(join(src, "src", "email.txt"), "hello\n");
      writeFileSync(join(src, "src", "icons", "logo.svg"), "<svg />\n");
      writeFileSync(join(src, "src", "icons", "icon.bin"), "binary\n");
      writeFileSync(join(src, "src", "dynamic.html"), "<p>dynamic</p>\n");

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 5, skipped: 0 });
      expect(existsSync(join(src, ".out/src/worker.ts"))).toBe(true);
      expect(existsSync(join(src, ".out/src/email.txt"))).toBe(true);
      expect(existsSync(join(src, ".out/src/icons/logo.svg"))).toBe(true);
      expect(existsSync(join(src, ".out/src/icons/icon.bin"))).toBe(true);
      expect(existsSync(join(src, ".out/src/dynamic.html"))).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("does not copy assets mentioned only in comments or strings", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, "src", "worker.ts"), `// import secret from "./secret.txt";
const text = "new URL('./also-secret.txt', import.meta.url)";
export { text };
`);
      writeFileSync(join(src, "src", "secret.txt"), "secret\n");
      writeFileSync(join(src, "src", "also-secret.txt"), "secret\n");

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 1, skipped: 0 });
      expect(existsSync(join(src, ".out/src/secret.txt"))).toBe(false);
      expect(existsSync(join(src, ".out/src/also-secret.txt"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("does not copy type-only asset references", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, "src", "worker.ts"), `import type schema from "./schema.json";
export type { schema };
`);
      writeFileSync(join(src, "src", "schema.json"), "{}\n");

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 1, skipped: 0 });
      expect(existsSync(join(src, ".out/src/schema.json"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("copies empty named import and export asset references", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, "src", "worker.ts"), `import {} from "./empty-import.css";
export {} from "./empty-export.css";
`);
      writeFileSync(join(src, "src", "empty-import.css"), ".import {}\n");
      writeFileSync(join(src, "src", "empty-export.css"), ".export {}\n");

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 3, skipped: 0 });
      expect(existsSync(join(src, ".out/src/empty-import.css"))).toBe(true);
      expect(existsSync(join(src, ".out/src/empty-export.css"))).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("does not copy extensionless TS module imports as assets", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, "src", "worker.ts"), `import { value } from "./config";
export { value };
`);
      writeFileSync(join(src, "src", "config.ts"), "export const value = 1;\n");
      writeFileSync(join(src, "src", "config"), "not an asset\n");

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 2, skipped: 0 });
      expect(existsSync(join(src, ".out/src/config.ts"))).toBe(true);
      expect(existsSync(join(src, ".out/src/config"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("does not copy ignored directories or the output tree", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src"), { recursive: true });
      mkdirSync(join(src, "src", "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(src, "src", ".git"), { recursive: true });
      mkdirSync(join(src, ".out"), { recursive: true });
      writeFileSync(join(src, "src", "worker.ts"), `import asset from "./asset.txt";
import ignoredDep from "./node_modules/pkg/asset.txt";
import ignoredGit from "./.git/config.txt";
export { asset, ignoredDep, ignoredGit };
`);
      writeFileSync(join(src, "src", "asset.txt"), "asset\n");
      writeFileSync(join(src, "src", ".env"), "SECRET=1\n");
      writeFileSync(join(src, "src", "node_modules", "pkg", "asset.txt"), "dep\n");
      writeFileSync(join(src, "src", ".git", "config.txt"), "git\n");
      writeFileSync(join(src, ".out", "stale.txt"), "stale\n");

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 2, skipped: 0 });
      expect(existsSync(join(src, ".out/src/asset.txt"))).toBe(true);
      expect(existsSync(join(src, ".out/src/.env"))).toBe(false);
      expect(existsSync(join(src, ".out/src/node_modules/pkg/asset.txt"))).toBe(false);
      expect(existsSync(join(src, ".out/src/.git/config.txt"))).toBe(false);
      expect(existsSync(join(src, ".out/.out/stale.txt"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("copies safe symlinked asset targets to the import path", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, "src", "worker.ts"), `import types from "./types.txt";
export { types };
`);
      writeFileSync(join(src, "src", "types.d.ts"), "export type T = string;\n");
      symlinkSync(join(src, "src", "types.d.ts"), join(src, "src", "types.txt"));

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 2, skipped: 0 });
      expect(existsSync(join(src, ".out/src/types.txt"))).toBe(true);
      expect(existsSync(join(src, ".out/src/types.d.ts"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("does not copy symlinked assets that resolve outside cwd", async () => {
    let workspace = mkdtempSync(join(tmpdir(), "capnweb-validate-ws-"));
    try {
      let app = join(workspace, "app");
      let secrets = join(workspace, "secrets");
      mkdirSync(join(app, "src"), { recursive: true });
      mkdirSync(secrets, { recursive: true });
      writeFileSync(join(app, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      writeFileSync(join(app, "src", "worker.ts"), `import token from "./token.txt";
export { token };
`);
      writeFileSync(join(secrets, "token.txt"), "secret\n");
      symlinkSync(join(secrets, "token.txt"), join(app, "src", "token.txt"));

      let result = await runBuild({ cwd: app, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 1, skipped: 0 });
      expect(existsSync(join(app, ".out/src/token.txt"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not copy symlinked assets that resolve into the output tree", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, "src", "worker.ts"), `import leak from "./leak.txt";
export { leak };
`);
      writeFileSync(join(src, "src", "secret.ts"), "export const secret = 1;\n");
      symlinkSync(join(src, ".out", "src", "secret.ts"), join(src, "src", "leak.txt"));

      let result = await runBuild({ cwd: src, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 2, skipped: 0 });
      expect(existsSync(join(src, ".out/src/secret.ts"))).toBe(true);
      expect(existsSync(join(src, ".out/src/leak.txt"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("does not follow symlinked asset directories", async () => {
    let workspace = mkdtempSync(join(tmpdir(), "capnweb-validate-ws-"));
    try {
      let app = join(workspace, "app");
      let secrets = join(workspace, "secrets");
      mkdirSync(join(app, "src"), { recursive: true });
      mkdirSync(secrets, { recursive: true });
      writeFileSync(join(app, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["src/**/*.ts"],
      }));
      writeFileSync(join(app, "src", "worker.ts"), `import token from "./assets/token.txt";
export { token };
`);
      writeFileSync(join(secrets, "token.txt"), "secret\n");
      symlinkSync(secrets, join(app, "src", "assets"));

      let result = await runBuild({ cwd: app, out: ".out" });
      expect(result).toEqual({ transformed: 0, copied: 1, skipped: 0 });
      expect(existsSync(join(app, ".out/src/assets/token.txt"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
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
      await expect(runBuild(options)).resolves.toEqual({ transformed: 0, copied: 1, skipped: 0 });
      await expect(runBuild(options)).resolves.toEqual({ transformed: 0, copied: 1, skipped: 0 });

      expect(existsSync(join(src, ".wrangler/validate/a.ts"))).toBe(true);
      expect(existsSync(join(src, ".wrangler/validate/.wrangler/validate/a.ts"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("honors exclude when listing CLI source files", async () => {
    let src = mkdtempSync(join(tmpdir(), "capnweb-validate-src-"));
    try {
      writeFileSync(join(src, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["**/*.ts"],
      }));
      writeFileSync(join(src, "capnweb.d.ts"), `
        declare module "capnweb" { export class RpcTarget { readonly __RPC_TARGET_BRAND: never; } }
        declare module "capnweb-validate/capnweb" { export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>; }
      `);
      writeFileSync(join(src, "good.ts"), "export const good = 1;\n");
      writeFileSync(join(src, "bad.ts"), `
        import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
        import { RpcTarget } from "capnweb";
        class Api extends RpcTarget { bad(value: WeakMap<object, number>): void {} }
        export function handler(req: Request): Promise<Response> {
          return newWorkersRpcResponse(req, new Api());
        }
      `);

      let result = await runBuild({
        cwd: src,
        tsconfig: join(src, "tsconfig.json"),
        out: ".out",
        exclude: ["bad.ts"],
      });

      expect(result).toEqual({ transformed: 0, copied: 1, skipped: 0 });
      expect(existsSync(join(src, ".out/good.ts"))).toBe(true);
      expect(existsSync(join(src, ".out/bad.ts"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("skips a source file outside cwd instead of writing outside --out", async () => {
    // workspace/{app, shared}; app's tsconfig includes ../shared. The shared
    // file maps to ../shared under out and must not escape the output tree.
    let workspace = mkdtempSync(join(tmpdir(), "capnweb-validate-ws-"));
    try {
      let app = join(workspace, "app");
      let shared = join(workspace, "shared");
      mkdirSync(app, { recursive: true });
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(app, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "esnext", types: [] },
        include: ["**/*.ts", "../shared/**/*.ts"],
      }));
      writeFileSync(join(app, "main.ts"), `import asset from "../shared/asset.txt";
export const main = asset;
`);
      writeFileSync(join(shared, "util.ts"), "export const util = 2;\n");
      writeFileSync(join(shared, "asset.txt"), "asset\n");

      let result = await runBuild({
        cwd: app,
        tsconfig: join(app, "tsconfig.json"),
        out: ".out",
      });

      // app/main.ts copied; shared/util.ts skipped, not written anywhere.
      expect(result.copied).toBe(1);
      expect(result.skipped).toBe(1);
      expect(existsSync(join(app, ".out/main.ts"))).toBe(true);
      expect(existsSync(join(app, ".out/shared/asset.txt"))).toBe(false);
      expect(existsSync(join(workspace, "shared/util.ts.bak"))).toBe(false);
      // Nothing written outside the out tree (no app/shared, no workspace/out).
      expect(existsSync(join(app, "shared"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
