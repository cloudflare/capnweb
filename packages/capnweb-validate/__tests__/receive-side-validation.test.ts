// Validation runs on the receiving side only: a server checks the arguments it
// is called with, a client checks the return values it gets back. Outgoing
// values are left for the peer to validate on arrival.
import { describe, it, expect } from "vitest";
import {
  v,
  wrapClientStub,
  wrapServerTarget,
  type ServiceValidator,
} from "../src/internal/core.js";

const validator: ServiceValidator = {
  serviceName: "Api",
  methods: { echo: { args: [v.string], returns: v.string } },
};

// A bare stub whose `echo` runs `impl`, plus a `dup()` that returns a fresh copy.
function rawStub(impl: (x: unknown) => unknown): Record<string, unknown> {
  const stub: Record<string, unknown> = { echo: impl };
  stub.dup = () => rawStub(impl);
  return stub;
}

describe("client wrapper: checks returns, not outgoing arguments", () => {
  it("sends a wrong-typed argument without checking it", () => {
    const api = wrapClientStub(rawStub(() => "ok"), validator) as {
      echo(x: unknown): unknown;
    };
    expect(() => api.echo(123)).not.toThrow();
  });

  it("validates the resolved return value", () => {
    const good = wrapClientStub(rawStub(() => "ok"), validator) as {
      echo(x: unknown): unknown;
    };
    expect(good.echo("hi")).toBe("ok");
    const bad = wrapClientStub(rawStub(() => 123), validator) as {
      echo(x: unknown): unknown;
    };
    expect(() => bad.echo("hi")).toThrow(TypeError);
  });

  it("dup() returns a still-validated stub", () => {
    const api = wrapClientStub(rawStub(() => 123), validator) as {
      dup(): { echo(x: unknown): unknown };
    };
    expect(() => api.dup().echo("hi")).toThrow(TypeError);
  });
});

describe("server wrapper: checks arguments, not outgoing returns", () => {
  it("rejects a wrong-typed incoming argument", () => {
    const api = wrapServerTarget(rawStub((x) => x), validator) as {
      echo(x: unknown): unknown;
    };
    expect(() => api.echo(123)).toThrow(TypeError);
    expect(api.echo("hi")).toBe("hi");
  });

  it("passes a wrong-typed return value through unchecked", () => {
    const api = wrapServerTarget(rawStub(() => 123), validator) as {
      echo(x: string): unknown;
    };
    expect(api.echo("hi")).toBe(123);
  });

  it("rejects client-stub infrastructure names outside the server surface", () => {
    const target = rawStub((x) => x);
    target.map = () => "leak";
    const api = wrapServerTarget(target, validator) as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    expect(() => api.map()).toThrow(/not declared on .* RPC interface/);
  });

});
