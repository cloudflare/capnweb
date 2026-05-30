import { describe, expect, it } from "vitest";
import { transformFixture } from "./helpers.js";

// capnweb (RpcTarget brand + RpcStub) and a workers-types-shaped Fetcher alias.
const SHIM = `declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  type Provider<T> = { readonly [K in keyof T]: T[K] };
  export type RpcStub<T> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
}
declare module "cloudflare:workers" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  type Fetcher<T = undefined, Reserved extends string = never> =
    (T extends object ? Pick<T, Exclude<keyof T, Reserved | "fetch" | "connect">> : unknown) & {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      connect(address: string): unknown;
    };
  export { Fetcher };
}
declare module "capnweb-validate/capnweb" {
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}`;

const IMPORTS =
  `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";\n` +
  `import { RpcTarget } from "capnweb";\n` +
  `import { Fetcher } from "cloudflare:workers";\n`;

function emit(returnType: string, extra = ""): string {
  const { code } = transformFixture(
    `${extra}
class Api extends RpcTarget {
  getThing(): ${returnType} { return null as any; }
}`,
    { shim: SHIM, imports: IMPORTS, lib: ["ES2022", "DOM"], target: "new Api()" }
  );
  return code.split("\n").find((l) => l.includes("getThing")) ?? "";
}

describe("Fetcher detection: structural false-positive", () => {
  it("validates an ordinary {fetch,connect} user type as an object, not a stub", () => {
    // Two methods named fetch/connect but a non-Fetcher fetch signature. Must be
    // validated structurally, not waved through as an opaque pass-by-ref stub.
    const line = emit(
      "NotAFetcher",
      `interface NotAFetcher {
  fetch(url: string): Promise<string>;
  connect(host: string): Promise<void>;
}`
    );
    expect(line).toMatch(/__rt\.v\.object\(/);
    expect(line).toContain('"fetch": __rt.v.func');
    expect(line).toContain('"connect": __rt.v.func');
    expect(line).not.toMatch(/returns: __rt\.v\.stub\b/);
  });

  it("keeps a real Fetcher<User> as a pass-by-reference stub", () => {
    const line = emit("Fetcher<User>", "interface User { describe(): Promise<string>; }");
    expect(line).toMatch(/__rt\.v\.stubOf\(/);
    expect(line).toContain('serviceName: "User"');
  });

  it("keeps a bare Fetcher (alias erased) as a stub via the fetch signature", () => {
    // `Fetcher` with all type args defaulted drops the "Fetcher" alias name, so
    // the structural fallback must still recognise it by fetch -> Promise<Response>.
    const line = emit("Fetcher");
    expect(line).toMatch(/returns: __rt\.v\.stub\b/);
  });
});
