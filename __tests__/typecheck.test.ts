// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectReachableSourceFiles,
  commonDir,
  createProject,
  extractClasses,
} from "../src/typecheck/extract.js";
import { generate } from "../src/typecheck/generate.js";
import { emitShadowSources } from "../src/typecheck/rewrite.js";
import { RpcStub, RpcTarget } from "../src/index.js";
import { RpcPayload, setRpcMethodValidators } from "../src/core.js";

// =====================================================================
// Helpers

function inspectInput(input: string) {
  let project = createProject(input);
  let sourceFile = project.sourceFile;
  let reachableFiles = collectReachableSourceFiles(project);
  let classes = extractClasses(project, reachableFiles);
  return { sourceFile, reachableFiles, classes };
}

function emitShadowFor(input: string, outDir: string): void {
  let { sourceFile, reachableFiles, classes } = inspectInput(input);
  let root = commonDir(reachableFiles.map(file => file.fileName));
  emitShadowSources(reachableFiles, sourceFile, outDir, root, classes.map(c => c.name));
}

function runtimeImportFor(outDir: string): string {
  let runtimeImport = relative(outDir, resolve("src/index.ts")).split(sep).join("/");
  if (!runtimeImport.startsWith(".")) runtimeImport = "./" + runtimeImport;
  return runtimeImport.replace(/\.ts$/, ".js");
}

function writeFakeCapnweb(dir: string): void {
  writeFileSync(resolve(dir, "fake-capnweb.ts"),
      `export class RpcTarget {}\nexport type RpcStub<T> = T;\n`);
}

// =====================================================================
// Runtime validator hook tests. These use the same hand-written validators
// the codegen ultimately wires up, but skip codegen entirely -- they prove
// the runtime hook in `core.ts` calls validators at the right points
// (deliverCall args, deliverCall return, forwarded RpcPromise resolution).

class CheckedApi extends RpcTarget {
  echo(value: string) {
    return { value };
  }

  badReturn() {
    return { value: 123 };
  }
}

setRpcMethodValidators(CheckedApi, {
  echo: {
    args(args) {
      if (args.length !== 1 || typeof args[0] !== "string") {
        throw new TypeError("CheckedApi.echo expected a string");
      }
    },
    returns(value) {
      if (typeof value !== "object" || value === null
          || typeof (value as { value?: unknown }).value !== "string") {
        throw new TypeError("CheckedApi.echo returned invalid value");
      }
    },
  },
  badReturn: {
    args(args) {
      if (args.length !== 0) {
        throw new TypeError("CheckedApi.badReturn expected no arguments");
      }
    },
    returns(value) {
      if (typeof value !== "object" || value === null
          || typeof (value as { value?: unknown }).value !== "string") {
        throw new TypeError("CheckedApi.badReturn returned invalid value");
      }
    },
  },
});

describe("runtime type validators", () => {
  it("checks RPC method arguments before invoking the method", async () => {
    let stub = new RpcStub(new CheckedApi());
    await expect(stub.echo("ok")).resolves.toStrictEqual({ value: "ok" });
    await expect((stub as any).echo(123)).rejects.toThrow("CheckedApi.echo expected a string");
  });

  it("checks RPC method return values before serializing them", async () => {
    let stub = new RpcStub(new CheckedApi());
    await expect((stub as any).badReturn()).rejects.toThrow(
        "CheckedApi.badReturn returned invalid value");
  });

  it("checks forwarded RpcPromise return values when they resolve", async () => {
    class BadSource extends RpcTarget {
      value() { return Promise.resolve({ value: 123 } as unknown); }
      user() { return Promise.resolve({ name: 123 } as unknown); }
    }
    class ForwardingApi extends RpcTarget {
      constructor(private remote: any) { super(); }
      forward() { return this.remote.value(); }
      forwardName() { return this.remote.user().name; }
    }
    setRpcMethodValidators(ForwardingApi, {
      forward: {
        returns(value) {
          if (typeof value !== "object" || value === null
              || typeof (value as { value?: unknown }).value !== "string") {
            throw new TypeError("ForwardingApi.forward returned invalid value");
          }
        },
      },
      forwardName: {
        returns(value) {
          if (typeof value !== "string") {
            throw new TypeError("ForwardingApi.forwardName returned invalid value");
          }
        },
      },
    });

    using remote: any = new RpcStub(new BadSource());
    let api = new ForwardingApi(remote);

    let payload = RpcPayload.deepCopyFrom([], undefined, null);
    let result = await payload.deliverCall(api.forward, api, "forward");
    await expect(result.deliverResolve()).rejects.toThrow(
        "ForwardingApi.forward returned invalid value");

    let namePayload = RpcPayload.deepCopyFrom([], undefined, null);
    let nameResult = await namePayload.deliverCall(api.forwardName, api, "forwardName");
    await expect(nameResult.deliverResolve()).rejects.toThrow(
        "ForwardingApi.forwardName returned invalid value");
  });
});

// =====================================================================
// RpcTarget class discovery and preflight type rejection. These exercise
// `extractClasses` directly via `inspectInput`; no validator codegen.

describe("RpcTarget class extraction", () => {
  it("discovers classes reachable through re-exports", () => {
    let root = mkdtempSync(resolve(".capnweb-reexport-"));
    try {
      writeFakeCapnweb(root);
      writeFileSync(resolve(root, "api.ts"), `
        import { RpcTarget } from "./fake-capnweb.js";
        export class Api extends RpcTarget {
          ping(value: string): string { return value; }
        }
      `);
      let input = resolve(root, "worker.ts");
      writeFileSync(input, `export { Api } from "./api.js";`);
      expect(inspectInput(input).classes.map(c => c.name)).toStrictEqual(["Api"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors tsconfig path aliases and aliased RpcTarget imports", () => {
    let root = mkdtempSync(resolve(".capnweb-paths-"));
    try {
      writeFakeCapnweb(root);
      mkdirSync(resolve(root, "api"), { recursive: true });
      writeFileSync(resolve(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@api/*": ["api/*"],
            "fake-capnweb": ["fake-capnweb.ts"],
          },
        },
      }));
      writeFileSync(resolve(root, "api", "api.ts"), `
        import { RpcTarget as BaseTarget } from "fake-capnweb";
        export class Api extends BaseTarget {
          ping(value: string): string { return value; }
        }
      `);
      let input = resolve(root, "worker.ts");
      writeFileSync(input, `export { Api } from "@api/api";`);
      expect(inspectInput(input).classes.map(c => c.name)).toStrictEqual(["Api"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers locally-declared and imported RpcTarget callbacks", () => {
    let root = mkdtempSync(resolve(".capnweb-callback-"));
    try {
      writeFakeCapnweb(root);
      writeFileSync(resolve(root, "callback.ts"), `
        import { RpcTarget } from "./fake-capnweb.js";
        export class ImportedCallback extends RpcTarget {
          notify(message: string): void {}
        }
      `);
      let input = resolve(root, "worker.ts");
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        import { ImportedCallback } from "./callback.js";
        export class LocalCallback extends RpcTarget {
          notify(message: string): void {}
        }
        export class Api extends RpcTarget {
          local(callback: LocalCallback): void {}
          imported(callback: ImportedCallback): void {}
        }
      `);
      expect(inspectInput(input).classes.map(c => c.name).sort())
          .toStrictEqual(["Api", "ImportedCallback", "LocalCallback"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects indirect RpcTarget inheritance on default-exported classes", () => {
    let root = mkdtempSync(resolve(".capnweb-default-indirect-"));
    try {
      writeFakeCapnweb(root);
      writeFileSync(resolve(root, "base.ts"), `
        import { RpcTarget } from "./fake-capnweb.js";
        export class BaseTarget extends RpcTarget {}
      `);
      let input = resolve(root, "worker.ts");
      writeFileSync(input, `
        import { BaseTarget } from "./base.js";
        export default class Api extends BaseTarget {
          ping(value: string): void {}
        }
      `);
      let [klass] = inspectInput(input).classes;
      expect(klass.name).toBe("Api");
      expect(klass.isDefault).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects anonymous default-exported RpcTarget classes", () => {
    let root = mkdtempSync(resolve(".capnweb-anonymous-default-"));
    try {
      writeFakeCapnweb(root);
      let input = resolve(root, "worker.ts");
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        export default class extends RpcTarget {
          ping(value: string): void {}
        }
      `);
      expect(() => inspectInput(input)).toThrow(
          /Anonymous RpcTarget classes are not supported/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips static methods when extracting the RPC surface", () => {
    let root = mkdtempSync(resolve(".capnweb-static-method-"));
    try {
      writeFakeCapnweb(root);
      let input = resolve(root, "worker.ts");
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        export class Api extends RpcTarget {
          static helper(value: any): void {}
          ping(value: string): void {}
        }
      `);
      expect(inspectInput(input).classes[0].methods.map(m => m.name)).toStrictEqual(["ping"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-exported RpcTarget classes", () => {
    let root = mkdtempSync(resolve(".capnweb-non-exported-"));
    try {
      writeFakeCapnweb(root);
      let input = resolve(root, "worker.ts");
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        class InternalApi extends RpcTarget {
          ping(value: string): void {}
        }
        export class Api extends RpcTarget {
          ping(value: string): void {}
        }
      `);
      expect(() => inspectInput(input)).toThrow(
          /InternalApi: RpcTarget classes must be exported/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("preflight type rejection", () => {
  it.each([
    ["any", `anyArg(value: any): void {}`,
        /Api\.anyArg parameter 'value': type 'any' cannot be validated/],
    ["unknown", `unknownArg(value: unknown): void {}`,
        /Api\.unknownArg parameter 'value': type 'unknown' cannot be validated/],
    ["any nested in an object literal", `nestedAny(value: { tags: any[] }): void {}`,
        /Api\.nestedAny parameter 'value': property 'tags': type 'any' cannot be validated/],
    ["any in a return type", `badReturn(): any { return 1; }`,
        /Api\.badReturn return: type 'any' cannot be validated/],
    ["symbol", `symbolArg(value: symbol): void {}`,
        /Unsupported RPC type: symbol/],
    ["bigint literal", `bigintLiteral(value: 1n): void {}`,
        /bigint literal types are not supported/],
    ["optional tuple element", `optionalTuple(value: [string, number?]): void {}`,
        /optional and rest tuple elements are not supported/],
  ])("rejects %s", (_label, body, pattern) => {
    let root = mkdtempSync(resolve(".capnweb-preflight-"));
    try {
      writeFakeCapnweb(root);
      let input = resolve(root, "api.ts");
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        export class Api extends RpcTarget {
          ${body}
        }
      `);
      expect(() => inspectInput(input)).toThrow(pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects recursive types", () => {
    let root = mkdtempSync(resolve(".capnweb-recursive-"));
    try {
      writeFakeCapnweb(root);
      let input = resolve(root, "api.ts");
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        interface Tree { name: string; children: Tree[]; }
        export class Api extends RpcTarget {
          tree(value: Tree): void {}
        }
      `);
      expect(() => inspectInput(input)).toThrow(/recursive types are not supported/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "ArrayBuffer", "DataView", "RegExp", "Uint16Array", "Float32Array",
  ])("rejects native not currently serialized by Cap'n Web: %s", type => {
    let root = mkdtempSync(resolve(".capnweb-native-"));
    try {
      writeFakeCapnweb(root);
      let input = resolve(root, "api.ts");
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        export class Api extends RpcTarget { valueArg(value: ${type}): void {} }
      `);
      expect(() => inspectInput(input)).toThrow(/Unsupported RPC type/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects mixed string index signatures and named properties", () => {
    let root = mkdtempSync(resolve(".capnweb-mixed-index-"));
    try {
      writeFakeCapnweb(root);
      let input = resolve(root, "api.ts");
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        interface Dict { required: string; [key: string]: string; }
        export class Api extends RpcTarget { valueArg(value: Dict): void {} }
      `);
      expect(() => inspectInput(input)).toThrow(/both string index signatures and named properties/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// Shadow source emission. These exercise `emitShadowSources` directly --
// no validator codegen. They cover the CLI's client-rewrite path
// (the Vite plugin's in-memory rewrite is covered in vite-plugin.test.ts).

describe("shadow source emission", () => {
  it("wraps typed RPC factory calls in the shadow source tree", () => {
    let root = mkdtempSync(resolve(".capnweb-shadow-"));
    try {
      writeFakeCapnweb(root);
      let input = resolve(root, "worker.ts");
      let outDir = resolve(root, ".capnweb");
      writeFileSync(input, `
        import { newHttpBatchRpcSession } from "capnweb";
        import { RpcTarget } from "./fake-capnweb.js";
        export class Api extends RpcTarget {
          ping(value: string): string { return value; }
        }
        export const remote = newHttpBatchRpcSession<Api>("/rpc");
      `);

      emitShadowFor(input, outDir);

      let shadow = readFileSync(resolve(outDir, "source", "worker.ts"), "utf8");
      expect(shadow).toContain(`import { __capnweb_wrap_Api } from "../clients.js"`);
      expect(shadow).toContain(`__capnweb_wrap_Api(newHttpBatchRpcSession<Api>("/rpc"))`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies relative non-TS asset imports into the shadow tree", () => {
    let root = mkdtempSync(resolve(".capnweb-shadow-asset-"));
    try {
      writeFakeCapnweb(root);
      writeFileSync(resolve(root, "config.json"), `{"prefix":"ok"}`);
      let input = resolve(root, "worker.ts");
      let outDir = resolve(root, ".capnweb");
      writeFileSync(input, `
        import config from "./config.json";
        import { RpcTarget } from "./fake-capnweb.js";
        export class Api extends RpcTarget {
          ping(value: string): string { return config.prefix + value; }
        }
      `);

      emitShadowFor(input, outDir);

      let copied = resolve(outDir, "source", "config.json");
      expect(readFileSync(copied, "utf8")).toBe(`{"prefix":"ok"}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects asset imports that would escape the shadow tree", () => {
    let root = mkdtempSync(resolve(".capnweb-shadow-asset-escape-"));
    try {
      let sourceDir = resolve(root, "src");
      mkdirSync(sourceDir, { recursive: true });
      writeFakeCapnweb(sourceDir);
      writeFileSync(resolve(root, "escape.json"), `{"prefix":"bad"}`);
      let input = resolve(sourceDir, "worker.ts");
      let outDir = resolve(root, ".capnweb");
      writeFileSync(input, `
        import config from "../escape.json";
        import { RpcTarget } from "./fake-capnweb.js";
        export class Api extends RpcTarget {
          ping(value: string): string { return config.prefix + value; }
        }
      `);

      expect(() => emitShadowFor(input, outDir)).toThrow(
          /escape the generated shadow source tree/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// End-to-end validator codegen. ONE `generate()` call is shared by both the
// server-side validator integration tests and the client-side bound
// validator integration tests, so we only pay the `ts.createProgram` cost
// once per file. Everything before this point in the file avoids it
// entirely.

describe("end-to-end validator codegen", () => {
  let root: string;
  let api: any;
  let wrap: (stub: unknown) => any;
  let wrapSession: (session: unknown) => any;

  let call = async (method: string, args: unknown[]) => {
    let payload = RpcPayload.deepCopyFrom(args, undefined, null);
    let result = await payload.deliverCall(api[method], api, method);
    return result.deliverResolve();
  };

  beforeAll(async () => {
    root = mkdtempSync(resolve(".capnweb-e2e-"));
    writeFakeCapnweb(root);
    let input = resolve(root, "api.ts");
    let outDir = resolve(root, ".capnweb");
    writeFileSync(input, `
      import { RpcTarget } from "./fake-capnweb.js";
      export class Api extends RpcTarget {
        hello(name: string): { value: string } { return { value: name }; }
        maybe(value?: string | null): void {}
        leadingDefault(value = "default", required: string): void {}
        contract(value: {
          text: string;
          count: number;
          flag: boolean;
          tags: string[];
          pair: [string, number];
          byId: Record<string, { active: boolean }>;
          map: Map<string, { active: boolean }>;
          set: Set<string>;
          maybe: string | null;
          created: Date;
          bytes: Uint8Array;
          literal: "ok";
        }): void {}
        getUser(token: string): { id: string } { return { id: token }; }
        getProfile(id: string): { id: string; ok: true } { return { id, ok: true }; }
        badReturn(): { value: string } { return { value: 123 } as any; }
      }
    `);

    let runtimeImport = runtimeImportFor(outDir);
    generate({ input, outDir, runtimeImport });

    await import(pathToFileURL(resolve(outDir, "validators.ts")).href);
    let mod = await import(pathToFileURL(resolve(outDir, "worker.entry.ts")).href);
    api = new mod.Api();

    let clients = await import(pathToFileURL(resolve(outDir, "clients.ts")).href);
    wrap = clients.__capnweb_wrap_Api;
    wrapSession = clients.__capnweb_wrap_RpcSession_Api;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("server-side validators", () => {
    it("accepts a well-typed call and returns the value", async () => {
      await expect(call("hello", ["ok"])).resolves.toStrictEqual({ value: "ok" });
    });

    it("rejects an arg of the wrong type, with the parameter name in the error", async () => {
      await expect(call("hello", [123])).rejects.toThrow(
          /Api\.hello: name: expected string, got number/);
    });

    it("rejects a return value of the wrong type", async () => {
      await expect(call("badReturn", [])).rejects.toThrow(
          /Api\.badReturn return: value: expected string, got number/);
    });

    it("accepts elided and explicit-null values for optional + nullable params", async () => {
      await expect(call("maybe", [])).resolves.toBeUndefined();
      await expect(call("maybe", [null])).resolves.toBeUndefined();
    });

    it("preserves the error path on optional + nullable mismatches", async () => {
      await expect(call("maybe", [123])).rejects.toThrow(
          /Api\.maybe: value: expected null \| string \| undefined, got number/);
    });

    it("counts required arity after optional leading params", async () => {
      await expect(call("leadingDefault", ["only one"])).rejects.toThrow(/expected 2 argument/);
    });

    it("validates the supported Cap'n Web type contract", async () => {
      await expect(call("contract", [{
        text: "ok",
        count: 1,
        flag: true,
        tags: ["a", "b"],
        pair: ["x", 2],
        byId: { a: { active: true } },
        map: new Map([["a", { active: true }]]),
        set: new Set(["a"]),
        maybe: null,
        created: new Date(0),
        bytes: new Uint8Array([1, 2, 3]),
        literal: "ok",
      }])).resolves.toBeUndefined();

      await expect(call("contract", [{
        text: "ok",
        count: 1,
        flag: true,
        tags: ["a"],
        pair: ["x", 2],
        byId: { a: { active: "no" } },
        map: new Map([["a", { active: true }]]),
        set: new Set(["a"]),
        maybe: null,
        created: new Date(0),
        bytes: new Uint8Array(),
        literal: "ok",
      }])).rejects.toThrow(/value\.byId\.a\.active: expected boolean, got string/);

      await expect(call("contract", [{
        text: "ok",
        count: 1,
        flag: true,
        tags: ["a"],
        pair: ["x", 2],
        byId: { a: { active: true } },
        map: new Map([["a", { active: "no" }]]),
        set: new Set(["a"]),
        maybe: null,
        created: new Date(0),
        bytes: new Uint8Array(),
        literal: "ok",
      }])).rejects.toThrow(/value\.map\.a\.active: expected boolean, got string/);

      await expect(call("contract", [{
        text: "ok",
        count: 1,
        flag: true,
        tags: ["a"],
        pair: ["x", 2],
        byId: { a: { active: true } },
        map: new Map([[1, { active: true }]]),
        set: new Set(["a"]),
        maybe: null,
        created: new Date(0),
        bytes: new Uint8Array(),
        literal: "ok",
      }])).rejects.toThrow(/value\.map\.<key>: expected string, got number/);

      await expect(call("contract", [{
        text: "ok",
        count: 1,
        flag: true,
        tags: ["a"],
        pair: ["x", 2],
        byId: { a: { active: true } },
        map: new Map([["a", { active: true }]]),
        set: new Set([1]),
        maybe: null,
        created: new Date(0),
        bytes: new Uint8Array(),
        literal: "ok",
      }])).rejects.toThrow(/value\.set\.\[0\]: expected string, got number/);
    });
  });

  describe("client-side bound validators", () => {
    it("rejects wrong return values from a remote stub", async () => {
      class BadReturn extends RpcTarget {
        hello(_name: string) { return Promise.resolve({ value: 123 } as unknown); }
      }
      let wrapped = wrap(new RpcStub(new BadReturn()));
      let failure = await wrapped.hello("ok").catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toMatch(
          /Api\.hello return: value: expected string, got number/);
    });

    it("rejects invalid client arguments before sending the call", async () => {
      let sent = false;
      class ShouldNotCall extends RpcTarget {
        hello(_name: string) {
          sent = true;
          return Promise.resolve({ value: "sent" });
        }
      }
      let wrapped = wrap(new RpcStub(new ShouldNotCall()));
      expect(() => wrapped.hello(123)).toThrow(
          /Api\.hello: name: expected string, got number/);
      expect(sent).toBe(false);
    });

    it("rejects wrong return values consumed through pipelined properties", async () => {
      class BadReturn extends RpcTarget {
        getUser(_token: string) { return Promise.resolve({ id: 123 } as unknown); }
        getProfile(id: string) { return Promise.resolve({ id, ok: true }); }
      }
      let wrapped = wrap(new RpcStub(new BadReturn()));
      await expect(wrapped.getProfile(wrapped.getUser("token").id)).rejects.toThrow(
          /Api.getUser return: id: expected string, got number/);
    });

    it("does not apply root validators to nested pipelined method calls", () => {
      class Nested extends RpcTarget {
        hello(_name: string) { return Promise.resolve({ value: "root" }); }
      }
      let wrapped = wrap(new RpcStub(new Nested()));
      expect(() => wrapped.admin.hello(123)).not.toThrow();
    });

    it("passes through valid return values", async () => {
      class GoodReturn extends RpcTarget {
        hello(name: string) { return Promise.resolve({ value: name }); }
      }
      let wrapped = wrap(new RpcStub(new GoodReturn()));
      await expect(wrapped.hello("ok")).resolves.toStrictEqual({ value: "ok" });
    });

    it("validates the success value reached via .catch / .finally", async () => {
      class BadCatch extends RpcTarget {
        hello(_name: string) { return Promise.resolve({ value: 123 } as unknown); }
      }
      let wrapped = wrap(new RpcStub(new BadCatch()));

      let viaCatch = await wrapped.hello("ok").catch((e: unknown) => e);
      expect(viaCatch).toBeInstanceOf(TypeError);
      expect((viaCatch as Error).message).toMatch(
          /Api\.hello return: value: expected string, got number/);

      await expect(wrapped.hello("ok").finally(() => {})).rejects.toThrow(
          /Api\.hello return: value: expected string, got number/);
    });

    it("binds session-shape validators on getRemoteMain() and returns the session", async () => {
      // `new RpcSession<Api>(...)` returns a session, not a stub, so the
      // session wrap walks to `getRemoteMain()` once, binds validators on
      // that stub, and returns the session unchanged.
      class BadReturn extends RpcTarget {
        hello(_name: string) { return Promise.resolve({ value: 123 } as unknown); }
      }
      let main = new RpcStub(new BadReturn());
      let fakeSession = { getRemoteMain: () => main, getStats: () => ({}) };

      let wrapped = wrapSession(fakeSession);
      expect(wrapped).toBe(fakeSession);

      let failure = await main.hello("ok").catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toMatch(
          /Api\.hello return: value: expected string, got number/);
    });

    it("preserves RpcPromise pipelining on bound stubs", async () => {
      class Pipelined extends RpcTarget {
        getUser(token: string) { return Promise.resolve({ id: token }); }
        getProfile(id: string) { return Promise.resolve({ id, ok: true }); }
      }
      let wrapped = wrap(new RpcStub(new Pipelined()));
      let user = wrapped.getUser("u_1");
      let profile = wrapped.getProfile(user.id);
      await expect(Promise.all([user, profile])).resolves.toStrictEqual([
        { id: "u_1" },
        { id: "u_1", ok: true },
      ]);
    });
  });
});
