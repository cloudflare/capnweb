// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { RpcTargetBranded, __RPC_TARGET_BRAND } from "./types.js";
import { WORKERS_MODULE_SYMBOL } from "./symbols.js"

// Polyfill Symbol.dispose for browsers that don't support it yet
if (!Symbol.dispose) {
  (Symbol as any).dispose = Symbol.for('dispose');
}
if (!Symbol.asyncDispose) {
  (Symbol as any).asyncDispose = Symbol.for('asyncDispose');
}

// Polyfill Promise.withResolvers() for old Safari versions (ugh), Hermes (React Native), and
// maybe others.
if (!Promise.withResolvers) {
  Promise.withResolvers = function<T>(): PromiseWithResolvers<T> {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve: resolve!, reject: reject! };
  };
}

let workersModule: any = (globalThis as any)[WORKERS_MODULE_SYMBOL];

export interface RpcTarget {
  [__RPC_TARGET_BRAND]: never;
};

export let RpcTarget = workersModule ? workersModule.RpcTarget : class {};

export type PropertyPath = (string | number)[];

type TypeForRpc = "unsupported" | "primitive" | "object" | "function" | "array" | "date" |
    "bigint" | "bytes" | "stub" | "rpc-promise" | "rpc-target" | "rpc-thenable" | "error" |
    "undefined";

const AsyncFunction = (async function () {}).constructor;

export function typeForRpc(value: unknown): TypeForRpc {
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return "primitive";

    case "undefined":
      return "undefined";

    case "object":
    case "function":
      // Test by prototype, below.
      break;

    case "bigint":
      return "bigint";

    default:
      return "unsupported";
  }

  // Ugh JavaScript, why is `typeof null` equal to "object" but null isn't otherwise anything like
  // an object?
  if (value === null) {
    return "primitive";
  }

  // Aside from RpcTarget, we generally don't support serializing *subclasses* of serializable
  // types, so we switch on the exact prototype rather than use `instanceof` here.
  let prototype = Object.getPrototypeOf(value);
  switch (prototype) {
    case Object.prototype:
      return "object";

    case Function.prototype:
    case AsyncFunction.prototype:
      return "function";

    case Array.prototype:
      return "array";

    case Date.prototype:
      return "date";

    case Uint8Array.prototype:
      return "bytes";

    // TODO: All other structured clone types.

    case RpcStub.prototype:
      return "stub";

    case RpcPromise.prototype:
      return "rpc-promise";

    // TODO: Promise<T> or thenable

    default:
      if (workersModule) {
        // TODO: We also need to match `RpcPromise` and `RpcProperty`, but they currently aren't
        //   exported by cloudflare:workers.
        if (prototype == workersModule.RpcStub.prototype ||
            value instanceof workersModule.ServiceStub) {
          return "rpc-target";
        } else if (prototype == workersModule.RpcPromise.prototype ||
                   prototype == workersModule.RpcProperty.prototype) {
          // Like rpc-target, but should be wrapped in RpcPromise, so that it can be pull()ed,
          // which will await the thenable.
          return "rpc-thenable";
        }
      }

      if (value instanceof RpcTarget) {
        return "rpc-target";
      }

      if (value instanceof Error) {
        return "error";
      }

      return "unsupported";
  }
}

function mapNotLoaded(): never {
  throw new Error("RPC map() implementation was not loaded.");
}

// map() is implemented in `map.ts`. We can't import it here because it would create an import
// cycle, so instead we define two hook functions that map.ts will overwrite when it is imported.
export let mapImpl: MapImpl = { applyMap: mapNotLoaded, sendMap: mapNotLoaded };

type MapImpl = {
  // Applies a map function to an input value (usually an array).
  applyMap(input: unknown, parent: object | undefined, owner: RpcPayload | null,
           captures: StubHook[], instructions: unknown[])
          : StubHook;

  // Implements the .map() method of RpcStub.
  sendMap(hook: StubHook, path: PropertyPath, func: (value: RpcPromise) => unknown)
         : RpcPromise;
}

// Inner interface backing an RpcStub or RpcPromise.
//
// A hook may eventually resolve to a "payload".
//
// Declared as `abstract class` to allow `instanceof StubHook`, used by `RpcStub` constructor.
//
// This is conceptually similar to the Cap'n Proto C++ class `ClientHook`.
export abstract class StubHook {
  // Call a function at the given property path with the given arguments. Returns a hook for the
  // promise for the result.
  abstract call(path: PropertyPath, args: RpcPayload): StubHook;

  // Apply a map operation.
  //
  // `captures` is a list of external stubs which are used as part of the mapper function.
  // NOTE: The callee takes ownership of `captures`.
  //
  // `instructions` is a JSON-serializable value describing the mapper function as a series of
  // steps. Each step is an expression to evaluate, in the usual RPC expression format. The last
  // instruction is the return value.
  //
  // Each instruction can refer to the results of any of the instructions before it, as well as to
  // the captures, as if they were imports on the import table. In particular:
  // * The value 0 is the input to the mapper function (e.g. one element of the array being mapped).
  // * Positive values are 1-based indexes into the instruction table, representing the results of
  //   previous instructions.
  // * Negative values are -1-based indexes into the capture list.
  abstract map(path: PropertyPath, captures: StubHook[], instructions: unknown[]): StubHook;

  // Read the property at the given path. Returns a StubHook representing a promise for that
  // property. This behaves very similarly to call(), except that no actual function is invoked
  // on the remote end, the property is simply returned. (Well, if the property has a getter, then
  // that will be invoked...)
  //
  // (In the case that this stub is a promise with a resolution payload, get() implies cloning
  // a branch of the payload, making a deep copy of any pass-by-value content.)
  abstract get(path: PropertyPath): StubHook;

  // Create a clone of this StubHook, which can be disposed independently.
  //
  // The returned hook is NOT considered a promise, so will not resolve to a payload (you can use
  // `get([])` to get a promise for a cloned payload).
  abstract dup(): StubHook;

  // Requests resolution of a StubHook that represents a promise, and eventually produces the
  // payload.
  //
  // pull() should not be called on capabilities that aren't promises. It may never resolve or it
  // may throw an exception.
  //
  // If pull() is never called (on a remote promise), the RPC system will not transmit the
  // resolution at all. This allows a promise to be used strictly for pipelining.
  //
  // If the payload is already available, pull() returns it immediately, instead of returning a
  // promise. This allows the caller to skip the microtask queue which is sometimes necessary to
  // maintain e-order guarantees.
  //
  // The returned RpcPayload is the same one backing the StubHook itself. If the caller delivers
  // or disposes the payload directly, then it should not call dispose() on the hook. If the caller
  // does not intend to consume the StubHook, the caller must take responsibility for cloning the
  // payload.
  //
  // You can call pull() multiple times, but it will return the same RpcPayload every time, and
  // that payload should only be disposed once.
  //
  // If pull() returns a promise which rejects, the StubHook does not need to be disposed.
  abstract pull(): RpcPayload | Promise<RpcPayload>;

  // Called to prevent this stub from generating unhandled rejection events if it throws without
  // having been pulled. Without this, if a client "push"es a call that immediately throws before
  // the client manages to "pull" it or use it in a pipeline, this may be treated by the system as
  // an unhandled rejection. Unfortunately, this unhandled rejection would be reported in the
  // callee rather than the caller, possibly causing the callee to crash or log spurious errors,
  // even though it's really up to the caller to deal with the exception!
  abstract ignoreUnhandledRejections(): void;

  // Attempts to cancel any outstanding promise backing this hook, and disposes the payload that
  // pull() would return (if any). If a pull() promise is outstanding, it may still resolve (with
  // a disposed payload) or it may reject. It's safe to call dispose() multiple times.
  abstract dispose(): void;

  abstract onBroken(callback: (error: any) => void): void;
}

export class ErrorStubHook extends StubHook {
  constructor(private error: any) { super(); }

  call(path: PropertyPath, args: RpcPayload): StubHook { return this; }
  map(path: PropertyPath, captures: StubHook[], instructions: unknown[]): StubHook { return this; }
  get(path: PropertyPath): StubHook { return this; }
  dup(): StubHook { return this; }
  pull(): RpcPayload | Promise<RpcPayload> { return Promise.reject(this.error); }
  ignoreUnhandledRejections(): void {}
  dispose(): void {}
  onBroken(callback: (error: any) => void): void {
    try {
      callback(this.error);
    } catch (err) {
      // Don't throw back into the RPC system. Treat this as an unhandled rejection.
      Promise.resolve(err);
    }
  }
};

const DISPOSED_HOOK: StubHook = new ErrorStubHook(
    new Error("Attempted to use RPC stub after it has been disposed."));

// A call interceptor can be used to intercept all RPC stub invocations within some synchronous
// scope. This is used to implement record/replay
type CallInterceptor = (hook: StubHook, path: PropertyPath, params: RpcPayload) => StubHook;
let doCall: CallInterceptor = (hook: StubHook, path: PropertyPath, params: RpcPayload) => {
  return hook.call(path, params);
}

export function withCallInterceptor<T>(interceptor: CallInterceptor, callback: () => T): T {
  let oldValue = doCall;
  doCall = interceptor;
  try {
    return callback();
  } finally {
    doCall = oldValue;
  }
}

// Private symbol which may be used to unwrap the real stub through the Proxy.
let RAW_STUB = Symbol("realStub");

export interface RpcStub extends Disposable {
  // Declare magic `RAW_STUB` key that unwraps the proxy.
  [RAW_STUB]: this;
}

const PROXY_HANDLERS: ProxyHandler<{raw: RpcStub}> = {
  apply(target: {raw: RpcStub}, thisArg: any, argumentsList: any[]) {
    let stub = target.raw;
    return new RpcPromise(doCall(stub.hook,
        stub.pathIfPromise || [], RpcPayload.fromAppParams(argumentsList)), []);
  },

  get(target: {raw: RpcStub}, prop: string | symbol, receiver: any) {
    let stub = target.raw;
    if (prop === RAW_STUB) {
      return stub;
    } else if (prop in RpcPromise.prototype) {
      // Any method or property declared on RpcPromise (including inherited from RpcStub or
      // Object) should pass through to the target object, as trying to turn these into RPCs will
      // likely be problematic.
      //
      // Note we don't just check `prop in target` because we intentionally want to hide the
      // properties `hook` and `path`.
      return (<any>stub)[prop];
    } else if (typeof prop === "string") {
      // Return promise for property.
      return new RpcPromise(stub.hook,
          stub.pathIfPromise ? [...stub.pathIfPromise, prop] : [prop]);
    } else if (prop === Symbol.dispose &&
          (!stub.pathIfPromise || stub.pathIfPromise.length == 0)) {
      // We only advertise Symbol.dispose on stubs and root promises, not properties.
      return () => {
        stub.hook.dispose();
        stub.hook = DISPOSED_HOOK;
      };
    } else {
      return undefined;
    }
  },

  has(target: {raw: RpcStub}, prop: string | symbol) {
    let stub = target.raw;
    if (prop === RAW_STUB) {
      return true;
    } else if (prop in RpcPromise.prototype) {
      return prop in stub;
    } else if (typeof prop === "string") {
      return true;
    } else if (prop === Symbol.dispose &&
          (!stub.pathIfPromise || stub.pathIfPromise.length == 0)) {
      return true;
    } else {
      return false;
    }
  },

  construct(target: {raw: RpcStub}, args: any) {
    throw new Error("An RPC stub cannot be used as a constructor.");
  },

  defineProperty(target: {raw: RpcStub}, property: string | symbol, attributes: PropertyDescriptor)
      : boolean {
    throw new Error("Can't define properties on RPC stubs.");
  },

  deleteProperty(target: {raw: RpcStub}, p: string | symbol): boolean {
    throw new Error("Can't delete properties on RPC stubs.");
  },

  getOwnPropertyDescriptor(target: {raw: RpcStub}, p: string | symbol): PropertyDescriptor | undefined {
    // Treat all properties as prototype properties. That's probably fine?
    return undefined;
  },

  getPrototypeOf(target: {raw: RpcStub}): object | null {
    return Object.getPrototypeOf(target.raw);
  },

  isExtensible(target: {raw: RpcStub}): boolean {
    return false;
  },

  ownKeys(target: {raw: RpcStub}): ArrayLike<string | symbol> {
    return [];
  },

  preventExtensions(target: {raw: RpcStub}): boolean {
    // Extensions are not possible anyway.
    return true;
  },

  set(target: {raw: RpcStub}, p: string | symbol, newValue: any, receiver: any): boolean {
    throw new Error("Can't assign properties on RPC stubs.");
  },

  setPrototypeOf(target: {raw: RpcStub}, v: object | null): boolean {
    throw new Error("Can't override prototype of RPC stubs.");
  },
};

// Implementation of RpcStub.
//
// Note that the in the public API, we override the type of RpcStub to reflect the interface
// exposed by the proxy. That happens in index.ts. But for internal purposes, it's easier to just
// omit the type parameter.
export class RpcStub extends RpcTarget {
  // Although `hook` and `path` are declared `public` here, they are effectively hidden by the
  // proxy.
  constructor(hook: StubHook, pathIfPromise?: PropertyPath) {
    super();

    if (!(hook instanceof StubHook)) {
      // Application invoked the constructor to explicitly construct a stub backed by some value
      // (usually an RpcTarget). (Note we override the types as seen by the app, which is why
      // the app can pass something that isn't a StubHook -- within the implementation, though,
      // we always pass StubHook.)
      let value = <any>hook;
      if (value instanceof RpcTarget || value instanceof Function) {
        hook = TargetStubHook.create(value, undefined);
      } else {
        // We adopt the value with "return" semantics since we want to take ownership of any stubs
        // within.
        hook = new PayloadStubHook(RpcPayload.fromAppReturn(value));
      }

      // Don't let app set this.
      if (pathIfPromise) {
        throw new TypeError("RpcStub constructor expected one argument, received two.");
      }
    }

    this.hook = hook;
    this.pathIfPromise = pathIfPromise;

    // Proxy has an unfortunate rule that it will only be considered callable if the underlying
    // `target` is callable, i.e. a function. So our target *must* be callable. So we use a
    // dummy function.
    let func: any = () => {};
    func.raw = this;
    return new Proxy(func, PROXY_HANDLERS);
  }

  public hook: StubHook;
  public pathIfPromise?: PropertyPath;

  dup(): RpcStub {
    // Unfortunately the method will be invoked with `this` being the Proxy, not the `RpcPromise`
    // itself, so we have to unwrap it.

    // Note dup() intentionally resets the path to empty and turns the result into a stub.
    // TODO: Maybe it should actually return the same type? But I think that's not what it does
    //   in Workers RPC today? (Need to check.) Alternatively, should there be an optional
    //   parameter to specify promise vs. stub?
    let target = this[RAW_STUB];
    if (target.pathIfPromise) {
      return new RpcStub(target.hook.get(target.pathIfPromise));
    } else {
      return new RpcStub(target.hook.dup());
    }
  }

  onRpcBroken(callback: (error: any) => void) {
    this[RAW_STUB].hook.onBroken(callback);
  }

  map(func: (value: RpcPromise) => unknown): RpcPromise {
    let {hook, pathIfPromise} = this[RAW_STUB];
    return mapImpl.sendMap(hook, pathIfPromise || [], func);
  }

  toString() {
    return "[object RpcStub]";
  }
}

export class RpcPromise extends RpcStub {
  // TODO: Support passing target value or promise to constructor.
  constructor(hook: StubHook, pathIfPromise: PropertyPath) {
    super(hook, pathIfPromise);
  }

  then(onfulfilled?: ((value: unknown) => unknown) | undefined | null,
       onrejected?: ((reason: any) => unknown) | undefined | null)
       : Promise<unknown> {
    return pullPromise(this).then(...arguments);
  }

  catch(onrejected?: ((reason: any) => unknown) | undefined | null): Promise<unknown> {
    return pullPromise(this).catch(...arguments);
  }

  finally(onfinally?: (() => void) | undefined | null): Promise<unknown> {
    return pullPromise(this).finally(...arguments);
  }

  toString() {
    return "[object RpcPromise]";
  }
}

// Given a stub (still wrapped in a Proxy), extract the underlying `StubHook`.
//
// The caller takes ownership, meaning it's expected that the original stub will never be disposed
// itself, but the caller is responsible for calling `dispose()` on the returned hook.
//
// However, if the stub points to a property of some other stub or promise, then no ownership is
// "transferred" because properties do not actually have disposers. However, the returned hook is
// a new hook that aliases that property, but does actually need to be disposed.
//
// The result is a promise (i.e. can be pull()ed) if and only if the input is a promise.
export function unwrapStubTakingOwnership(stub: RpcStub): StubHook {
  let {hook, pathIfPromise} = stub[RAW_STUB];

  if (pathIfPromise && pathIfPromise.length > 0) {
    return hook.get(pathIfPromise);
  } else {
    return hook;
  }
}

// Given a stub (still wrapped in a Proxy), extract the underlying `StubHook`, and duplicate it,
// returning the duplicate.
//
// The caller is responsible for disposing the returned hook, but the original stub also still
// needs to be disposed by its owner (unless it is a property, which never needs disposal).
//
// The result is a promise (i.e. can be pull()ed) if and only if the input is a promise. Note that
// this differs from the semantics of the actual `dup()` method.
export function unwrapStubAndDup(stub: RpcStub): StubHook {
  let {hook, pathIfPromise} = stub[RAW_STUB];

  if (pathIfPromise) {
    return hook.get(pathIfPromise);
  } else {
    return hook.dup();
  }
}

// Unwrap a stub returning the underlying `StubHook`, returning `undefined` if it is a property
// stub.
//
// This function is agnostic to ownership transfer. Exactly one of `stub` or the return `hook` must
// eventually be disposed (unless `undefined` is returned, in which case neither need to be
// disposed, as properties are not normally disposable).
export function unwrapStubNoProperties(stub: RpcStub): StubHook | undefined {
  let {hook, pathIfPromise} = stub[RAW_STUB];

  if (pathIfPromise && pathIfPromise.length > 0) {
    return undefined;
  }

  return hook;
}

// Unwrap a stub returning the underlying `StubHook`. If it's a property, return the `StubHook`
// representing the stub or promise of which is is a property.
//
// This function is agnostic to ownership transfer. Exactly one of `stub` or the return `hook` must
// eventually be disposed.
export function unwrapStubOrParent(stub: RpcStub): StubHook {
  return stub[RAW_STUB].hook;
}

// Given a stub (still wrapped in a Proxy), extract the `hook` and `pathIfPromise` properties.
//
// This function is agnostic to ownership transfer. Exactly one of `stub` or the return `hook` must
// eventually be disposed.
export function unwrapStubAndPath(stub: RpcStub): {hook: StubHook, pathIfPromise?: PropertyPath} {
  return stub[RAW_STUB];
}

// Given a promise stub (still wrapped in a Proxy), pull the remote promise and deliver the
// payload. This is a helper used to implement the then/catch/finally methods of RpcPromise.
async function pullPromise(promise: RpcPromise): Promise<unknown> {
  let {hook, pathIfPromise} = promise[RAW_STUB];
  if (pathIfPromise!.length > 0) {
    // If this isn't the root promise, we have to clone it and pull the clone. This is a little
    // weird in terms of disposal: There's no way for the app to dispose/cancel the promise while
    // waiting because it never actually got a direct disposable reference. It has to dispose
    // the result.
    hook = hook.get(pathIfPromise!);
  }
  let payload = await hook.pull();
  return payload.deliverResolve();
}

// =======================================================================================
// RpcPayload

export type LocatedPromise = {parent: object, property: string | number, promise: RpcPromise};

// Represents the params to an RPC call, or the resolution of an RPC promise, as it passes
// through the system.
//
// `RpcPayload` is a linear type -- it is passed to or returned from a call, ownership is being
// transferred. The payload in turn owns all the stubs within it. Disposing the payload disposes
// the stubs.
//
// Hypothetically, when an `RpcPayload` is first constructed from a message structure passed from
// the app, it ought to be deep-copied, for a few reasons:
// - To ensure subsequent modifications of the data structure by the app aren't reflected in the
//   already-sent message.
// - To find all stubs in the message tree, to take ownership of them.
// - To find all RpcTargets in the message tree, to wrap them in stubs.
//
// However, most payloads are immediately serialized to send across the wire. Said serialization
// *also* has to make a deep copy, and takes ownership of all stubs found within. In the case that
// the payload is immediately serialized, then making a deep copy first is wasteful.
//
// So, as an optimization, RpcPayload does not necessarily make a copy right away. Instead, it
// keeps track of whether it's still pointing at the message structure received directly from the
// app. In that case, the serializer can operate on the original structure directly, making it
// more efficient.
//
// On the receiving end, when an RpcPayload is deserialized from the wire, the payload can safely
// be delivered directly to the app without a copy. However, if the app makes a loopback call to
// itself, the payload may never cross the wire. In this case, a deep copy must be made before
// delivering the final message to the app. There are really two reasons for this copy:
// - We obviously don't want the caller and callee sharing in-memory mutable data structures, as
//   this would lead to vasty different behavior than what you'd see when doing RPC across a
//   network connection.
// - Before delivering the message to the application, all promises embedded in the message must
//   be resolved. This is what makes pipelining possible: the sender of a message can place
//   `RpcPromise`s in it that refer back to values in the recipient's process. These will be filled
//   in just before delivering the message to the recipient, so that there's no need to transmit
//   these values back and forth across the wire. It would be unreasonable to expect the
//   application itself to check the message for promises and resolve them all, so instead the
//   system automatically resolves all promises upfront, replacing them with their resolutions.
//   This modifies the payload in-place -- but this of course requires that the payload is
//   operating on a copy of the message, not the original provided from the sending app.
//
// For both the purposes of disposal and substituting promises with their resolutions, it is
// necessary at some point to make a list of all the stubs (including promise stubs) present in
// the message. Again, `RpcPayload` tries to minimize the number of times that the whole message
// needs to be walked, so it implements the following policy:
// * When constructing a payload from an app-provided message object, the message is not walked
//   upfront. We do not know yet what stubs it contains.
// * When deserializing a payload from the wire, we build a list of stubs as part of the
//   deserialization process.
// * If we need to deep-copy an app-provided message, we make a list of stubs then.
// * Hence, we have a list of stubs if and only if the message structure was NOT provided directly
//   by the application.
// * If an app-provided payload is serialized, the serializer finds the stubs. (It also typically
//   takes ownership of the stubs, effectively consuming the payload, so there's no need to build
//   a list of the stubs.)
// * If an app-provided payload is disposed, then we have to walk the message at that time to
//   dispose all stubs within. But, note that when a payload is serialized -- with the serializer
//   taking ownership of stubs -- then the payload will NOT be disposed explicitly, so this step
//   will not be needed.
export class RpcPayload {
  // Create a payload from a value passed as params to an RPC from the app.
  //
  // The payload does NOT take ownership of any stubs in `value`, and but promises not to modify
  // `value`. If the payload is delivered locally, `value` will be deep-copied first, so as not
  // to have the sender and recipient end up sharing the same mutable object. `value` will not be
  // touched again after the call returns synchronously (returns a promise) -- by that point,
  // the value has either been copied or serialized to the wire.
  public static fromAppParams(value: unknown): RpcPayload {
    return new RpcPayload(value, "params");
  }

  // Create a payload from a value return from an RPC implementation by the app.
  //
  // Unlike fromAppParams(), in this case the payload takes ownership of all stubs in `value`, and
  // may hold onto `value` for an arbitrarily long time (e.g. to serve pipelined requests). It
  // will still avoid modifying `value` and will make a deep copy if it is delivered locally.
  public static fromAppReturn(value: unknown): RpcPayload {
    return new RpcPayload(value, "return");
  }

  // Combine an array of payloads into a single payload whose value is an array. Ownership of all
  // stubs is transferred from the inputs to the outputs, hence if the output is disposed, the
  // inputs should not be. (In case of exception, nothing is disposed, though.)
  public static fromArray(array: RpcPayload[]): RpcPayload {
    let stubs: RpcStub[] = [];
    let promises: LocatedPromise[] = [];

    let resultArray: unknown[] = [];

    for (let payload of array) {
      payload.ensureDeepCopied();
      for (let stub of payload.stubs!) {
        stubs.push(stub);
      }
      for (let promise of payload.promises!) {
        if (promise.parent === payload) {
          // This promise is the root of the source payload. We need to reparent it to its proper
          // location in the result array.
          promise = {
            parent: resultArray,
            property: resultArray.length,
            promise: promise.promise
          };
        }
        promises.push(promise);
      }
      resultArray.push(payload.value);
    }

    return new RpcPayload(resultArray, "owned", stubs, promises);
  }

  // Create a payload from a value parsed off the wire using Evaluator.evaluate().
  //
  // A payload is constructed with a null value and the given stubs and promises arrays. The value
  // is expected to be filled in by the evaluator, and the stubs and promises arrays are expected
  // to be extended with stubs found during parsing. (This weird usage model is necessary so that
  // if the root value turns out to be a promise, its `parent` in `promises` can be the payload
  // object itself.)
  //
  // When done, the payload takes ownership of the final value and all the stubs within. It may
  // modify the value in preparation for delivery, and may deliver the value directly to the app
  // without copying.
  public static forEvaluate(stubs: RpcStub[], promises: LocatedPromise[]) {
    return new RpcPayload(null, "owned", stubs, promises);
  }

  // Deep-copy the given value, including dup()ing all stubs.
  //
  // If `value` is a function, it should be bound to `oldParent` as its `this`.
  //
  // If deep-copying from a branch of some other RpcPayload, it must be provided, to make sure
  // RpcTargets found within don't get duplicate stubs.
  public static deepCopyFrom(
      value: unknown, oldParent: object | undefined, owner: RpcPayload | null): RpcPayload {
    let result = new RpcPayload(null, "owned", [], []);
    result.value = result.deepCopy(value, oldParent, "value", result, /*dupStubs=*/true, owner);
    return result;
  }

  // Private constructor; use factory functions above to construct.
  private constructor(
    // The payload value.
    public value: unknown,

    // What is the provenance of `value`?
    // "params": It came from the app, in params to a call. We must dupe any stubs within.
    // "return": It came from the app, returned from a call. We take ownership of all stubs within.
    // "owned": This value belongs fully to us, either because it was deserialized from the wire
    //   or because we deep-copied a value from the app.
    private source: "params" | "return" | "owned",

    // `stubs` and `promises` are filled in only if `value` belongs to us (`source` is "owned") and
    // so can safely be delivered to the app. If `value` came from then app in the first place,
    // then it cannot be delivered back to the app nor modified by us without first deep-copying
    // it. `stubs` and `promises` will be computed as part of the deep-copy.

    // All non-promise stubs found in `value`. Provided so that they can easily be disposed.
    private stubs?: RpcStub[],

    // All promises found in `value`. The locations of each promise are provided to allow
    // substitutions later.
    private promises?: LocatedPromise[]
  ) {}

  // For `source === "return"` payloads only, this tracks any StubHooks created around RpcTargets
  // found in the payload at the time that it is serialized (or deep-copied) for return, so that we
  // can make sure they are not disposed before the pipeline ends.
  //
  // This is initialized on first use.
  private rpcTargets?: Map<RpcTarget | Function, StubHook>;

  // Get the StubHook representing the given RpcTarget found inside this payload.
  public getHookForRpcTarget(target: RpcTarget | Function, parent: object | undefined,
                             dupStubs: boolean = true): StubHook {
    if (this.source === "params") {
      if (dupStubs) {
        // We aren't supposed to take ownership of stubs appearing in params -- we're supposed to
        // dupe them. But an RpcTarget isn't a stub. If we create a stub around it, the stub takes
        // ownership.
        //
        // Usually, people passing raw RpcTargets into functions actually want the call to take
        // ownership -- that is, they want to have the disposer called later.
        //
        // But, if the RpcTarget happens to implement a `dup()` method, we will go ahead and call
        // that method, and wrap whatever it returns instead. This method wouldn't actually be
        // available over RPC anyway (since calling `dup()` on the client-side stub just dupes the
        // stub), so if an `RpcTarget` implements this, it must intend for us to use it.
        //
        // This is particularly important for the case of workerd-native RpcStubs, that is, stubs
        // from the built-in RPC system, rather than the pure-JS implementation of Cap'n Web.
        // We treat those stubs as RpcTargets. But, we do need to dup() them, just like we would
        // our own stubs.

        let dupable = target as any;
        if (typeof dupable.dup === "function") {
          target = dupable.dup();
        }
      }

      return TargetStubHook.create(target, parent);
    } else if (this.source === "return") {
      // If dupStubs is true, we want to both make sure the map contains the stub, and also return
      // a dup of that stub.
      //
      // If dupStubs is false, then we are being called as part of ensureDeepCopy(), i.e. replacing
      // ourselves with a deep copy. In this case we actually want the copy to end up owning all
      // the hooks, and the map to be left empty. So what we do in this case is:
      // * If the target is not in the map, we just create it, but don't populate the map.
      // * If the target *is* in the map, we *remove* the hook from the map, and return it.

      let hook = this.rpcTargets?.get(target);
      if (hook) {
        if (dupStubs) {
          return hook.dup();
        } else {
          this.rpcTargets?.delete(target);
          return hook;
        }
      } else {
        hook = TargetStubHook.create(target, parent);
        if (dupStubs) {
          if (!this.rpcTargets) {
            this.rpcTargets = new Map;
          }
          this.rpcTargets.set(target, hook);
          return hook.dup();
        } else {
          return hook;
        }
      }
    } else {
      throw new Error("owned payload shouldn't contain raw RpcTargets");
    }
  }

  private deepCopy(
      value: unknown, oldParent: object | undefined, property: string | number, parent: object,
      dupStubs: boolean, owner: RpcPayload | null): unknown {
    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported":
        // This will throw later on when someone tries to do something with it.
        return value;

      case "primitive":
      case "bigint":
      case "date":
      case "bytes":
      case "error":
      case "undefined":
        // immutable, no need to copy
        // TODO: Should errors be copied if they have own properties?
        return value;

      case "array": {
        // We have to construct the new array first, then fill it in, so we can pass it as the
        // parent.
        let array = <Array<unknown>>value;
        let len = array.length;
        let result = new Array(len);
        for (let i = 0; i < len; i++) {
          result[i] = this.deepCopy(array[i], array, i, result, dupStubs, owner);
        }
        return result;
      }

      case "object": {
        // Plain object. Unfortunately there's no way to pre-allocate the right shape.
        let result: Record<string, unknown> = {};
        let object = <Record<string, unknown>>value;
        for (let i in object) {
          result[i] = this.deepCopy(object[i], object, i, result, dupStubs, owner);
        }
        return result;
      }

      case "stub":
      case "rpc-promise": {
        let stub = <RpcStub>value;
        let hook: StubHook;
        if (dupStubs) {
          hook = unwrapStubAndDup(stub);
        } else {
          hook = unwrapStubTakingOwnership(stub);
        }
        if (stub instanceof RpcPromise) {
          let promise = new RpcPromise(hook, []);
          this.promises!.push({parent, property, promise});
          return promise;
        } else {
          let newStub = new RpcStub(hook);
          this.stubs!.push(newStub);
          return newStub;
        }
      }

      case "function":
      case "rpc-target": {
        let target = <RpcTarget | Function>value;
        let stub: RpcStub;
        if (owner) {
          stub = new RpcStub(owner.getHookForRpcTarget(target, oldParent, dupStubs));
        } else {
          stub = new RpcStub(TargetStubHook.create(target, oldParent));
        }
        this.stubs!.push(stub);
        return stub;
      }

      case "rpc-thenable": {
        let target = <RpcTarget>value;
        let promise: RpcPromise;
        if (owner) {
          promise = new RpcPromise(owner.getHookForRpcTarget(target, oldParent, dupStubs), []);
        } else {
          promise = new RpcPromise(TargetStubHook.create(target, oldParent), []);
        }
        this.promises!.push({parent, property, promise});
        return promise;
      }

      default:
        kind satisfies never;
        throw new Error("unreachable");
    }
  }

  // Ensures that if the value originally came from an unowned source, we have replaced it with a
  // deep copy.
  public ensureDeepCopied() {
    if (this.source !== "owned") {
      // If we came from call params, we need to dupe any stubs. Otherwise (we came from a return),
      // we take ownership of all stubs.
      let dupStubs = this.source === "params";

      this.stubs = [];
      this.promises = [];

      // Deep-copy the value.
      try {
        this.value = this.deepCopy(this.value, undefined, "value", this, dupStubs, this);
      } catch (err) {
        // Roll back the change.
        this.stubs = undefined;
        this.promises = undefined;
        throw err;
      }

      // We now own the value.
      this.source = "owned";

      // `rpcTargets` should have been left empty. We can throw it out.
      if (this.rpcTargets && this.rpcTargets.size > 0) {
        throw new Error("Not all rpcTargets were accounted for in deep-copy?");
      }
      this.rpcTargets = undefined;
    }
  }

  // Resolve all promises in this payload and then assign the final value into `parent[property]`.
  private deliverTo(parent: object, property: string | number, promises: Promise<any>[]): void {
    this.ensureDeepCopied();

    if (this.value instanceof RpcPromise) {
      RpcPayload.deliverRpcPromiseTo(this.value, parent, property, promises);
    } else {
      (<any>parent)[property] = this.value;

      for (let record of this.promises!) {
        // Note that because we already did ensureDeepCopied(), replacing each promise with its
        // resolution does not interfere with disposal later on -- disposal will be based on the
        // `promises` list, so will still properly dispose each promise, which in turn disposes
        // the promise's eventual payload.
        RpcPayload.deliverRpcPromiseTo(record.promise, record.parent, record.property, promises);
      }
    }
  }

  private static deliverRpcPromiseTo(
      promise: RpcPromise, parent: object, property: string | number,
      promises: Promise<unknown>[]) {
    // deepCopy() should have replaced any property stubs with normal promise stubs.
    let hook = unwrapStubNoProperties(promise);
    if (!hook) {
      throw new Error("property promises should have been resolved earlier");
    }

    let inner = hook.pull();
    if (inner instanceof RpcPayload) {
      // Immediately resolved to payload.
      inner.deliverTo(parent, property, promises);
    } else {
      // It's a promise.
      promises.push(inner.then(payload => {
        let subPromises: Promise<unknown>[] = [];
        payload.deliverTo(parent, property, subPromises);
        if (subPromises.length > 0) {
          return Promise.all(subPromises);
        }
      }));
    }
  }

  // Call the given function with the payload as an argument. The call is made synchronously if
  // possible, in order to maintain e-order. However, if any RpcPromises exist in the payload,
  // they are awaited and substituted before calling the function. The result of the call is
  // wrapped into another payload.
  //
  // The payload is automatically disposed after the call completes. The caller should not call
  // dispose().
  public async deliverCall(func: Function, thisArg: object | undefined): Promise<RpcPayload> {
    try {
      let promises: Promise<void>[] = [];
      this.deliverTo(this, "value", promises);

      // WARNING: It is critical that if the promises list is empty, we do not await anything, so
      //   that the function is called immediately and synchronously. Otherwise, we might violate
      //   e-order.
      if (promises.length > 0) {
        await Promise.all(promises);
      }

      // Call the function.
      let result = Function.prototype.apply.call(func, thisArg, this.value);

      if (result instanceof RpcPromise) {
        // Special case: If the function immediately returns RpcPromise, we don't want to await it,
        // since that will actually wait for the promise. Instead we want to construct a payload
        // around it directly.
        return RpcPayload.fromAppReturn(result);
      } else {
        // In all other cases, await the result (which may or may not be a promise, but `await`
        // will just pass through non-promises).
        return RpcPayload.fromAppReturn(await result);
      }
    } finally {
      this.dispose();
    }
  }

  // Produce a promise for this payload for return to the application. Any RpcPromises in the
  // payload are awaited and substituted with their results first.
  //
  // The returned object will have a disposer which disposes the payload. The caller should not
  // separately dispose it.
  public async deliverResolve(): Promise<unknown> {
    try {
      let promises: Promise<void>[] = [];
      this.deliverTo(this, "value", promises);

      if (promises.length > 0) {
        await Promise.all(promises);
      }

      let result = this.value;

      // Add disposer to result.
      if (result instanceof Object) {
        if (!(Symbol.dispose in result)) {
          // We want the disposer to be non-enumerable as otherwise it gets in the way of things
          // like unit tests trying to deep-compare the result to an object.
          Object.defineProperty(result, Symbol.dispose, {
            // NOTE: Using `this.dispose.bind(this)` here causes Playwright's build of
            //   Chromium 140.0.7339.16 to fail when the object is assigned to a `using` variable,
            //   with the error:
            //       TypeError: Symbol(Symbol.dispose) is not a function
            //   I cannot reproduce this problem in Chrome 140.0.7339.127 nor in Node or workerd,
            //   so maybe it was a short-lived V8 bug or something. To be safe, though, we use
            //   `() => this.dispose()`, which seems to always work.
            value: () => this.dispose(),
            writable: true,
            enumerable: false,
            configurable: true,
          });
        }
      }

      return result;
    } catch (err) {
      // Automatically dispose since the application will never receive the disposable...
      this.dispose();
      throw err;
    }
  }

  public dispose() {
    if (this.source === "owned") {
      // Oh good, we can just run through them.
      this.stubs!.forEach(stub => stub[Symbol.dispose]());
      this.promises!.forEach(promise => promise.promise[Symbol.dispose]());
    } else if (this.source === "return") {
      // Value received directly from app as a return value. We take ownership of all stubs, so we
      // must recursively scan it for things to dispose.
      this.disposeImpl(this.value, undefined);
      if (this.rpcTargets && this.rpcTargets.size > 0) {
        throw new Error("Not all rpcTargets were accounted for in disposeImpl()?");
      }
    } else {
      // this.source is "params". We don't own the stubs within.
    }

    // Make dispose() idempotent.
    this.source = "owned";
    this.stubs = [];
    this.promises = [];
  }

  // Recursive dispose, called only when `source` is "return".
  private disposeImpl(value: unknown, parent: object | undefined) {
    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported":
      case "primitive":
      case "bigint":
      case "bytes":
      case "date":
      case "error":
      case "undefined":
        return;

      case "array": {
        let array = <Array<unknown>>value;
        let len = array.length;
        for (let i = 0; i < len; i++) {
          this.disposeImpl(array[i], array);
        }
        return;
      }

      case "object": {
        let object = <Record<string, unknown>>value;
        for (let i in object) {
          this.disposeImpl(object[i], object);
        }
        return;
      }

      case "stub":
      case "rpc-promise": {
        let stub = <RpcStub>value;
        let hook = unwrapStubNoProperties(stub);
        if (hook) {
          hook.dispose();
        }
        return;
      }

      case "function":
      case "rpc-target": {
        let target = <RpcTarget | Function>value;
        let hook = this.rpcTargets?.get(target);
        if (hook) {
          // We created a hook around this target earlier. Dispose it now.
          hook.dispose();
          this.rpcTargets!.delete(target);
        } else {
          // There never was a stub pointing at this target. This could be because:
          // * The call was used only for promise pipelining, so the result was never serialized,
          //   so it never got added to `rpcTargets`.
          // * The same RpcTarget appears in the results twice, and we already disposed the hook
          //   when we saw it earlier. Note that it's intentional that we should call the disposer
          //   twice if the same object appears twice.
          disposeRpcTarget(target);
        }
        return;
      }

      case "rpc-thenable":
        // Since thenables are promises, we don't own them, so we don't dispose them.
        return;

      default:
        kind satisfies never;
        return;
    }
  }

  // Ignore unhandled rejections in all promises in this payload -- that is, all promises that
  // *would* be awaited if this payload were to be delivered. See the similarly-named method of
  // StubHook for explanation.
  ignoreUnhandledRejections(): void {
    if (this.stubs) {
      // Propagate to all stubs and promises.
      this.stubs.forEach(stub => {
        unwrapStubOrParent(stub).ignoreUnhandledRejections();
      });
      this.promises!.forEach(
          promise => unwrapStubOrParent(promise.promise).ignoreUnhandledRejections());
    } else {
      // Ugh we have to walk the tree.
      this.ignoreUnhandledRejectionsImpl(this.value);
    }
  }

  private ignoreUnhandledRejectionsImpl(value: unknown) {
    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported":
      case "primitive":
      case "bigint":
      case "bytes":
      case "date":
      case "error":
      case "undefined":
      case "function":
      case "rpc-target":
        return;

      case "array": {
        let array = <Array<unknown>>value;
        let len = array.length;
        for (let i = 0; i < len; i++) {
          this.ignoreUnhandledRejectionsImpl(array[i]);
        }
        return;
      }

      case "object": {
        let object = <Record<string, unknown>>value;
        for (let i in object) {
          this.ignoreUnhandledRejectionsImpl(object[i]);
        }
        return;
      }

      case "stub":
      case "rpc-promise":
        unwrapStubOrParent(<RpcStub>value).ignoreUnhandledRejections();
        return;

      case "rpc-thenable":
        (<any>value).then((_: any) => {}, (_: any) => {});
        return;

      default:
        kind satisfies never;
        return;
    }
  }
};

// =======================================================================================
// Local StubHook implementations

// Result of followPath().
type FollowPathResult = {
  // Path led to a regular value.

  value: unknown,              // the value
  parent: object | undefined,  // the immediate parent (useful as `this` if making a call)
  owner: RpcPayload | null,    // RpcPayload that owns the value, if any

  hook?: never,
  remainingPath?: never,
} | {
  // Path leads into another stub, which needs to be called recursively.

  hook: StubHook,               // StubHook of the inner stub.
  remainingPath: PropertyPath,  // Path to pass to `hook` when recursing.

  value?: never,
  parent?: never,
  owner?: never,
};

function followPath(value: unknown, parent: object | undefined,
                    path: PropertyPath, owner: RpcPayload | null): FollowPathResult {
  for (let i = 0; i < path.length; i++) {
    parent = <object>value;

    let part = path[i];
    if (part in Object.prototype) {
      // Don't allow messing with Object.prototype properties over RPC. We block these even if
      // the specific object has overridden them for consistency with the deserialization code,
      // which will refuse to deserialize an object containing such properties. Anyway, it's
      // impossible for a normal client to even request these because accessing Object prototype
      // properties on a stub will resolve to the local prototype property, not making an RPC at
      // all.
      value = undefined;
      continue;
    }

    let kind = typeForRpc(value);
    switch (kind) {
      case "object":
      case "function":
        // Must be own property, NOT inherited from a prototype.
        if (Object.hasOwn(<object>value, part)) {
          value = (<any>value)[part];
        } else {
          value = undefined;
        }
        break;

      case "array":
        // For arrays, restrict specifically to numeric indexes, to be consistent with
        // serialization, which only sends a flat list.
        if (Number.isInteger(part) && <number>part >= 0) {
          value = (<any>value)[part];
        } else {
          value = undefined;
        }
        break;

      case "rpc-target":
      case "rpc-thenable": {
        // Must be prototype property, and must NOT be inherited from `Object`.
        if (Object.hasOwn(<object>value, part)) {
          // We throw an error in this case, rather than return undefined, because otherwise
          // people tend to get confused about this. If you don't want it to be possible to
          // probe the existence of your instance properties, make them properly private (prefix
          // with #).
          throw new TypeError(
              `Attempted to access property '${part}', which is an instance property of the ` +
              `RpcTarget. To avoid leaking private internals, instance properties cannot be ` +
              `accessed over RPC. If you want to make this property available over RPC, define ` +
              `it as a method or getter on the class, instead of an instance property.`);
        } else {
          value = (<any>value)[part];
        }

        // Since we're descending into the RpcTarget, the rest of the path is not "owned" by any
        // RpcPayload.
        owner = null;
        break;
      }

      case "stub":
      case "rpc-promise": {
        let {hook: hook, pathIfPromise} = unwrapStubAndPath(<RpcStub>value);
        return { hook, remainingPath:
            pathIfPromise ? pathIfPromise.concat(path.slice(i)) : path.slice(i) };
      }

      case "primitive":
      case "bigint":
      case "bytes":
      case "date":
      case "error":
        // These have no properties that can be accessed remotely.
        value = undefined;
        break;

      case "undefined":
        // Intentionally produce TypeError.
        value = (value as any)[part];
        break;

      case "unsupported": {
        if (i === 0) {
          throw new TypeError(`RPC stub points at a non-serializable type.`);
        } else {
          let prefix = path.slice(0, i).join(".");
          let remainder = path.slice(0, i).join(".");
          throw new TypeError(
              `'${prefix}' is not a serializable type, so property ${remainder} cannot ` +
              `be accessed.`);
        }
      }

      default:
        kind satisfies never;
        throw new TypeError("unreachable");
    }
  }

  // If we reached a promise, we actually want the caller to forward to the promise, not return
  // the promise itself.
  if (value instanceof RpcPromise) {
    let {hook: hook, pathIfPromise} = unwrapStubAndPath(<RpcStub>value);
    return { hook, remainingPath: pathIfPromise || [] };
  }

  // We don't validate the final value itself because we don't know the intended use yet. If it's
  // for a call, any callable is valid. If it's for get(), then any serializable value is valid.
  return {
    value,
    parent,
    owner,
  };
}

// Shared base class for PayloadStubHook and TargetStubHook.
abstract class ValueStubHook extends StubHook {
  protected abstract getValue(): {value: unknown, owner: RpcPayload | null};

  call(path: PropertyPath, args: RpcPayload): StubHook {
    try {
      let {value, owner} = this.getValue();
      let followResult = followPath(value, undefined, path, owner);

      if (followResult.hook) {
        return followResult.hook.call(followResult.remainingPath, args);
      }

      // It's a local function.
      if (typeof followResult.value != "function") {
        throw new TypeError(`'${path.join('.')}' is not a function.`);
      }
      let promise = args.deliverCall(followResult.value, followResult.parent);
      return new PromiseStubHook(promise.then(payload => {
        return new PayloadStubHook(payload);
      }));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }

  map(path: PropertyPath, captures: StubHook[], instructions: unknown[]): StubHook {
    try {
      let followResult: FollowPathResult;
      try {
        let {value, owner} = this.getValue();
        followResult = followPath(value, undefined, path, owner);;
      } catch (err) {
        // Oops, we need to dispose the captures of which we took ownership.
        for (let cap of captures) {
          cap.dispose();
        }
        throw err;
      }

      if (followResult.hook) {
        return followResult.hook.map(followResult.remainingPath, captures, instructions);
      }

      return mapImpl.applyMap(
          followResult.value, followResult.parent, followResult.owner, captures, instructions);
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }

  get(path: PropertyPath): StubHook {
    try {
      let {value, owner} = this.getValue();

      if (path.length === 0 && owner === null) {
        // The only way this happens is if someone sends "pipeline" and references a
        // TargetStubHook, but they shouldn't do that, because TargetStubHook never backs a
        // promise, and a non-promise cannot be converted to a promise.
        // TODO: Is this still correct for rpc-thenable?
        throw new Error("Can't dup an RpcTarget stub as a promise.");
      }

      let followResult = followPath(value, undefined, path, owner);

      if (followResult.hook) {
        return followResult.hook.get(followResult.remainingPath);
      }

      // Note that if `followResult.owner` is null, then we've descended into the contents of an
      // RpcTarget. In that case, if this deep copy discovers an RpcTarget embedded in the result,
      // it will create a new stub for it. If that RpcTarget has a disposer, it'll be disposed when
      // that stub is disposed. If the same RpcTarget is returned in *another* get(), it create
      // *another* stub, which calls the disposer *another* time. This can be quite weird -- the
      // disposer may be called any number of times, including zero if the property is never read
      // at all. Unfortunately, that's just the way it is. The application can avoid this problem by
      // wrapping the RpcTarget in an RpcStub itself, proactively, and using that as the property --
      // then, each time the property is get()ed, a dup() of that stub is returned.
      return new PayloadStubHook(RpcPayload.deepCopyFrom(
          followResult.value, followResult.parent, followResult.owner));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }
}

// StubHook wrapping an RpcPayload in local memory.
//
// This is used for:
// - Resolution of a promise.
//   - Initially on the server side, where it can be pull()ed and used in pipelining.
//   - On the client side, after pull() has transmitted the payload.
// - Implementing RpcTargets, on the server side.
//   - Since the payload's root is an RpcTarget, pull()ing it will just duplicate the stub.
export class PayloadStubHook extends ValueStubHook {
  constructor(payload: RpcPayload) {
    super();
    this.payload = payload;
  }

  private payload?: RpcPayload;  // cleared when disposed

  private getPayload(): RpcPayload {
    if (this.payload) {
      return this.payload;
    } else {
      throw new Error("Attempted to use an RPC StubHook after it was disposed.");
    }
  }

  protected getValue() {
    let payload = this.getPayload();
    return {value: payload.value, owner: payload};
  }

  dup(): StubHook {
    // Although dup() is documented as not copying the payload, what this really means is that
    // you aren't expected to be able to pull() from a dup()ed hook if it is remote. However,
    // PayloadStubHook already has the value locally, and there's nothing we can do except clone
    // it here.
    //
    // TODO: Should we prohibit pull()ing from the clone? The fact that it'll be wrapped as
    //   RpcStub instead of RpcPromise should already prevent this...
    let thisPayload = this.getPayload();
    return new PayloadStubHook(RpcPayload.deepCopyFrom(
        thisPayload.value, undefined, thisPayload));
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    // Reminder: pull() intentionally returns the hook's own payload and not a clone. The caller
    // only needs to dispose one of the hook or the payload. It is the caller's responsibility
    // to not dispose the payload if they intend to keep the hook around.
    return this.getPayload();
  }

  ignoreUnhandledRejections(): void {
    if (this.payload) {
      this.payload.ignoreUnhandledRejections();
    }
  }

  dispose(): void {
    if (this.payload) {
      this.payload.dispose();
      this.payload = undefined;
    }
  }

  onBroken(callback: (error: any) => void): void {
    if (this.payload) {
      if (this.payload.value instanceof RpcStub) {
        // Payload is a single stub, we should forward onRpcBroken to it.
        // TODO: Consider prohibiting PayloadStubHook created around a single stub; should always
        //   use the underlying stub's hook instead?
        this.payload.value.onRpcBroken(callback);
      }

      // TODO: Should native stubs be able to implement onRpcBroken?
    }
  }
}

function disposeRpcTarget(target: RpcTarget | Function) {
  if (Symbol.dispose in target) {
    try {
      ((<Disposable><any>target)[Symbol.dispose])();
    } catch (err) {
      // We don't actually want to throw from dispose() as this will create trouble for
      // the RPC state machine. Instead, treat the application's error as an unhandled
      // rejection.
      Promise.reject(err);
    }
  }
}

// Many TargetStubHooks could point at the same RpcTarget. We store a refcount in a separate
// object that they all share.
//
// We can't store the refcount on the RpcTarget itself because if the application chooses to pass
// the same RpcTarget into the RPC system multiple times, we need to call this disposer multiple
// times for consistency.
type BoxedRefcount = { count: number };

// StubHook which wraps an RpcTarget. This has similarities to PayloadStubHook (especially when
// the root of the payload happens to be an RpcTarget), but there can only be one RpcPayload
// pointing at an RpcTarget whereas there can be several TargetStubHooks pointing at it. Also,
// TargetStubHook cannot be pull()ed, because it always backs an RpcStub, not an RpcPromise.
class TargetStubHook extends ValueStubHook {
  // Constructs a TargetStubHook that is not duplicated from an existing hook.
  //
  // If `value` is a function, `parent` is bound as its "this".
  static create(value: RpcTarget | Function, parent: object | undefined) {
    if (typeof value !== "function") {
      // If the target isn't callable, we don't need to pass a `this` to it, so drop `parent`.
      // NOTE: `typeof value === "function"` checks if the value is callable. This technically
      //   works even for `RpcTarget` implementations that are callable, not just plain functions.
      parent = undefined;
    }
    return new TargetStubHook(value, parent);
  }

  private constructor(target: RpcTarget | Function,
                      parent?: object | undefined,
                      dupFrom?: TargetStubHook) {
    super();
    this.target = target;
    this.parent = parent;
    if (dupFrom) {
      if (dupFrom.refcount) {
        this.refcount = dupFrom.refcount;
        ++this.refcount.count;
      }
    } else if (Symbol.dispose in target) {
      // Disposer present, so we need to refcount.
      this.refcount = {count: 1};
    }
  }

  private target?: RpcTarget | Function;  // cleared when disposed
  private parent?: object | undefined;  // `this` parameter when calling `target`
  private refcount?: BoxedRefcount;  // undefined if not needed (because target has no disposer)

  private getTarget(): RpcTarget | Function {
    if (this.target) {
      return this.target;
    } else {
      throw new Error("Attempted to use an RPC StubHook after it was disposed.");
    }
  }

  protected getValue() {
    return {value: this.getTarget(), owner: null};
  }

  dup(): StubHook {
    return new TargetStubHook(this.getTarget(), this.parent, this);
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    let target = this.getTarget();
    if ("then" in target) {
      // If the target is itself thenable, we allow it to be treated as a promise. This is used
      // in particular to support wrapping a workerd-native RpcPromise or RpcProperty.
      return Promise.resolve(target).then(resolution => {
        return RpcPayload.fromAppReturn(resolution);
      });
    } else {
      // This shouldn't be called since RpcTarget always becomes RpcStub, not RpcPromise, and you
      // can only pull a promise.
      return Promise.reject(new Error("Tried to resolve a non-promise stub."));
    }
  }

  ignoreUnhandledRejections(): void {
    // Nothing to do.
  }

  dispose(): void {
    if (this.target) {
      if (this.refcount) {
        if (--this.refcount.count == 0) {
          disposeRpcTarget(this.target);
        }
      }

      this.target = undefined;
    }
  }

  onBroken(callback: (error: any) => void): void {
    // TODO: Should RpcTargets be able to implement onRpcBroken?
  }
}

// StubHook derived from a Promise for some other StubHook. Waits for the promise and then
// forward calls, being careful to honor e-order.
class PromiseStubHook extends StubHook {
  private promise: Promise<StubHook>;
  private resolution: StubHook | undefined;

  constructor(promise: Promise<StubHook>) {
    super();

    this.promise = promise.then(res => { this.resolution = res; return res; });
  }

  call(path: PropertyPath, args: RpcPayload): StubHook {
    // Note: We can't use `resolution` even if it's available because it could technically break
    //   e-order: A call() that arrives just after the resolution could be delivered faster than
    //   a call() that arrives just before. Keeping the promise around and always waiting on it
    //   avoids the problem.
    // TODO: Is there a way around this?

    // Once call() returns (synchronously), we can no longer touch the original args. Since we
    // can't serialize them yet, we have to deep-copy them now.
    args.ensureDeepCopied();

    return new PromiseStubHook(this.promise.then(hook => hook.call(path, args)));
  }

  map(path: PropertyPath, captures: StubHook[], instructions: unknown[]): StubHook {
    return new PromiseStubHook(this.promise.then(
        hook => hook.map(path, captures, instructions),
        err => {
          for (let cap of captures) {
            cap.dispose();
          }
          throw err;
        }));
  }

  get(path: PropertyPath): StubHook {
    // Note: e-order matters for get(), just like call(), in case the property has a getter.
    return new PromiseStubHook(this.promise.then(hook => hook.get(path)));
  }

  dup(): StubHook {
    if (this.resolution) {
      return this.resolution.dup();
    } else {
      return new PromiseStubHook(this.promise.then(hook => hook.dup()));
    }
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    // Luckily, resolutions are not subject to e-order, so it's safe to use `this.resolution`
    // here. In fact, it is required to maintain e-order elsewhere: If this promise is being used
    // as the input to some other local call (via promise pipelining), we need to make sure that
    // other call is not delayed at all when this promise is already resolved.
    if (this.resolution) {
      return this.resolution.pull();
    } else {
      return this.promise.then(hook => hook.pull());
    }
  }

  ignoreUnhandledRejections(): void {
    if (this.resolution) {
      this.resolution.ignoreUnhandledRejections();
    } else {
      this.promise.then(res => {
        res.ignoreUnhandledRejections();
      }, err => {
        // Ignore the error!
      });
    }
  }

  dispose(): void {
    if (this.resolution) {
      this.resolution.dispose();
    } else {
      this.promise.then(hook => {
        hook.dispose();
      }, err => {
        // nothing to dispose
      });
    }
  }

  onBroken(callback: (error: any) => void): void {
    if (this.resolution) {
      this.resolution.onBroken(callback);
    } else {
      this.promise.then(hook => {
        hook.onBroken(callback);
      }, callback);
    }
  }
}
