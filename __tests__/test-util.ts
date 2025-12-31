// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Common RPC interfaces / implementations used in several tests.

import { RpcStub, RpcTarget } from '../src/index.js';

export class Counter extends RpcTarget {
  constructor(private i: number = 0) {
    super();
  }

  increment(amount: number = 1): number {
    this.i += amount;
    return this.i;
  }

  get value() {
    return this.i;
  }
}

// Distinct function so we can search for it in the stack trace.
function throwErrorImpl(): never {
  throw new RangeError("test error");
}

export class TestTarget extends RpcTarget {
  square(i: number) {
    return i * i;
  }

  callSquare(self: RpcStub<TestTarget>, i: number) {
    return { result: self.square(i) };
  }

  async callFunction(func: RpcStub<(i: number) => Promise<number>>, i: number) {
    return { result: await func(i) };
  }

  throwError() {
    throwErrorImpl();
  }

  makeCounter(i: number) {
    return new Counter(i);
  }

  incrementCounter(c: RpcStub<Counter>, i: number = 1) {
    return c.increment(i);
  }

  generateFibonacci(length: number) {
    let result = [0, 1];
    if (length <= result.length) return result.slice(0, length);

    while (result.length < length) {
      let next = result[result.length - 1] + result[result.length - 2];
      result.push(next);
    }

    return result;
  }

  returnNull() { return null; }
  returnUndefined() { return undefined; }
  returnNumber(i: number) { return i; }
}
