// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Runtime behavior of `__validateRpcClass` (the runtime half of
// `@validateRpc()`). The decorator must wrap declared methods in place on the
// class's prototype rather than Proxy-wrapping instances: native (workerd)
// RPC refuses Proxy targets, and a decorated subclass of a decorated base
// must resolve subclass-only methods against the subclass validator.
// Regression tests for the GitHubPullRequestImpl-extends-GitHubIssueImpl
// failure ("X is not in the generated validator").

import { describe, expect, it } from "vitest";
import {
  __validateRpcClass,
  isWrappedMethod,
  v,
  wrapServerTarget,
  type ServiceValidator,
  type Validator,
} from "../src/internal/core.js";

function countingString(counter: { calls: number }): Validator {
  return ((value: unknown, path) => {
    counter.calls++;
    v.string(value, path);
  }) as Validator;
}

describe("__validateRpcClass prototype wrapping", () => {
  it("constructs real instances: identity, prototype chain, and # fields intact", async () => {
    let captured: unknown;
    class Svc {
      #greeting = "pong";
      constructor() {
        captured = this;
      }
      async ping(): Promise<string> {
        return this.#greeting;
      }
    }
    const validator: ServiceValidator = {
      serviceName: "Svc",
      methods: { ping: { args: [], returns: v.string } },
    };
    const Decorated = __validateRpcClass(validator)(Svc);

    let instance = new Decorated();
    // The old implementation returned a Proxy from the constructor, so the
    // value you got from `new` was not the `this` the constructor saw, and
    // the prototype chain gained a synthetic subclass.
    expect(instance).toBe(captured);
    expect(Object.getPrototypeOf(instance)).toBe(Decorated.prototype);
    expect(instance instanceof Svc).toBe(true);
    // `#` field access works because methods run on the real instance.
    await expect(instance.ping()).resolves.toBe("pong");
    // The prototype method is the validated wrapper.
    expect(isWrappedMethod(Decorated.prototype.ping)).toBe(true);
  });

  it("decorated subclass of a decorated base resolves subclass-only methods", async () => {
    class IssueImpl {
      #title = "hello title";
      async getTitle(): Promise<string> {
        return this.#title;
      }
    }
    const issueValidator: ServiceValidator = {
      serviceName: "IssueImpl",
      methods: { getTitle: { args: [], returns: v.string } },
    };
    const VIssue = __validateRpcClass(issueValidator)(IssueImpl);

    class PullImpl extends VIssue {
      async readDiff(): Promise<string> {
        return "diff content";
      }
    }
    const pullValidator: ServiceValidator = {
      serviceName: "PullImpl",
      methods: {
        // Generated subclass validators repeat inherited methods.
        getTitle: { args: [], returns: v.string },
        readDiff: { args: [], returns: v.string },
      },
    };
    const VPull = __validateRpcClass(pullValidator)(PullImpl);

    let pull = new VPull();
    // Regression: previously rejected with
    // "PullImpl.readDiff is not in the generated validator" because the base
    // class's instance Proxy answered for the subclass.
    await expect(pull.readDiff()).resolves.toBe("diff content");
    await expect(pull.getTitle()).resolves.toBe("hello title");
    expect(pull instanceof VIssue).toBe(true);
  });

  it("validates subclass-only method args against the subclass validator", () => {
    class Base {
      async noop(): Promise<string> {
        return "ok";
      }
    }
    const VBase = __validateRpcClass({
      serviceName: "Base",
      methods: { noop: { args: [], returns: v.string } },
    })(Base);

    class Sub extends VBase {
      async setTitle(_title: string): Promise<string> {
        return "set";
      }
    }
    const VSub = __validateRpcClass({
      serviceName: "Sub",
      methods: {
        noop: { args: [], returns: v.string },
        setTitle: { args: [v.string], returns: v.string },
      },
    })(Sub);

    let sub = new VSub();
    // Args are receiver-validated on the server side, and the error path
    // names the subclass validator.
    expect(() => (sub.setTitle as (x: unknown) => unknown)(123)).toThrow(
      /Sub\.setTitle/
    );
  });

  it("does not double-validate inherited methods or double decoration", async () => {
    let counter = { calls: 0 };
    let arg = countingString(counter);

    class Base {
      async echo(value: string): Promise<string> {
        return value;
      }
    }
    const baseValidator: ServiceValidator = {
      serviceName: "Base",
      methods: { echo: { args: [arg], returns: v.string } },
    };
    const VBase = __validateRpcClass(baseValidator)(Base);

    // Subclass validator re-declares the inherited method (as generated
    // validators do); the base's wrapper must stay in charge.
    class Sub extends VBase {}
    const VSub = __validateRpcClass({
      serviceName: "Sub",
      methods: { echo: { args: [arg], returns: v.string } },
    })(Sub);

    let sub = new VSub();
    await expect(sub.echo("x")).resolves.toBe("x");
    expect(counter.calls).toBe(1);

    // Decorating the same class twice is also a no-op the second time.
    counter.calls = 0;
    const Twice = __validateRpcClass(baseValidator)(
      __validateRpcClass(baseValidator)(
        class {
          async echo(value: string): Promise<string> {
            return value;
          }
        }
      )
    );
    await expect(new Twice().echo("y")).resolves.toBe("y");
    expect(counter.calls).toBe(1);
  });

  it("wraps declared getters on the prototype with `this` intact", () => {
    class WithGetter {
      #title = "hello";
      get title(): string {
        return this.#title;
      }
    }
    const Decorated = __validateRpcClass({
      serviceName: "WithGetter",
      methods: { title: { args: [], returns: v.string, isGetter: true } },
    })(WithGetter);

    let instance = new Decorated();
    expect(instance.title).toBe("hello");
    let desc = Object.getOwnPropertyDescriptor(Decorated.prototype, "title");
    expect(isWrappedMethod(desc?.get)).toBe(true);
  });

  it("leaves undeclared prototype methods callable (exposure is the RPC layer's model)", async () => {
    // Access control is the RPC layer's job: prototype methods are the
    // surface, instance properties are refused by capnweb/workerd themselves,
    // and `#` members are the privacy mechanism. The validator validates the
    // declared surface; it no longer interposes on undeclared members (the
    // old instance Proxy refused them externally but allowed internal calls,
    // which cannot be expressed without Proxy-wrapping instances).
    class WithHelper {
      async declared(): Promise<string> {
        return this.helper();
      }
      helper(): string {
        return "helped";
      }
    }
    const Decorated = __validateRpcClass({
      serviceName: "WithHelper",
      methods: { declared: { args: [], returns: v.string } },
    })(WithHelper);

    let instance = new Decorated();
    await expect(instance.declared()).resolves.toBe("helped");
    expect(instance.helper()).toBe("helped");
    expect(isWrappedMethod(Decorated.prototype.helper)).toBe(false);
  });

  it("wrapServerTarget passes through already-wrapped methods without re-validating", async () => {
    let counter = { calls: 0 };
    let arg = countingString(counter);

    class Svc {
      async echo(value: string): Promise<string> {
        return value;
      }
    }
    const validator: ServiceValidator = {
      serviceName: "Svc",
      methods: { echo: { args: [arg], returns: v.string } },
    };
    const Decorated = __validateRpcClass(validator)(Svc);

    // A decorated instance handed to a session entry point (which wraps its
    // localMain in wrapServerTarget) must not validate args twice.
    let wrapped = wrapServerTarget(new Decorated(), validator) as Svc;
    await expect(wrapped.echo("x")).resolves.toBe("x");
    expect(counter.calls).toBe(1);
  });
});
