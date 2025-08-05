import type { RpcTargetBranded, __RPC_TARGET_BRAND } from "./types.js";

export interface RpcTarget {
  [__RPC_TARGET_BRAND]: never;
}

abstract class UserRpcTarget {}

export type PropertyPath = (string | number)[];

type TypeForRpc = "unsupported" | "primitive" | "object" | "function" | "array" | "date" |
    "stub" | "rpc-promise" | "rpc-target" | "error" | "undefined";

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
      return "function";

    case Array.prototype:
      return "array";

    case Date.prototype:
      return "date";

    // TODO: All other structured clone types.

    case RpcStub.prototype:
      return "stub";

    case RpcPromise.prototype:
      return "rpc-promise";

    // TODO: Promise<T> or thenable

    default:
      if (value instanceof RpcTarget) {
        return "rpc-target";
      }

      if (value instanceof Error) {
        return "error";
      }

      if (value.constructor?.name === "Fetcher") {
        return "rpc-target";
      }

      if (value.constructor?.name === "JsRpcStub") {
        return "rpc-target";
      }

      if (value.constructor?.name === "RpcStub") {
        return "rpc-target";
      }

      return "unsupported";
  }
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

  // Attempts to cancel any outstanding promise backing this hook, and disposes the payload that
  // pull() would return (if any). If a pull() promise is outstanding, it may still resolve (with
  // a disposed payload) or it may reject. It's safe to call dispose() multiple times.
  abstract dispose(): void;
}

export class ErrorStubHook extends StubHook {
  constructor(private error: any) { super(); }

  call(path: PropertyPath, args: RpcPayload): StubHook { return this; }
  get(path: PropertyPath): StubHook { return this; }
  dup(): StubHook { return this; }
  pull(): RpcPayload | Promise<RpcPayload> { return Promise.reject(this.error); }
  dispose(): void {}
};

const DISPOSED_HOOK: StubHook = new ErrorStubHook(
    new Error("Attempted to use RPC stub after it has been disposed."));

// Private symbol which may be used to unwrap the real stub through the Proxy.
let RAW_STUB = Symbol("realStub");

export interface RpcStub extends Disposable {
  // Declare magic `RAW_STUB` key that unwraps the proxy.
  [RAW_STUB]: this;
}

const PROXY_HANDLERS: ProxyHandler<{raw: RpcStub}> = {
  apply(target: {raw: RpcStub}, thisArg: any, argumentsList: any[]) {
    let stub = target.raw;
    return new RpcPromise(stub.hook.call(
        stub.pathIfPromise || [], RpcPayload.fromApp(argumentsList)), []);
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
export class RpcStub {
  // Although `hook` and `path` are declared `public` here, they are effectively hidden by the
  // proxy.
  constructor(hook: StubHook, pathIfPromise?: PropertyPath) {
    if (!(hook instanceof StubHook)) {
      // Application invoked the constructor to explicitly construct a stub backed by some value
      // (usually an RpcTarget). (Note we override the types as seen by the app, which is why
      // the app can pass something that isn't a StubHook -- within the implementation, though,
      // we always pass StubHook.)
      let value = <any>hook;
      if (value instanceof RpcTarget || value instanceof Function) {
        hook = TargetStubHook.create(value, undefined);
      } else {
        hook = new PayloadStubHook(RpcPayload.fromApp(value));
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
}

// Given a stub (still wrapped in a Proxy), extract the `hook` and `pathIfPromise` properties.
export function unwrapStub(stub: RpcStub): {hook: StubHook, pathIfPromise?: PropertyPath} {
  return stub[RAW_STUB];
}

// Given a promise stub (still wrapped in a Proxy), pull the remote promise and deliver the
// payload. This is a helper used to implement the then/catch/finally methods of RpcPromise.
async function pullPromise(promise: RpcPromise): Promise<unknown> {
  let {hook, pathIfPromise} = unwrapStub(promise);
  if (pathIfPromise!.length > 0) {
    // If this isn't the root promise, we have to clone it and pull the clone. This is a little
    // weird in terms of disposal: There's no way for the app to dispose/cancel the promise while
    // waiting becaues it never actually got a direct disposable reference. It has to dispose
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
  // Create a payload from a value provided by the app.
  //
  // The payload takes ownership of all stubs in `value`, but promises not to modify `value`
  // itself. If the payload is delivered locally, `value` will be deep-copied first, so as not
  // to have the sender and recipient end up sharing the same mutable object.
  public static fromApp(value: unknown) {
    return new RpcPayload(value);
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
    return new RpcPayload(null, stubs, promises);
  }

  // Deep-copy the given value, including dup()ing all stubs.
  //
  // If `value` is a function, it should be bound to `oldParent` as its `this`.
  //
  // If deep-copying from a branch of some other RpcPayload, it must be provided, to make sure
  // RpcTargets found within don't get duplicate stubs.
  public static deepCopyFrom(
      value: unknown, oldParent: object | undefined, owner: RpcPayload | null): RpcPayload {
    let result = new RpcPayload(null);
    result.stubs = [];
    result.promises = [];
    result.value = result.deepCopy(value, oldParent, "value", result, /*dupStubs=*/true, owner);
    return result;
  }

  // Private constructor; use factory functions above to construct.
  private constructor(
    // The payload value.
    public value: unknown,

    // `stubs` and `promises` are filled in only if `value` belongs to us and can safely be
    // delivered to the app. If `value` came from thne app in the first place, then it cannot
    // be delivered back to the app nor modified by us without first deep-copying it. `stubs` and
    // `promises` will be computed as part of the deep-copy.

    // All non-promise stubs found in `value`. Provided so that they can easily be disposed.
    private stubs?: RpcStub[],

    // All promises found in `value`. The locations of each promise are provided to allow
    // substitutions later.
    private promises?: LocatedPromise[]
  ) {}

  // Map of StubHooks that have been constructed around RpcTargets in this payload. It's important
  // that each target only has a new hook created once, and any further hooks needed are dup()ed
  // from that one, so that we can make sure the RpcTarget's disposer is invoked only once.
  //
  // In practice this map is populated when either making a deep copy or serializing the payload.
  //
  // This map is only needed when `value` originates directly from the app -- because otherwise,
  // `value` can't possibly contain any `RpcTarget`s (they would have been turned into stubs
  // earlier).
  //
  // This is initialized on first use.
  private rpcTargets?: Map<RpcTarget | Function, StubHook>;

  public isFromApp(): boolean {
    return !this.stubs;
  }

  // Get the StubHook representing the given RpcTarget found inside this payload.
  public getHookForRpcTarget(target: RpcTarget | Function, parent: object | undefined): StubHook {
    if (!this.rpcTargets) this.rpcTargets = new Map;

    let hook = this.rpcTargets.get(target);
    if (!hook) {
      hook = TargetStubHook.create(target, parent);
      this.rpcTargets.set(target, hook);
    }

    return hook;
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
      case "date":
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
        let {hook, pathIfPromise} = unwrapStub(stub);
        if (pathIfPromise) {
          // This is a promise. We do not take ownership of promises from the app, only stubs.
          // Instead, we can use `get()` to make a copy of the promise, which we then own. We
          // might as well get() the specific path while we're at it.
          stub = new RpcPromise(hook.get(pathIfPromise), []);
        } else if (dupStubs) {
          stub = stub.dup();
        }
        if (stub instanceof RpcPromise) {
          this.promises!.push({parent, property, promise: stub});
        } else {
          this.stubs!.push(stub);
        }
        return stub;
      }

      case "function":
      case "rpc-target": {
        let target = <RpcTarget | Function>value;
        if (owner) {
          return new RpcStub(owner.getHookForRpcTarget(target, oldParent).dup());
        } else {
          return new RpcStub(TargetStubHook.create(target, oldParent));
        }
      }

      default:
        kind satisfies never;
        throw new Error("unreachable");
    }
  }

  // Ensures that if the value originally came from an unowned source, we
  private ensureDeepCopied() {
    if (this.stubs === undefined) {
      this.stubs = [];
      this.promises = [];

      // Deep-copy the value, but not the stubs.
      this.value = this.deepCopy(this.value, undefined, "value", this, /*dupStubs=*/false, this);

      // We can throw away `rpcTargets` as the deep-copied value contains the stubs now.
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
    let {hook, pathIfPromise} = unwrapStub(promise);
    if (pathIfPromise && pathIfPromise.length > 0) {
      // deepCopy() should have eliminated this.
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
        return RpcPayload.fromApp(result);
      } else {
        // In all other cases, await the result (which may or may not be a promise, but `await`
        // will just pass through non-promises).
        return RpcPayload.fromApp(await result);
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
          (<Disposable>result)[Symbol.dispose] = () => this.dispose();
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
    if (this.stubs) {
      // Oh good, we can just run through them.
      this.stubs.forEach(stub => stub[Symbol.dispose]());
      this.promises!.forEach(promise => promise.promise[Symbol.dispose]());
    } else {
      // Value received directly from app, must recursively scan it for things to dispose.
      this.disposeImpl(this.value, undefined);
    }

    // Make dispose() idempotent.
    this.stubs = [];
    this.promises = [];
  }

  private disposeImpl(value: unknown, parent: object | undefined) {
    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported":
      case "primitive":
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
        let {hook, pathIfPromise} = unwrapStub(stub);
        // We don't own promises, only stubs.
        if (!pathIfPromise) {
          hook.dispose();
        }
        return;
      }

      case "function":
      case "rpc-target": {
        let target = <RpcTarget | Function>value;
        this.getHookForRpcTarget(target, parent).dispose();
        return;
      }

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

function throwPathError(path: PropertyPath, i: number): never {
  if (i === 0) {
    throw new TypeError(`RPC object has no property '${path[i]}'`);
  } else {
    let subPath = path.slice(0, i).join(".");
    throw new TypeError(`'${subPath}' has no property '${path[i]}'`);
  }
}

function followPath(value: unknown, parent: object | undefined,
                    path: PropertyPath, owner: RpcPayload | null): FollowPathResult {
  for (let i = 0; i < path.length; i++) {
    parent = <object>value;

    let part = path[i];
    if (part === "__proto__" || part === "constructor") {
      throwPathError(path, i);
    }

    let kind = typeForRpc(value);
    switch (kind) {
      case "object":
      case "array":
      case "function":
        // Must be own property, NOT inherited from a prototype.
        if (!Object.hasOwn(<object>value, part)) {
          throwPathError(path, i);
        }
        value = (<any>value)[part];
        break;

      case "rpc-target": {
        value = (<any>value)[part];

        if (!value || value === (<any>Object.prototype)[part]) {
          throwPathError(path, i);
        }

        // Since we're descending into the RpcTarget, the rest of the path is not "owned" by any
        // RpcPayload.
        owner = null;
        break;
      }

      case "stub":
      case "rpc-promise": {
        let {hook: hook, pathIfPromise} = unwrapStub(<RpcStub>value);
        return { hook, remainingPath:
            pathIfPromise ? pathIfPromise.concat(path.slice(i)) : path.slice(i) };
      }

      case "primitive":
      case "date":
      case "error":
      case "undefined":
        // These have no properties that can be accessed remotely.
        throwPathError(path, i);

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

  // We don't validate the final value itself because we don't know the intended use yet. If it's
  // for a call, any callable is valid. If it's for get(), then any serializable value is valid.
  return {
    value,
    parent,
    owner,
  };
}

// StubHook wrapping an RpcPayload in local memory.
//
// This is used for:
// - Resolution of a promise.
//   - Initially on the server side, where it can be pull()ed and used in pipelining.
//   - On the client side, after pull() has transmitted the payload.
// - Implementing RpcTargets, on the server side.
//   - Since the payload's root is an RpcTarget, pull()ing it will just duplicate the stub.
export class PayloadStubHook extends StubHook {
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

  call(path: PropertyPath, args: RpcPayload): StubHook {
    try {
      let payload = this.getPayload();
      let followResult = followPath(payload.value, undefined, path, payload);

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

  get(path: PropertyPath): StubHook {
    try {
      let payload = this.getPayload();
      let followResult = followPath(payload.value, undefined, path, payload);

      if (followResult.hook) {
        return followResult.hook.get(followResult.remainingPath);
      }

      return new PayloadStubHook(RpcPayload.deepCopyFrom(
          followResult.value, followResult.parent, followResult.owner));
    } catch (err) {
      return new ErrorStubHook(err);
    }
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

  dispose(): void {
    if (this.payload) {
      this.payload.dispose();
      this.payload = undefined;
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
class TargetStubHook extends StubHook {
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

  call(path: PropertyPath, args: RpcPayload): StubHook {
    try {
      let target = this.getTarget();
      let followResult = followPath(target, this.parent, path, null);

      if (followResult.hook) {
        return followResult.hook.call(followResult.remainingPath, args);
      }

      // It's a local function.
      if (typeof followResult.value != "function") {
        throw new TypeError(`'${path.join('.')}' is not a function.`);
      }
      let promise = args.deliverCall(<Function>followResult.value, followResult.parent);
      return new PromiseStubHook(promise.then(payload => {
        return new PayloadStubHook(payload);
      }));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }

  get(path: PropertyPath): StubHook {
    try {
      if (path.length == 0) {
        // The only way this happens is if someone sends "pipeline" and references a
        // TargetStubHook, but they shouldn't do that, because TargetStubHook never backs a
        // promise, and a non-promise cannot be converted to a promise.
        throw new Error("Can't dup an RpcTarget stub as a promise.");
      }

      let target = this.getTarget();
      let followResult = followPath(target, this.parent, path, null);

      if (followResult.hook) {
        return followResult.hook.get(followResult.remainingPath);
      }

      // Note that this deep copy, if it discovers an RpcTarget embedded in the result, will create
      // a new stub for it. If the RpcTarget has a disposer, it'll be disposed when that stub is
      // disposed. If the same RpcTarget is returned in *another* get(), it create *another* stub,
      // which calls the disposer *another* time. This can be quite weird -- the disposer may be
      // called any number of times, including zero if the property is never read at all.
      // Unfortunately, that's just the way it is. The application can avoid this problem by
      // wrapping the RpcTarget in an RpcStub itself, proactively, and using that as the property --
      // then, each time the property is get()ed, a dup() of that stub is returned.
      return new PayloadStubHook(RpcPayload.deepCopyFrom(
          followResult.value, followResult.parent, followResult.owner));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }

  dup(): StubHook {
    return new TargetStubHook(this.getTarget(), this.parent, this);
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    // This shouldn't be called since RpcTarget always becomes RpcStub, not RpcPromise, and you
    // can only pull a promise.
    return Promise.reject(new Error("Tried to resolve a non-promise stub."));
  }

  dispose(): void {
    if (this.target) {
      if (this.refcount) {
        if (--this.refcount.count == 0) {
          if (Symbol.dispose in this.target) {
            try {
              ((<Disposable><any>this.target)[Symbol.dispose])();
            } catch (err) {
              // We don't actually want to throw from dispose() as this will create trouble for
              // the RPC state machine. Instead, treat the application's error as an unhandled
              // rejection.
              Promise.reject(err);
            }
          }
        }
      }

      this.target = undefined;
    }
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
    return new PromiseStubHook(this.promise.then(hook => hook.call(path, args)));
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
}

let RpcTarget = UserRpcTarget
// If running in a Cloudflare Workers environment, register RpcStub & RpcPromise as RpcTarget capable
try {
  // @ts-expect-error It's not there yet...
  const { registerRpcTargetClass, RpcTarget: NativeRpcTarget } = await import("cloudflare:workers");

  registerRpcTargetClass(RpcStub);
  registerRpcTargetClass(RpcPromise);
  
  // And use the real RpcTarget class
  RpcTarget = NativeRpcTarget
} catch {}

export { RpcTarget }