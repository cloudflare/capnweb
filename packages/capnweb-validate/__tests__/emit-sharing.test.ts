// Named shapes are hoisted once and cross-referenced via `lazy` so cycles/order can't capture an unassigned binding; method refs stay direct.
import { describe, it, expect } from "vitest";
import {
  checkedMethod,
  loadValidator,
  transformFixture,
  validatorShape,
} from "./helpers.js";
import { v, type Validator } from "../src/internal/core.js";

function apiValidator(body: string) {
  return loadValidator(transformFixture(body, { target: "new Api()" }).code);
}

describe("emit: named-shape sharing", () => {
  it("emits a type used by two methods once and references it directly", () => {
    const validator = apiValidator(
      `interface User {
  id: string;
  name: string;
}
class Api extends RpcTarget {
  async getUser(): Promise<User> {
    return null as any;
  }
  async listUsers(): Promise<User[]> {
    return null as any;
  }
}`
    );

    const user = checkedMethod(validator, "getUser").returns;
    const listUsers = checkedMethod(validator, "listUsers").returns;
    const listShape = validatorShape(listUsers);

    // Both methods reference the same validator object directly.
    expect(validatorShape(user)?.kind).toBe("object");
    expect(listShape?.kind).toBe("array");
    expect(listShape?.element).toBe(user);
  });

  it("does not double `undefined` on an optional property that already admits it", () => {
    const validator = apiValidator(
      `interface Contact {
  phone?: string | undefined;
}
class Api extends RpcTarget {
  async getContact(): Promise<Contact> {
    return null as any;
  }
}`
    );

    const contact = checkedMethod(validator, "getContact").returns;
    const contactShape = validatorShape(contact);
    const phone = (contactShape?.properties as Record<string, Validator>).phone!;
    const phoneShape = validatorShape(phone);

    // The optional-property widening must not wrap an already-undefined union
    // in another undefined.
    expect(phoneShape?.kind).toBe("union");
    expect(phoneShape?.branches).toEqual([v.undefined_, v.string]);
  });

  it("emits mutually recursive types in any order via deferred cross-references", () => {
    const validator = apiValidator(
      `interface Dir {
  name: string;
  entries: Entry[];
}
interface Entry {
  name: string;
  parent: Dir;
}
class Api extends RpcTarget {
  async getDir(): Promise<Dir> {
    return null as any;
  }
  async getEntry(): Promise<Entry> {
    return null as any;
  }
}`
    );

    const dir = checkedMethod(validator, "getDir").returns;
    const entry = checkedMethod(validator, "getEntry").returns;
    const dirShape = validatorShape(dir);
    const entryShape = validatorShape(entry);
    const entries = (dirShape?.properties as Record<string, Validator>).entries!;
    const parent = (entryShape?.properties as Record<string, Validator>).parent!;
    const entriesShape = validatorShape(entries);
    const entriesElementShape = validatorShape(entriesShape?.element as Validator);
    const parentShape = validatorShape(parent);

    // Method returns reference the object validators directly.
    expect(dirShape?.kind).toBe("object");
    expect(entryShape?.kind).toBe("object");

    // Cross-references inside a shape body are deferred with `lazy`.
    expect(entriesShape?.kind).toBe("array");
    expect(entriesElementShape?.kind).toBe("lazy");
    expect((entriesElementShape?.thunk as () => Validator)()).toBe(entry);
    expect(parentShape?.kind).toBe("lazy");
    expect((parentShape?.thunk as () => Validator)()).toBe(dir);
  });
});
