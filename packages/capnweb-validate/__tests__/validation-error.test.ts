// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// isValidationError() tells the validator's refusals from every other error,
// by a tag on the error object rather than its message, in the process that
// refused: where Cap'n Web hands a server the error it is about to send.

import { describe, expect, it } from "vitest";

import { newMessagePortRpcSession, RpcTarget } from "../../../src/index.js";
import { isValidationError } from "../src/index.js";
import {
  __validateRpcClass,
  v,
  wrapClientStub,
  type ServiceValidator,
} from "../src/internal/core.js";

const validator: ServiceValidator = {
  serviceName: "Api",
  methods: {
    greet: { args: [v.string], returns: v.string },
    fail: { args: [], returns: v.string },
  },
};

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("isValidationError", () => {
  it("recognizes what the validator throws, and nothing else", () => {
    expect(isValidationError(thrown(() => v.string(1, ["greet", 0])))).toBe(true);
    // A stub answers every name; the validated one refuses those its surface lacks.
    let stub = wrapClientStub({ greet: () => "hi", missing: () => "hi" }, validator) as Record<string, any>;
    expect(isValidationError(thrown(() => stub.missing()))).toBe(true);

    // The message the validator writes is no proof of where an error came from.
    expect(isValidationError(new TypeError("capnweb-validate: at Api.greet[0]"))).toBe(false);
    expect(isValidationError(new Error("capnweb-validate: refused"))).toBe(false);
    expect(isValidationError("capnweb-validate: refused")).toBe(false);
    expect(isValidationError(undefined)).toBe(false);
  });

  it("reads the refusal in the onSendError of the session that refused the call", async () => {
    class Api extends RpcTarget {
      greet(name: string): string {
        return `hi ${name}`;
      }
      fail(): string {
        throw new TypeError("not the validator's");
      }
    }
    __validateRpcClass(validator)(Api);

    let sent: Error[] = [];
    let channel = new MessageChannel();
    newMessagePortRpcSession(channel.port1, new Api(), {
      onSendError(error: Error) {
        sent.push(error);
      },
    });
    let api = newMessagePortRpcSession<Api>(channel.port2) as any;
    try {
      let refused = await api.greet(1).catch((error: unknown) => error);
      let failed = await api.fail().catch((error: unknown) => error);
      expect(sent.map(isValidationError)).toEqual([true, false]);
      // The tag is the refusing process's own: the caller receives a plain
      // TypeError, which carries no symbol across the wire.
      expect(refused).toBeInstanceOf(TypeError);
      expect(isValidationError(refused)).toBe(false);
      expect(isValidationError(failed)).toBe(false);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
});
