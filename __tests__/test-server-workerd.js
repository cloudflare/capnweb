// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Test server implemented in workerd instead of Node.
//
// This is only used by the workerd tests, across a service binding.
//
// This file is JavaScript instead of TypeScript because otherwise we'd need to set up a separate
// build step for it. Instead, we're getting by configuring the worker in vitest.config.ts by
// just specifying the raw JS modules.

import { newWorkersRpcResponse } from "../dist/index-workers.js";
import { RpcTarget, DurableObject } from "cloudflare:workers";

// TODO(cleanup): At present we clone the implementation of Counter and TestTarget because
//   otherwise we need to set up a build step for `test-util.ts`.
export class Counter extends RpcTarget {
  constructor(i) {
    super();
    this.i = i;
  }

  increment(amount = 1) {
    this.i += amount;
    return this.i;
  }
}

export class TestDo extends DurableObject {
  setValue(val) {
    this.value = val;
  }

  getValue() {
    return this.value;
  }
}

export class TestTarget extends RpcTarget {
  constructor(env) {
    super();
    this.env = env;
  }

  square(i) {
    return i * i;
  }

  callSquare(self, i) {
    return { result: self.square(i) };
  }

  throwError() {
    throw new RangeError("test error");
  }

  makeCounter(i) {
    return new Counter(i);
  }

  incrementCounter(c, i = 1) {
    return c.increment(i);
  }

  getDurableObject(name) {
    return this.env.TEST_DO.getByName(name);
  }
}

export default {
  async fetch(req, env, ctx) {
    return newWorkersRpcResponse(req, new TestTarget(env), {
      onSendError(err) { return err; }
    });
  },

  async greet(name, env, ctx) {
    return `Hello, ${name}!`;
  }
}
