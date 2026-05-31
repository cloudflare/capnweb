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
});
