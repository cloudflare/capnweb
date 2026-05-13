// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitViteRegistration } from "../src/typecheck/generate.js";
import { transformClientCalls } from "../src/typecheck/rewrite.js";
import capnweb from "../src/typecheck/vite.js";

describe("capnweb/vite plugin client rewrite", () => {
  it("rewrites typed RPC factory calls in user source", () => {
    let userCode = `
import { newHttpBatchRpcSession } from "capnweb";
import type { Api as RemoteApi } from "./api.js";
const api = newHttpBatchRpcSession<RemoteApi>("/rpc");
const other = newHttpBatchRpcSession<Unknown>("/rpc2");
function local(newHttpBatchRpcSession: any) {
  return newHttpBatchRpcSession<RemoteApi>("/local");
}
`;

    let code = transformClientCalls(userCode, new Set(["Api"]), "./.capnweb/clients.js");
    expect(code).toContain(`__capnweb_wrap_Api(newHttpBatchRpcSession<RemoteApi>("/rpc"))`);
    // Calls with no matching class spec are left alone -- TS opted out of
    // typing here, so we opt out of runtime validation.
    expect(code).toContain(`newHttpBatchRpcSession<Unknown>("/rpc2")`);
    expect(code).toContain(`newHttpBatchRpcSession<RemoteApi>("/local")`);
    expect(code).not.toContain(`__capnweb_wrap_Unknown`);
    expect(code).toContain(`import { __capnweb_wrap_Api } from "./.capnweb/clients.js"`);

    let wrapCalls = (code.match(/__capnweb_wrap_Api\(/g) ?? []).length;
    expect(wrapCalls).toBe(1);
  });

  it("injects server validator registration into the Vite worker entry", () => {
    let root = mkdtempSync(resolve(".capnweb-vite-entry-"));
    try {
      let input = resolve(root, "worker.ts");
      let outDir = resolve(root, ".capnweb");
      let validatorsAbs = resolve(outDir, "validators.ts");
      let registration = emitViteRegistration([
        { name: "Api", valueName: "Api", isDefault: false, sourcePath: input },
      ], input, validatorsAbs);
      let code = `${registration.imports}\nexport class Api {}\n${registration.call}\n`;
      expect(code).toContain(`import { registerCapnwebValidators as __capnweb_registerValidators } from "./.capnweb/validators.js";`);
      expect(code).toContain(`__capnweb_registerValidators({ "Api": Api });`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });



  it("rewrites aliased and namespace-imported RPC factory calls", () => {
    let userCode = `
import * as capnweb from "capnweb";
import { newHttpBatchRpcSession as connect } from "capnweb";
import type { Api } from "./api.js";
const a = connect<Api>("/rpc");
const b = capnweb.newWebSocketRpcSession<Api>("ws://example.com/rpc");
`;

    let code = transformClientCalls(userCode, new Set(["Api"]), "./clients.js");
    expect(code).toContain(`__capnweb_wrap_Api(connect<Api>("/rpc"))`);
    expect(code).toContain(`__capnweb_wrap_Api(capnweb.newWebSocketRpcSession<Api>("ws://example.com/rpc"))`);
  });

  it("rewrites typed `new RpcSession<T>(...)` with the session-shape wrap", () => {
    // `new RpcSession<Api>(transport)` returns a session, not a stub, so the
    // rewriter routes it through the session-shape wrap to bind validators
    // on `session.getRemoteMain()` without changing the call-site type.
    let userCode = `
import { RpcSession } from "capnweb";
import type { Api } from "./api.js";
const transport = {} as any;
const session = new RpcSession<Api>(transport);
`;

    let code = transformClientCalls(userCode, new Set(["Api"]), "./clients.js");
    expect(code).toContain(`__capnweb_wrap_RpcSession_Api(new RpcSession<Api>(transport))`);
    expect(code).toContain(`import { __capnweb_wrap_RpcSession_Api } from`);
    // Stub-shape wrap is not referenced by this file.
    expect(code).not.toContain(`__capnweb_wrap_Api(`);
  });

  it("ignores files in node_modules and the generated output", () => {
    let root = mkdtempSync(resolve(".capnweb-vite-skip-"));
    try {
      let input = resolve(root, "worker.ts");
      let outDir = resolve(root, ".capnweb");
      writeFileSync(resolve(root, "fake-capnweb.ts"), `export class RpcTarget {}`);
      writeFileSync(input, `
        import { RpcTarget } from "./fake-capnweb.js";
        export class Api extends RpcTarget {
          ping(value: string): string { return value; }
        }
      `);

      let plugin = capnweb({ input, outDir }) as any;
      plugin.configResolved({ root });

      let userCode = `
import { newHttpBatchRpcSession } from "capnweb";
const api = newHttpBatchRpcSession<Api>("/rpc");
`;

      expect(plugin.transform(userCode, resolve(root, "node_modules", "x.ts"))).toBeNull();
      expect(plugin.transform(userCode, resolve(outDir, "extra.ts"))).toBeNull();
      expect(plugin.transform(userCode, resolve(root, "client.d.ts"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
