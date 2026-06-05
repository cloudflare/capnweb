import { describe, expect, it } from "vitest";
import {
  accepts,
  checkedMethod,
  loadValidator,
  transformFixture,
  validatorShape,
} from "./helpers.js";
import { v } from "../src/internal/core.js";

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

const IMPORTS = `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
import { Fetcher } from "cloudflare:workers";
`;

function returnValidator(returnType: string, extra = "") {
  const { code } = transformFixture(
    `${extra}
class Api extends RpcTarget {
  getThing(): ${returnType} { return null as any; }
}`,
    { shim: SHIM, imports: IMPORTS, lib: ["ES2022", "DOM"], target: "new Api()" }
  );
  return checkedMethod(loadValidator(code), "getThing").returns;
}

describe("Fetcher detection: structural false-positive", () => {
  it("validates an ordinary {fetch,connect} user type as an object, not a stub", () => {
    // Two methods named fetch/connect but a non-Fetcher fetch signature. Must be
    // validated structurally, not waved through as an opaque pass-by-ref stub.
    const validator = returnValidator(
      "NotAFetcher",
      `interface NotAFetcher {
  fetch(url: string): Promise<string>;
  connect(host: string): Promise<void>;
}`
    );
    expect(validatorShape(validator)?.kind).toBe("object");
    expect(accepts(validator, { fetch() {}, connect() {} })).toBe(true);
    expect(accepts(validator, { fetch: "not a function", connect() {} })).toBe(
      false
    );
    expect(accepts(validator, { fetch() {}, connect: "not a function" })).toBe(
      false
    );
  });

  it("keeps a real Fetcher<User> as a pass-by-reference stub", () => {
    const validator = returnValidator(
      "Fetcher<User>",
      `interface User {
  describe(): Promise<string>;
}`
    );
    const shape = validatorShape(validator);
    expect(shape?.kind).toBe("stub");
    const service = shape?.service as ReturnType<typeof loadValidator>;
    expect(service.serviceName).toBe("User");
    expect(checkedMethod(service, "describe").returns).toBe(v.string);
  });

  it("keeps a bare Fetcher (alias erased) as a stub via the fetch signature", () => {
    // `Fetcher` with all type args defaulted drops the "Fetcher" alias name, so
    // the structural fallback must still recognise it by fetch -> Promise<Response>.
    const validator = returnValidator("Fetcher");
    const shape = validatorShape(validator);
    expect(shape?.kind).toBe("stub");
    expect(shape?.service).toBeUndefined();
  });
});
