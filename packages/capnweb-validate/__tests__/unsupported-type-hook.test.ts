// onUnsupportedType lets a host accept a type capnweb rejects (e.g. Workers RPC
// transports Map/Set via structured clone). Returning "passthrough" emits `any`
// for that type instead of failing the build; the default stays a build error.
import { describe, it, expect } from "vitest";
import { transformFixture, transformError, prelude } from "./helpers.js";

const MAP_SERVICE = `class Api extends RpcTarget {
  async getConfig(): Promise<Map<string, number>> { return null as any; }
}`;

describe("onUnsupportedType hook", () => {
  it("rejects an unsupported type by default (build error)", () => {
    const msg = transformError(MAP_SERVICE, { target: "new Api()" });
    expect(msg).toContain("Map");
    expect(msg).toContain("not a capnweb wire type");
  });

  it('passes the type through as `any` when the hook returns "passthrough"', () => {
    const { code } = transformFixture(MAP_SERVICE, {
      target: "new Api()",
      onUnsupportedType: () => "passthrough",
    });
    expect(prelude(code)).toMatch(/getConfig[\s\S]*?returns:\s*__rt\.v\.any/);
  });

  it("still rejects when the hook returns undefined or \"reject\"", () => {
    const msg = transformError(MAP_SERVICE, {
      target: "new Api()",
      onUnsupportedType: () => undefined,
    });
    expect(msg).toContain("not a capnweb wire type");
  });

  it("passes the offending type name to the hook", () => {
    const seen: string[] = [];
    transformFixture(MAP_SERVICE, {
      target: "new Api()",
      onUnsupportedType: (info) => {
        seen.push(info.typeName);
        return "passthrough";
      },
    });
    expect(seen).toContain("Map");
  });

  it("never passes through a type no host can transport, even with a permissive hook", () => {
    // WeakMap is not structured-cloneable on any host, so "passthrough" must not
    // turn it into `any` and defer a guaranteed serialize-time failure.
    const msg = transformError(
      `class Api extends RpcTarget { async m(): Promise<WeakMap<object, number>> { return null as any; } }`,
      { target: "new Api()", onUnsupportedType: () => "passthrough" },
    );
    expect(msg).toContain("not a capnweb wire type");
  });

  it("lets the hook accept some types while still rejecting others", () => {
    // Accept Map, but a Set in the same surface still fails the build.
    const msg = transformError(
      `class Api extends RpcTarget {
         async a(): Promise<Map<string, number>> { return null as any; }
         async b(): Promise<Set<string>> { return null as any; }
       }`,
      {
        target: "new Api()",
        onUnsupportedType: (info) => (info.typeName === "Map" ? "passthrough" : "reject"),
      },
    );
    expect(msg).toContain("Set");
  });

  // The hook threads through three independent paths; cover all three so a
  // refactor that drops it from any one is caught.

  it("applies on the client session path", () => {
    const shim = `declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  export type RpcStub<T> = T & StubBase<T>;
  export function newHttpBatchRpcSession<T>(url: string): RpcStub<T>;
}
declare module "capnweb-validate/capnweb" {
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}`;
    const { code } = transformFixture(
      `interface Api extends RpcTarget { getConfig(): Promise<Map<string, number>>; }
export const api = newHttpBatchRpcSession<Api>("/rpc");`,
      {
        shim,
        imports: `import { newHttpBatchRpcSession } from "capnweb";\nimport { RpcTarget } from "capnweb";\n`,
        onUnsupportedType: () => "passthrough",
      },
    );
    expect(prelude(code, "export const api")).toMatch(/getConfig[\s\S]*?returns:\s*__rt\.v\.any/);
  });

  it("applies on the @validateRpc decorator path", () => {
    const shim = `declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
}
declare module "capnweb-validate" {
  export function validateRpc<T = unknown>(): any;
}
declare module "capnweb-validate/capnweb" {
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}`;
    const { code } = transformFixture(
      `@validateRpc()
class Api extends RpcTarget { async getConfig(): Promise<Map<string, number>> { return null as any; } }`,
      {
        shim,
        imports: `import { validateRpc } from "capnweb-validate";\nimport { RpcTarget } from "capnweb";\n`,
        target: "new Api()",
        onUnsupportedType: () => "passthrough",
      },
    );
    expect(prelude(code, "@validateRpc")).toMatch(/getConfig[\s\S]*?returns:\s*__rt\.v\.any/);
  });

  it("applies to a nested unsupported type (Map inside an object)", () => {
    const { code } = transformFixture(
      `class Api extends RpcTarget {
         async m(): Promise<{ cfg: Map<string, number>; name: string }> { return null as any; }
       }`,
      { target: "new Api()", onUnsupportedType: () => "passthrough" },
    );
    const v = prelude(code);
    expect(v).toMatch(/"cfg":\s*__rt\.v\.any/);
    expect(v).toMatch(/"name":\s*__rt\.v\.string/);
  });
});
