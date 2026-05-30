// Named shapes are hoisted once and cross-referenced via `lazy` so cycles/order can't capture an unassigned binding; method refs stay direct.
import { describe, it, expect } from "vitest";
import { transformFixture, prelude } from "./helpers.js";

// Transform a worker exposing `class Api` and return only the generated
// validator prelude (everything before the original user import line).
function emitPrelude(body: string): string {
  return prelude(
    transformFixture(body, { target: "new Api()" }).code,
    "import { newWorkersRpcResponse }"
  );
}

describe("emit: named-shape sharing", () => {
  it("emits a type used by two methods once and references it directly", () => {
    const code = emitPrelude(
      `interface User { id: string; name: string }
       class Api extends RpcTarget {
         async getUser(): Promise<User> { return null as any; }
         async listUsers(): Promise<User[]> { return null as any; }
       }`
    );

    // The User shape body is emitted exactly once.
    const bodies = code.match(/v\.object\(\{ "id": __rt\.v\.string, "name": __rt\.v\.string \}/g);
    expect(bodies).toHaveLength(1);

    // Both methods reference the same hoisted binding, directly (no `lazy`)
    // because method-level references are always assigned by emit time.
    expect(code).toContain('"getUser": { args: [], returns: __capnweb_validate_Api_server_shape_0 }');
    expect(code).toContain('"listUsers": { args: [], returns: __rt.v.array(__capnweb_validate_Api_server_shape_0) }');
    expect(code).not.toMatch(/returns: __rt\.v\.lazy/);
  });

  it("does not double `undefined` on an optional property that already admits it", () => {
    const code = emitPrelude(
      `interface Contact { phone?: string | undefined }
       class Api extends RpcTarget {
         async getContact(): Promise<Contact> { return null as any; }
       }`
    );

    expect(code).toContain('"phone": __rt.v.union([__rt.v.undefined_, __rt.v.string])');
    // The optional-property widening must not wrap an already-undefined union
    // in another undefined.
    expect(code).not.toMatch(/union\(\[__rt\.v\.union/);
    expect(code.match(/undefined_/g)).toHaveLength(1);
  });

  it("emits mutually recursive types in any order via deferred cross-references", () => {
    const code = emitPrelude(
      `interface Dir { name: string; entries: Entry[] }
       interface Entry { name: string; parent: Dir }
       class Api extends RpcTarget {
         async getDir(): Promise<Dir> { return null as any; }
         async getEntry(): Promise<Entry> { return null as any; }
       }`
    );

    // Both shapes are forward-declared with `let` so either assignment order works.
    expect(code).toContain('let __capnweb_validate_Api_server_shape_0;');
    expect(code).toContain('let __capnweb_validate_Api_server_shape_2;');

    // Cross-references inside a shape body are deferred with `lazy`.
    expect(code).toMatch(/"entries": __rt\.v\.array\(__rt\.v\.lazy\(\(\) => __capnweb_validate_Api_server_shape_2\)\)/);
    expect(code).toMatch(/"parent": __rt\.v\.lazy\(\(\) => __capnweb_validate_Api_server_shape_0\)/);

    // Method returns reference the bindings directly.
    expect(code).toContain('"getDir": { args: [], returns: __capnweb_validate_Api_server_shape_0 }');
    expect(code).toContain('"getEntry": { args: [], returns: __capnweb_validate_Api_server_shape_2 }');
  });
});
