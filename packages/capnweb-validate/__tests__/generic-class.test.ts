// Free class type params the decorator can't specialize: unconstrained defaults to any (warn), constrained validates the constraint, generic methods still error.
import { describe, it, expect } from "vitest";
import {
  accepts,
  checkedMethod,
  DECORATOR_SHIM,
  loadValidator,
  transformFixture,
  validatorShape,
} from "./helpers.js";
import { v, wrapServerTarget, type ServiceValidator } from "../src/internal/core.js";

const IMPORTS = `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { RpcTarget } from "capnweb";
`;

function compile(body: string, ctor?: string): { code: string | null; warns: string[]; error?: string } {
  try {
    const { code, warns } = transformFixture(body, { shim: DECORATOR_SHIM, imports: IMPORTS, target: ctor });
    return { code, warns };
  } catch (e) {
    return { code: null, warns: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function compileValidator(
  body: string,
  ctor?: string,
  binding?: string
): { validator: ServiceValidator; warns: string[] } {
  const { code, warns, error } = compile(body, ctor);
  if (!code) throw new Error(error ?? "expected transform to succeed");
  return { validator: loadValidator(code, binding), warns };
}

describe("generic service classes", () => {
  it("keeps public class methods outside a single implemented interface", () => {
    const { validator, warns } = compileValidator(
      `interface A {
  a(): Promise<string>;
}
@validateRpc()
class Api extends RpcTarget implements A {
  async a(): Promise<string> {
    return "";
  }
  async extra(x: number): Promise<number> {
    return x;
  }
}`,
      "new Api()");
    expect(checkedMethod(validator, "a").returns).toBe(v.string);
    const extra = checkedMethod(validator, "extra");
    expect(extra.args[0]).toBe(v.number);
    expect(extra.returns).toBe(v.number);
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("uses a single implemented interface to sharpen matching method signatures", () => {
    const { validator, warns } = compileValidator(
      `interface A {
  a(x: string): Promise<string>;
}
@validateRpc()
class Api extends RpcTarget implements A {
  async a(x: any): Promise<any> {
    return x;
  }
  async extra(x: number): Promise<number> {
    return x;
  }
}`,
      "new Api()",
      "__capnweb_validate_Api_server_2");
    const a = checkedMethod(validator, "a");
    expect(a.args[0]).toBe(v.string);
    expect(a.returns).toBe(v.string);
    const extra = checkedMethod(validator, "extra");
    expect(extra.args[0]).toBe(v.number);
    expect(extra.returns).toBe(v.number);
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("defaults an unconstrained class type parameter to any, with a warning", () => {
    const { validator, warns } = compileValidator(
      `interface Cursor<T> {
  next(): Promise<T>;
}
@validateRpc()
class Api<T> extends RpcTarget implements Cursor<T> {
  async next(): Promise<T> {
    return null as any;
  }
}`,
      "new Api()");
    expect(checkedMethod(validator, "next").returns).toBe(v.any);
    expect(warns.join("")).toContain("unconstrained type parameters default to `any`");
  });

  it("validates against the constraint for a constrained parameter, with no warning", () => {
    const { validator, warns } = compileValidator(
      `interface Cursor<T> {
  next(): Promise<T>;
}
@validateRpc()
class Api<T extends { id: string }> extends RpcTarget implements Cursor<T> {
  async next(): Promise<T> {
    return null as any;
  }
}`,
      "new Api<{ id: string }>()");
    const next = checkedMethod(validator, "next");
    expect(accepts(next.returns, { id: "ok" })).toBe(true);
    expect(accepts(next.returns, { id: 1 })).toBe(false);
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("uses an explicit decorator type argument as the RPC surface", () => {
    const { validator, warns } = compileValidator(
      `interface Cursor<T> {
  next(): Promise<T>;
}
@validateRpc<Cursor<string>>()
class Api<T> extends RpcTarget implements Cursor<T> {
  async next(): Promise<T> {
    return null as any;
  }
  async extra(x: number): Promise<number> {
    return x;
  }
}`,
      undefined);
    expect(checkedMethod(validator, "next").returns).toBe(v.string);
    expect(Object.keys(validator.methods)).toEqual(["next"]);
    const wrapped = wrapServerTarget(
      { next: async () => "", extra: async (x: number) => x },
      validator
    ) as { extra(x: number): Promise<number> };
    expect(() => wrapped.extra(1)).toThrow(/not declared on .* RPC interface/);
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("does not let an explicit method signature turn a getter into a method", () => {
    const { validator } = compileValidator(
      `interface Sig {
  config(): Promise<string>;
}
@validateRpc<Sig>()
class Api extends RpcTarget {
  get config(): Promise<string> {
    return Promise.resolve("ok");
  }
}`,
      undefined);
    const config = checkedMethod(validator, "config");
    expect(config.returns).toBe(v.string);
    expect(config.isGetter).toBe(true);
  });

  it("does not let an explicit getter signature turn a method into a getter", () => {
    const { validator } = compileValidator(
      `interface Sig {
  value: string;
}
@validateRpc<Sig>()
class Api extends RpcTarget {
  value(): string {
    return "ok";
  }
}`,
      undefined);
    const value = checkedMethod(validator, "value");
    expect(value.returns).toBe(v.string);
    expect(value.isGetter).not.toBe(true);
  });

  it("keeps an overloaded explicit signature unchecked for a callable class method", () => {
    const { validator } = compileValidator(
      `interface Sig {
  foo(): Promise<string>;
  foo(x: string): Promise<string>;
}
@validateRpc<Sig>()
class Api extends RpcTarget {
  async foo(x?: any): Promise<any> {
    return "";
  }
}`,
      undefined);
    expect(validator.methods.foo).toEqual({ unchecked: true });
  });

  it("does not warn for an overloaded explicit signature when the class method is skipped", () => {
    const { validator, warns } = compileValidator(
      `interface Sig {
  foo(x: string): Promise<string>;
  foo(x: number): Promise<number>;
}
@validateRpc<Sig>()
class Api extends RpcTarget {
  @skipRpcValidation()
  async foo(x: any): Promise<any> {
    return x;
  }
}`,
      undefined);
    expect(validator.methods.foo).toEqual({ unchecked: true });
    expect(warns.join("")).not.toContain("overloaded");
  });

  it("does not add explicit signature members missing from the class surface", () => {
    const { validator, warns } = compileValidator(
      `interface Sig {
  extra(): Promise<string>;
  extra(x: string): Promise<string>;
}
@validateRpc<Sig>()
class Api extends RpcTarget {
  ok(): string {
    return "ok";
  }
}`,
      undefined);
    expect(Object.keys(validator.methods)).toEqual([]);
    expect(warns.join("")).not.toContain("overloaded");
  });

  it("does not resolve explicit signature members matching non-RPC class fields", () => {
    const { validator, warns } = compileValidator(
      `interface Sig {
  field(): Promise<string>;
  field(x: string): Promise<string>;
}
@validateRpc<Sig>()
class Api extends RpcTarget {
  field = 1;
  ok(): string {
    return "ok";
  }
}`,
      undefined);
    expect(Object.keys(validator.methods)).toEqual([]);
    expect(warns.join("")).not.toContain("overloaded");
  });

  it("does not warn when an overloaded signature name is a class getter", () => {
    const { validator, warns } = compileValidator(
      `interface Sig {
  foo(): Promise<string>;
  foo(x: string): Promise<string>;
}
@validateRpc<Sig>()
class Api extends RpcTarget {
  get foo(): Promise<string> {
    return Promise.resolve("ok");
  }
}`,
      undefined);
    const foo = checkedMethod(validator, "foo");
    expect(foo.returns).toBe(v.string);
    expect(foo.isGetter).toBe(true);
    expect(warns.join("")).not.toContain("overloaded");
  });

  it("does not reuse a filtered signature source for nested stub validation", () => {
    const { validator } = compileValidator(
      `type RpcStub<T> = T & { readonly __RPC_STUB_BRAND: T };
interface Sig {
  a(): Promise<string>;
  admin(): Promise<number>;
}
interface Peer {
  a(): Promise<string>;
  peer(p: RpcStub<Sig>): Promise<void>;
}
@validateRpc<Peer>()
class Api extends RpcTarget {
  a(): Promise<string> {
    return Promise.resolve("");
  }
  peer(p: RpcStub<Sig>): Promise<void> {
    return Promise.resolve();
  }
}`,
      undefined);
    expect(checkedMethod(validator, "a").returns).toBe(v.string);
    const peerArg = checkedMethod(validator, "peer").args[0]!;
    const shape = validatorShape(peerArg);
    expect(shape?.kind).toBe("stub");
    const service = shape?.service as ServiceValidator;
    expect(checkedMethod(service, "a").returns).toBe(v.string);
    expect(checkedMethod(service, "admin").returns).toBe(v.number);
  });

  it("resolves a class with multiple implemented interfaces via the class surface", () => {
    const { validator, warns } = compileValidator(
      `interface A {
  a(): Promise<string>;
}
interface B {
  b(): Promise<number>;
}
@validateRpc()
class Api extends RpcTarget implements A, B {
  async a(): Promise<string> {
    return "";
  }
  async b(): Promise<number> {
    return 0;
  }
}`,
      "new Api()");
    expect(checkedMethod(validator, "a").returns).toBe(v.string);
    expect(checkedMethod(validator, "b").returns).toBe(v.number);
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("still errors on a generic method, because no class type argument can fix it", () => {
    const { code, error } = compile(
      `@validateRpc()
class Api extends RpcTarget {
  async get<T>(x: T): Promise<T> {
    return null as any;
  }
}`,
      "new Api()");
    expect(code).toBeNull();
    expect(error).toContain("unresolved generic type parameter");
  });
});
