var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../node_modules/capnweb/dist/index-workers.js
import * as cfw from "cloudflare:workers";
var WORKERS_MODULE_SYMBOL = /* @__PURE__ */ Symbol("workers-module");
globalThis[WORKERS_MODULE_SYMBOL] = cfw;
if (!Symbol.dispose) {
  Symbol.dispose = /* @__PURE__ */ Symbol.for("dispose");
}
if (!Symbol.asyncDispose) {
  Symbol.asyncDispose = /* @__PURE__ */ Symbol.for("asyncDispose");
}
if (!Promise.withResolvers) {
  Promise.withResolvers = function() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
var workersModule = globalThis[WORKERS_MODULE_SYMBOL];
var RpcTarget = workersModule ? workersModule.RpcTarget : class {
};
var AsyncFunction = (async function() {
}).constructor;
var BUFFER_PROTOTYPE = typeof Buffer !== "undefined" ? Buffer.prototype : void 0;
function typeForRpc(value) {
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return "primitive";
    case "undefined":
      return "undefined";
    case "object":
    case "function":
      break;
    case "bigint":
      return "bigint";
    default:
      return "unsupported";
  }
  if (value === null) {
    return "primitive";
  }
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
    case BUFFER_PROTOTYPE:
      return "bytes";
    case WritableStream.prototype:
      return "writable";
    case ReadableStream.prototype:
      return "readable";
    case Headers.prototype:
      return "headers";
    case Request.prototype:
      return "request";
    case Response.prototype:
      return "response";
    case Blob.prototype:
      return "blob";
    // TODO: All other structured clone types.
    case RpcStub.prototype:
      return "stub";
    case RpcPromise.prototype:
      return "rpc-promise";
    // TODO: Promise<T> or thenable
    default:
      if (workersModule) {
        if (prototype == workersModule.RpcStub.prototype || value instanceof workersModule.ServiceStub) {
          return "rpc-target";
        } else if (prototype == workersModule.RpcPromise.prototype || prototype == workersModule.RpcProperty.prototype) {
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
__name(typeForRpc, "typeForRpc");
function mapNotLoaded() {
  throw new Error("RPC map() implementation was not loaded.");
}
__name(mapNotLoaded, "mapNotLoaded");
var mapImpl = { applyMap: mapNotLoaded, sendMap: mapNotLoaded };
function streamNotLoaded() {
  throw new Error("Stream implementation was not loaded.");
}
__name(streamNotLoaded, "streamNotLoaded");
var streamImpl = {
  createWritableStreamHook: streamNotLoaded,
  createWritableStreamFromHook: streamNotLoaded,
  createReadableStreamHook: streamNotLoaded
};
var StubHook = class {
  static {
    __name(this, "StubHook");
  }
  // Like call(), but designed for streaming calls (e.g. WritableStream writes). Returns:
  // - promise: A Promise<void> for the completion of the call.
  // - size: If the call was remote, the byte size of the serialized message. For local calls,
  //   undefined is returned, indicating the caller should await the promise to serialize writes
  //   (no overlapping).
  stream(path, args) {
    let hook = this.call(path, args);
    let pulled = hook.pull();
    let promise;
    if (pulled instanceof Promise) {
      promise = pulled.then((p) => {
        p.dispose();
      });
    } else {
      pulled.dispose();
      promise = Promise.resolve();
    }
    return { promise };
  }
};
var ErrorStubHook = class extends StubHook {
  static {
    __name(this, "ErrorStubHook");
  }
  constructor(error) {
    super();
    this.error = error;
  }
  call(path, args) {
    return this;
  }
  map(path, captures, instructions) {
    return this;
  }
  get(path) {
    return this;
  }
  dup() {
    return this;
  }
  pull() {
    return Promise.reject(this.error);
  }
  ignoreUnhandledRejections() {
  }
  dispose() {
  }
  onBroken(callback) {
    try {
      callback(this.error);
    } catch (err) {
      Promise.resolve(err);
    }
  }
};
var DISPOSED_HOOK = new ErrorStubHook(
  new Error("Attempted to use RPC stub after it has been disposed.")
);
var doCall = /* @__PURE__ */ __name((hook, path, params) => {
  return hook.call(path, params);
}, "doCall");
function withCallInterceptor(interceptor, callback) {
  let oldValue = doCall;
  doCall = interceptor;
  try {
    return callback();
  } finally {
    doCall = oldValue;
  }
}
__name(withCallInterceptor, "withCallInterceptor");
var RAW_STUB = /* @__PURE__ */ Symbol("realStub");
var PROXY_HANDLERS = {
  apply(target, thisArg, argumentsList) {
    let stub = target.raw;
    return new RpcPromise(doCall(
      stub.hook,
      stub.pathIfPromise || [],
      RpcPayload.fromAppParams(argumentsList)
    ), []);
  },
  get(target, prop, receiver) {
    let stub = target.raw;
    if (prop === RAW_STUB) {
      return stub;
    } else if (prop in RpcPromise.prototype) {
      return stub[prop];
    } else if (typeof prop === "string") {
      return new RpcPromise(
        stub.hook,
        stub.pathIfPromise ? [...stub.pathIfPromise, prop] : [prop]
      );
    } else if (prop === Symbol.dispose && (!stub.pathIfPromise || stub.pathIfPromise.length == 0)) {
      return () => {
        stub.hook.dispose();
        stub.hook = DISPOSED_HOOK;
      };
    } else {
      return void 0;
    }
  },
  has(target, prop) {
    let stub = target.raw;
    if (prop === RAW_STUB) {
      return true;
    } else if (prop in RpcPromise.prototype) {
      return prop in stub;
    } else if (typeof prop === "string") {
      return true;
    } else if (prop === Symbol.dispose && (!stub.pathIfPromise || stub.pathIfPromise.length == 0)) {
      return true;
    } else {
      return false;
    }
  },
  construct(target, args) {
    throw new Error("An RPC stub cannot be used as a constructor.");
  },
  defineProperty(target, property, attributes) {
    throw new Error("Can't define properties on RPC stubs.");
  },
  deleteProperty(target, p) {
    throw new Error("Can't delete properties on RPC stubs.");
  },
  getOwnPropertyDescriptor(target, p) {
    return void 0;
  },
  getPrototypeOf(target) {
    return Object.getPrototypeOf(target.raw);
  },
  isExtensible(target) {
    return false;
  },
  ownKeys(target) {
    return [];
  },
  preventExtensions(target) {
    return true;
  },
  set(target, p, newValue, receiver) {
    throw new Error("Can't assign properties on RPC stubs.");
  },
  setPrototypeOf(target, v) {
    throw new Error("Can't override prototype of RPC stubs.");
  }
};
var RpcStub = class _RpcStub extends RpcTarget {
  static {
    __name(this, "_RpcStub");
  }
  // Although `hook` and `path` are declared `public` here, they are effectively hidden by the
  // proxy.
  constructor(hook, pathIfPromise) {
    super();
    if (!(hook instanceof StubHook)) {
      let value = hook;
      if (value instanceof RpcTarget || value instanceof Function) {
        hook = TargetStubHook.create(value, void 0);
      } else {
        hook = new PayloadStubHook(RpcPayload.fromAppReturn(value));
      }
      if (pathIfPromise) {
        throw new TypeError("RpcStub constructor expected one argument, received two.");
      }
    }
    this.hook = hook;
    this.pathIfPromise = pathIfPromise;
    let func = /* @__PURE__ */ __name(() => {
    }, "func");
    func.raw = this;
    return new Proxy(func, PROXY_HANDLERS);
  }
  hook;
  pathIfPromise;
  dup() {
    let target = this[RAW_STUB];
    if (target.pathIfPromise) {
      return new _RpcStub(target.hook.get(target.pathIfPromise));
    } else {
      return new _RpcStub(target.hook.dup());
    }
  }
  onRpcBroken(callback) {
    this[RAW_STUB].hook.onBroken(callback);
  }
  map(func) {
    let { hook, pathIfPromise } = this[RAW_STUB];
    return mapImpl.sendMap(hook, pathIfPromise || [], func);
  }
  toString() {
    return "[object RpcStub]";
  }
};
var RpcPromise = class extends RpcStub {
  static {
    __name(this, "RpcPromise");
  }
  // TODO: Support passing target value or promise to constructor.
  constructor(hook, pathIfPromise) {
    super(hook, pathIfPromise);
  }
  then(onfulfilled, onrejected) {
    return pullPromise(this).then(...arguments);
  }
  catch(onrejected) {
    return pullPromise(this).catch(...arguments);
  }
  finally(onfinally) {
    return pullPromise(this).finally(...arguments);
  }
  toString() {
    return "[object RpcPromise]";
  }
};
function unwrapStubTakingOwnership(stub) {
  let { hook, pathIfPromise } = stub[RAW_STUB];
  if (pathIfPromise && pathIfPromise.length > 0) {
    return hook.get(pathIfPromise);
  } else {
    return hook;
  }
}
__name(unwrapStubTakingOwnership, "unwrapStubTakingOwnership");
function unwrapStubAndDup(stub) {
  let { hook, pathIfPromise } = stub[RAW_STUB];
  if (pathIfPromise) {
    return hook.get(pathIfPromise);
  } else {
    return hook.dup();
  }
}
__name(unwrapStubAndDup, "unwrapStubAndDup");
function unwrapStubNoProperties(stub) {
  let { hook, pathIfPromise } = stub[RAW_STUB];
  if (pathIfPromise && pathIfPromise.length > 0) {
    return void 0;
  }
  return hook;
}
__name(unwrapStubNoProperties, "unwrapStubNoProperties");
function unwrapStubOrParent(stub) {
  return stub[RAW_STUB].hook;
}
__name(unwrapStubOrParent, "unwrapStubOrParent");
function unwrapStubAndPath(stub) {
  return stub[RAW_STUB];
}
__name(unwrapStubAndPath, "unwrapStubAndPath");
async function pullPromise(promise) {
  let { hook, pathIfPromise } = promise[RAW_STUB];
  if (pathIfPromise.length > 0) {
    hook = hook.get(pathIfPromise);
  }
  let payload = await hook.pull();
  return payload.deliverResolve();
}
__name(pullPromise, "pullPromise");
var RpcPayload = class _RpcPayload {
  static {
    __name(this, "_RpcPayload");
  }
  // Private constructor; use factory functions above to construct.
  constructor(value, source, hooks, promises) {
    this.value = value;
    this.source = source;
    this.hooks = hooks;
    this.promises = promises;
  }
  // Create a payload from a value passed as params to an RPC from the app.
  //
  // The payload does NOT take ownership of any stubs in `value`, and but promises not to modify
  // `value`. If the payload is delivered locally, `value` will be deep-copied first, so as not
  // to have the sender and recipient end up sharing the same mutable object. `value` will not be
  // touched again after the call returns synchronously (returns a promise) -- by that point,
  // the value has either been copied or serialized to the wire.
  static fromAppParams(value) {
    return new _RpcPayload(value, "params");
  }
  // Create a payload from a value return from an RPC implementation by the app.
  //
  // Unlike fromAppParams(), in this case the payload takes ownership of all stubs in `value`, and
  // may hold onto `value` for an arbitrarily long time (e.g. to serve pipelined requests). It
  // will still avoid modifying `value` and will make a deep copy if it is delivered locally.
  static fromAppReturn(value) {
    return new _RpcPayload(value, "return");
  }
  // Combine an array of payloads into a single payload whose value is an array. Ownership of all
  // stubs is transferred from the inputs to the outputs, hence if the output is disposed, the
  // inputs should not be. (In case of exception, nothing is disposed, though.)
  static fromArray(array) {
    let hooks = [];
    let promises = [];
    let resultArray = [];
    for (let payload of array) {
      payload.ensureDeepCopied();
      for (let hook of payload.hooks) {
        hooks.push(hook);
      }
      for (let promise of payload.promises) {
        if (promise.parent === payload) {
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
    return new _RpcPayload(resultArray, "owned", hooks, promises);
  }
  // Create a payload from a value parsed off the wire using Evaluator.evaluate().
  //
  // A payload is constructed with a null value and the given hooks and promises arrays. The value
  // is expected to be filled in by the evaluator, and the hooks and promises arrays are expected
  // to be extended with stubs found during parsing. (This weird usage model is necessary so that
  // if the root value turns out to be a promise, its `parent` in `promises` can be the payload
  // object itself.)
  //
  // When done, the payload takes ownership of the final value and all the stubs within. It may
  // modify the value in preparation for delivery, and may deliver the value directly to the app
  // without copying.
  static forEvaluate(hooks, promises) {
    return new _RpcPayload(null, "owned", hooks, promises);
  }
  // Deep-copy the given value, including dup()ing all stubs.
  //
  // If `value` is a function, it should be bound to `oldParent` as its `this`.
  //
  // If deep-copying from a branch of some other RpcPayload, it must be provided, to make sure
  // RpcTargets found within don't get duplicate stubs.
  static deepCopyFrom(value, oldParent, owner) {
    let result = new _RpcPayload(null, "owned", [], []);
    result.value = result.deepCopy(
      value,
      oldParent,
      "value",
      result,
      /*dupStubs=*/
      true,
      owner
    );
    return result;
  }
  // For `source === "return"` payloads only, this tracks any StubHooks created around RpcTargets
  // or WritableStreams found in the payload at the time that it is serialized (or deep-copied) for
  // return, so that we can make sure they are not disposed before the pipeline ends.
  //
  // This is initialized on first use.
  rpcTargets;
  // Get the StubHook representing the given RpcTarget found inside this payload.
  getHookForRpcTarget(target, parent, dupStubs = true) {
    if (this.source === "params") {
      if (dupStubs) {
        let dupable = target;
        if (typeof dupable.dup === "function") {
          target = dupable.dup();
        }
      }
      return TargetStubHook.create(target, parent);
    } else if (this.source === "return") {
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
            this.rpcTargets = /* @__PURE__ */ new Map();
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
  // Get the StubHook representing the given WritableStream found inside this payload.
  getHookForWritableStream(stream, parent, dupStubs = true) {
    if (this.source === "params") {
      return streamImpl.createWritableStreamHook(stream);
    } else if (this.source === "return") {
      let hook = this.rpcTargets?.get(stream);
      if (hook) {
        if (dupStubs) {
          return hook.dup();
        } else {
          this.rpcTargets?.delete(stream);
          return hook;
        }
      } else {
        hook = streamImpl.createWritableStreamHook(stream);
        if (dupStubs) {
          if (!this.rpcTargets) {
            this.rpcTargets = /* @__PURE__ */ new Map();
          }
          this.rpcTargets.set(stream, hook);
          return hook.dup();
        } else {
          return hook;
        }
      }
    } else {
      throw new Error("owned payload shouldn't contain raw WritableStreams");
    }
  }
  // Get the StubHook representing the given ReadableStream found inside this payload.
  getHookForReadableStream(stream, parent, dupStubs = true) {
    if (this.source === "params") {
      return streamImpl.createReadableStreamHook(stream);
    } else if (this.source === "return") {
      let hook = this.rpcTargets?.get(stream);
      if (hook) {
        if (dupStubs) {
          return hook.dup();
        } else {
          this.rpcTargets?.delete(stream);
          return hook;
        }
      } else {
        hook = streamImpl.createReadableStreamHook(stream);
        if (dupStubs) {
          if (!this.rpcTargets) {
            this.rpcTargets = /* @__PURE__ */ new Map();
          }
          this.rpcTargets.set(stream, hook);
          return hook.dup();
        } else {
          return hook;
        }
      }
    } else {
      throw new Error("owned payload shouldn't contain raw ReadableStreams");
    }
  }
  deepCopy(value, oldParent, property, parent, dupStubs, owner) {
    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported":
        return value;
      case "primitive":
      case "bigint":
      case "date":
      case "bytes":
      case "blob":
      case "error":
      case "undefined":
        return value;
      case "array": {
        let array = value;
        let len = array.length;
        let result = new Array(len);
        for (let i = 0; i < len; i++) {
          result[i] = this.deepCopy(array[i], array, i, result, dupStubs, owner);
        }
        return result;
      }
      case "object": {
        let result = {};
        let object = value;
        for (let i in object) {
          result[i] = this.deepCopy(object[i], object, i, result, dupStubs, owner);
        }
        return result;
      }
      case "stub":
      case "rpc-promise": {
        let stub = value;
        let hook;
        if (dupStubs) {
          hook = unwrapStubAndDup(stub);
        } else {
          hook = unwrapStubTakingOwnership(stub);
        }
        if (stub instanceof RpcPromise) {
          let promise = new RpcPromise(hook, []);
          this.promises.push({ parent, property, promise });
          return promise;
        } else {
          this.hooks.push(hook);
          return new RpcStub(hook);
        }
      }
      case "function":
      case "rpc-target": {
        let target = value;
        let hook;
        if (owner) {
          hook = owner.getHookForRpcTarget(target, oldParent, dupStubs);
        } else {
          hook = TargetStubHook.create(target, oldParent);
        }
        this.hooks.push(hook);
        return new RpcStub(hook);
      }
      case "rpc-thenable": {
        let target = value;
        let promise;
        if (owner) {
          promise = new RpcPromise(owner.getHookForRpcTarget(target, oldParent, dupStubs), []);
        } else {
          promise = new RpcPromise(TargetStubHook.create(target, oldParent), []);
        }
        this.promises.push({ parent, property, promise });
        return promise;
      }
      case "writable": {
        let stream = value;
        let hook;
        if (owner) {
          hook = owner.getHookForWritableStream(stream, oldParent, dupStubs);
        } else {
          hook = streamImpl.createWritableStreamHook(stream);
        }
        this.hooks.push(hook);
        return stream;
      }
      case "readable": {
        let stream = value;
        let hook;
        if (owner) {
          hook = owner.getHookForReadableStream(stream, oldParent, dupStubs);
        } else {
          hook = streamImpl.createReadableStreamHook(stream);
        }
        this.hooks.push(hook);
        return stream;
      }
      case "headers":
        return new Headers(value);
      case "request": {
        let req = value;
        if (req.body) {
          this.deepCopy(req.body, req, "body", req, dupStubs, owner);
        }
        return new Request(req);
      }
      case "response": {
        let resp = value;
        if (resp.body) {
          this.deepCopy(resp.body, resp, "body", resp, dupStubs, owner);
        }
        return new Response(resp.body, resp);
      }
      default:
        throw new Error("unreachable");
    }
  }
  // Ensures that if the value originally came from an unowned source, we have replaced it with a
  // deep copy.
  ensureDeepCopied() {
    if (this.source !== "owned") {
      let dupStubs = this.source === "params";
      this.hooks = [];
      this.promises = [];
      try {
        this.value = this.deepCopy(this.value, void 0, "value", this, dupStubs, this);
      } catch (err) {
        this.hooks = void 0;
        this.promises = void 0;
        throw err;
      }
      this.source = "owned";
      if (this.rpcTargets && this.rpcTargets.size > 0) {
        throw new Error("Not all rpcTargets were accounted for in deep-copy?");
      }
      this.rpcTargets = void 0;
    }
  }
  // Resolve all promises in this payload and then assign the final value into `parent[property]`.
  deliverTo(parent, property, promises) {
    this.ensureDeepCopied();
    if (this.value instanceof RpcPromise) {
      _RpcPayload.deliverRpcPromiseTo(this.value, parent, property, promises);
    } else {
      parent[property] = this.value;
      for (let record of this.promises) {
        _RpcPayload.deliverRpcPromiseTo(record.promise, record.parent, record.property, promises);
      }
    }
  }
  static deliverRpcPromiseTo(promise, parent, property, promises) {
    let hook = unwrapStubNoProperties(promise);
    if (!hook) {
      throw new Error("property promises should have been resolved earlier");
    }
    let inner = hook.pull();
    if (inner instanceof _RpcPayload) {
      inner.deliverTo(parent, property, promises);
    } else {
      promises.push(inner.then((payload) => {
        let subPromises = [];
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
  async deliverCall(func, thisArg) {
    try {
      let promises = [];
      this.deliverTo(this, "value", promises);
      if (promises.length > 0) {
        await Promise.all(promises);
      }
      let result = Function.prototype.apply.call(func, thisArg, this.value);
      if (result instanceof RpcPromise) {
        return _RpcPayload.fromAppReturn(result);
      } else {
        return _RpcPayload.fromAppReturn(await result);
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
  async deliverResolve() {
    try {
      let promises = [];
      this.deliverTo(this, "value", promises);
      if (promises.length > 0) {
        await Promise.all(promises);
      }
      let result = this.value;
      if (result instanceof Object) {
        if (!(Symbol.dispose in result)) {
          Object.defineProperty(result, Symbol.dispose, {
            // NOTE: Using `this.dispose.bind(this)` here causes Playwright's build of
            //   Chromium 140.0.7339.16 to fail when the object is assigned to a `using` variable,
            //   with the error:
            //       TypeError: Symbol(Symbol.dispose) is not a function
            //   I cannot reproduce this problem in Chrome 140.0.7339.127 nor in Node or workerd,
            //   so maybe it was a short-lived V8 bug or something. To be safe, though, we use
            //   `() => this.dispose()`, which seems to always work.
            value: /* @__PURE__ */ __name(() => this.dispose(), "value"),
            writable: true,
            enumerable: false,
            configurable: true
          });
        }
      }
      return result;
    } catch (err) {
      this.dispose();
      throw err;
    }
  }
  dispose() {
    if (this.source === "owned") {
      this.hooks.forEach((hook) => hook.dispose());
      this.promises.forEach((promise) => promise.promise[Symbol.dispose]());
    } else if (this.source === "return") {
      this.disposeImpl(this.value, void 0);
      if (this.rpcTargets && this.rpcTargets.size > 0) {
        throw new Error("Not all rpcTargets were accounted for in disposeImpl()?");
      }
    } else ;
    this.source = "owned";
    this.hooks = [];
    this.promises = [];
  }
  // Recursive dispose, called only when `source` is "return".
  disposeImpl(value, parent) {
    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported":
      case "primitive":
      case "bigint":
      case "bytes":
      case "blob":
      case "date":
      case "error":
      case "undefined":
        return;
      case "array": {
        let array = value;
        let len = array.length;
        for (let i = 0; i < len; i++) {
          this.disposeImpl(array[i], array);
        }
        return;
      }
      case "object": {
        let object = value;
        for (let i in object) {
          this.disposeImpl(object[i], object);
        }
        return;
      }
      case "stub":
      case "rpc-promise": {
        let stub = value;
        let hook = unwrapStubNoProperties(stub);
        if (hook) {
          hook.dispose();
        }
        return;
      }
      case "function":
      case "rpc-target": {
        let target = value;
        let hook = this.rpcTargets?.get(target);
        if (hook) {
          hook.dispose();
          this.rpcTargets.delete(target);
        } else {
          disposeRpcTarget(target);
        }
        return;
      }
      case "rpc-thenable":
        return;
      case "headers":
        return;
      case "request": {
        let req = value;
        if (req.body) this.disposeImpl(req.body, req);
        return;
      }
      case "response": {
        let resp = value;
        if (resp.body) this.disposeImpl(resp.body, resp);
        return;
      }
      case "writable": {
        let stream = value;
        let hook = this.rpcTargets?.get(stream);
        if (hook) {
          this.rpcTargets.delete(stream);
        } else {
          hook = streamImpl.createWritableStreamHook(stream);
        }
        hook.dispose();
        return;
      }
      case "readable": {
        let stream = value;
        let hook = this.rpcTargets?.get(stream);
        if (hook) {
          this.rpcTargets.delete(stream);
        } else {
          hook = streamImpl.createReadableStreamHook(stream);
        }
        hook.dispose();
        return;
      }
      default:
        return;
    }
  }
  // Ignore unhandled rejections in all promises in this payload -- that is, all promises that
  // *would* be awaited if this payload were to be delivered. See the similarly-named method of
  // StubHook for explanation.
  ignoreUnhandledRejections() {
    if (this.hooks) {
      this.hooks.forEach((hook) => {
        hook.ignoreUnhandledRejections();
      });
      this.promises.forEach(
        (promise) => unwrapStubOrParent(promise.promise).ignoreUnhandledRejections()
      );
    } else {
      this.ignoreUnhandledRejectionsImpl(this.value);
    }
  }
  ignoreUnhandledRejectionsImpl(value) {
    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported":
      case "primitive":
      case "bigint":
      case "bytes":
      case "blob":
      case "date":
      case "error":
      case "undefined":
      case "function":
      case "rpc-target":
      case "writable":
      case "readable":
      case "headers":
      case "request":
      case "response":
        return;
      case "array": {
        let array = value;
        let len = array.length;
        for (let i = 0; i < len; i++) {
          this.ignoreUnhandledRejectionsImpl(array[i]);
        }
        return;
      }
      case "object": {
        let object = value;
        for (let i in object) {
          this.ignoreUnhandledRejectionsImpl(object[i]);
        }
        return;
      }
      case "stub":
      case "rpc-promise":
        unwrapStubOrParent(value).ignoreUnhandledRejections();
        return;
      case "rpc-thenable":
        value.then((_) => {
        }, (_) => {
        });
        return;
      default:
        return;
    }
  }
};
function followPath(value, parent, path, owner) {
  for (let i = 0; i < path.length; i++) {
    parent = value;
    let part = path[i];
    if (part in Object.prototype) {
      value = void 0;
      continue;
    }
    let kind = typeForRpc(value);
    switch (kind) {
      case "object":
      case "function":
        if (Object.hasOwn(value, part)) {
          value = value[part];
        } else {
          value = void 0;
        }
        break;
      case "array":
        if (Number.isInteger(part) && part >= 0) {
          value = value[part];
        } else {
          value = void 0;
        }
        break;
      case "rpc-target":
      case "rpc-thenable": {
        if (Object.hasOwn(value, part)) {
          throw new TypeError(
            `Attempted to access property '${part}', which is an instance property of the RpcTarget. To avoid leaking private internals, instance properties cannot be accessed over RPC. If you want to make this property available over RPC, define it as a method or getter on the class, instead of an instance property.`
          );
        } else {
          value = value[part];
        }
        owner = null;
        break;
      }
      case "stub":
      case "rpc-promise": {
        let { hook, pathIfPromise } = unwrapStubAndPath(value);
        return { hook, remainingPath: pathIfPromise ? pathIfPromise.concat(path.slice(i)) : path.slice(i) };
      }
      case "writable":
        value = void 0;
        break;
      case "readable":
        value = void 0;
        break;
      case "primitive":
      case "bigint":
      case "bytes":
      case "blob":
      case "date":
      case "error":
      case "headers":
      case "request":
      case "response":
        value = void 0;
        break;
      case "undefined":
        value = value[part];
        break;
      case "unsupported": {
        if (i === 0) {
          throw new TypeError(`RPC stub points at a non-serializable type.`);
        } else {
          let prefix = path.slice(0, i).join(".");
          let remainder = path.slice(0, i).join(".");
          throw new TypeError(
            `'${prefix}' is not a serializable type, so property ${remainder} cannot be accessed.`
          );
        }
      }
      default:
        throw new TypeError("unreachable");
    }
  }
  if (value instanceof RpcPromise) {
    let { hook, pathIfPromise } = unwrapStubAndPath(value);
    return { hook, remainingPath: pathIfPromise || [] };
  }
  return {
    value,
    parent,
    owner
  };
}
__name(followPath, "followPath");
var ValueStubHook = class extends StubHook {
  static {
    __name(this, "ValueStubHook");
  }
  call(path, args) {
    try {
      let { value, owner } = this.getValue();
      let followResult = followPath(value, void 0, path, owner);
      if (followResult.hook) {
        return followResult.hook.call(followResult.remainingPath, args);
      }
      if (typeof followResult.value != "function") {
        throw new TypeError(`'${path.join(".")}' is not a function.`);
      }
      let promise = args.deliverCall(followResult.value, followResult.parent);
      return new PromiseStubHook(promise.then((payload) => {
        return new PayloadStubHook(payload);
      }));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }
  map(path, captures, instructions) {
    try {
      let followResult;
      try {
        let { value, owner } = this.getValue();
        followResult = followPath(value, void 0, path, owner);
        ;
      } catch (err) {
        for (let cap of captures) {
          cap.dispose();
        }
        throw err;
      }
      if (followResult.hook) {
        return followResult.hook.map(followResult.remainingPath, captures, instructions);
      }
      return mapImpl.applyMap(
        followResult.value,
        followResult.parent,
        followResult.owner,
        captures,
        instructions
      );
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }
  get(path) {
    try {
      let { value, owner } = this.getValue();
      if (path.length === 0 && owner === null) {
        throw new Error("Can't dup an RpcTarget stub as a promise.");
      }
      let followResult = followPath(value, void 0, path, owner);
      if (followResult.hook) {
        return followResult.hook.get(followResult.remainingPath);
      }
      return new PayloadStubHook(RpcPayload.deepCopyFrom(
        followResult.value,
        followResult.parent,
        followResult.owner
      ));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }
};
var PayloadStubHook = class _PayloadStubHook extends ValueStubHook {
  static {
    __name(this, "_PayloadStubHook");
  }
  constructor(payload) {
    super();
    this.payload = payload;
  }
  payload;
  // cleared when disposed
  getPayload() {
    if (this.payload) {
      return this.payload;
    } else {
      throw new Error("Attempted to use an RPC StubHook after it was disposed.");
    }
  }
  getValue() {
    let payload = this.getPayload();
    return { value: payload.value, owner: payload };
  }
  dup() {
    let thisPayload = this.getPayload();
    return new _PayloadStubHook(RpcPayload.deepCopyFrom(
      thisPayload.value,
      void 0,
      thisPayload
    ));
  }
  pull() {
    return this.getPayload();
  }
  ignoreUnhandledRejections() {
    if (this.payload) {
      this.payload.ignoreUnhandledRejections();
    }
  }
  dispose() {
    if (this.payload) {
      this.payload.dispose();
      this.payload = void 0;
    }
  }
  onBroken(callback) {
    if (this.payload) {
      if (this.payload.value instanceof RpcStub) {
        this.payload.value.onRpcBroken(callback);
      }
    }
  }
};
function disposeRpcTarget(target) {
  if (Symbol.dispose in target) {
    try {
      target[Symbol.dispose]();
    } catch (err) {
      Promise.reject(err);
    }
  }
}
__name(disposeRpcTarget, "disposeRpcTarget");
var TargetStubHook = class _TargetStubHook extends ValueStubHook {
  static {
    __name(this, "_TargetStubHook");
  }
  // Constructs a TargetStubHook that is not duplicated from an existing hook.
  //
  // If `value` is a function, `parent` is bound as its "this".
  static create(value, parent) {
    if (typeof value !== "function") {
      parent = void 0;
    }
    return new _TargetStubHook(value, parent);
  }
  constructor(target, parent, dupFrom) {
    super();
    this.target = target;
    this.parent = parent;
    if (dupFrom) {
      if (dupFrom.refcount) {
        this.refcount = dupFrom.refcount;
        ++this.refcount.count;
      }
    } else if (Symbol.dispose in target) {
      this.refcount = { count: 1 };
    }
  }
  target;
  // cleared when disposed
  parent;
  // `this` parameter when calling `target`
  refcount;
  // undefined if not needed (because target has no disposer)
  getTarget() {
    if (this.target) {
      return this.target;
    } else {
      throw new Error("Attempted to use an RPC StubHook after it was disposed.");
    }
  }
  getValue() {
    return { value: this.getTarget(), owner: null };
  }
  dup() {
    return new _TargetStubHook(this.getTarget(), this.parent, this);
  }
  pull() {
    let target = this.getTarget();
    if ("then" in target) {
      return Promise.resolve(target).then((resolution) => {
        return RpcPayload.fromAppReturn(resolution);
      });
    } else {
      return Promise.reject(new Error("Tried to resolve a non-promise stub."));
    }
  }
  ignoreUnhandledRejections() {
  }
  dispose() {
    if (this.target) {
      if (this.refcount) {
        if (--this.refcount.count == 0) {
          disposeRpcTarget(this.target);
        }
      }
      this.target = void 0;
    }
  }
  onBroken(callback) {
  }
};
var PromiseStubHook = class _PromiseStubHook extends StubHook {
  static {
    __name(this, "_PromiseStubHook");
  }
  promise;
  resolution;
  constructor(promise) {
    super();
    this.promise = promise.then((res) => {
      this.resolution = res;
      return res;
    });
  }
  call(path, args) {
    args.ensureDeepCopied();
    return new _PromiseStubHook(this.promise.then((hook) => hook.call(path, args)));
  }
  stream(path, args) {
    args.ensureDeepCopied();
    let promise = this.promise.then((hook) => {
      let result = hook.stream(path, args);
      return result.promise;
    });
    return { promise };
  }
  map(path, captures, instructions) {
    return new _PromiseStubHook(this.promise.then(
      (hook) => hook.map(path, captures, instructions),
      (err) => {
        for (let cap of captures) {
          cap.dispose();
        }
        throw err;
      }
    ));
  }
  get(path) {
    return new _PromiseStubHook(this.promise.then((hook) => hook.get(path)));
  }
  dup() {
    if (this.resolution) {
      return this.resolution.dup();
    } else {
      return new _PromiseStubHook(this.promise.then((hook) => hook.dup()));
    }
  }
  pull() {
    if (this.resolution) {
      return this.resolution.pull();
    } else {
      return this.promise.then((hook) => hook.pull());
    }
  }
  ignoreUnhandledRejections() {
    if (this.resolution) {
      this.resolution.ignoreUnhandledRejections();
    } else {
      this.promise.then((res) => {
        res.ignoreUnhandledRejections();
      }, (err) => {
      });
    }
  }
  dispose() {
    if (this.resolution) {
      this.resolution.dispose();
    } else {
      this.promise.then((hook) => {
        hook.dispose();
      }, (err) => {
      });
    }
  }
  onBroken(callback) {
    if (this.resolution) {
      this.resolution.onBroken(callback);
    } else {
      this.promise.then((hook) => {
        hook.onBroken(callback);
      }, callback);
    }
  }
};
var NullExporter = class {
  static {
    __name(this, "NullExporter");
  }
  exportStub(stub) {
    throw new Error("Cannot serialize RPC stubs without an RPC session.");
  }
  exportPromise(stub) {
    throw new Error("Cannot serialize RPC stubs without an RPC session.");
  }
  getImport(hook) {
    return void 0;
  }
  unexport(ids) {
  }
  createPipe(readable) {
    throw new Error("Cannot create pipes without an RPC session.");
  }
  onSendError(error) {
  }
};
var NULL_EXPORTER = new NullExporter();
async function streamToBlob(stream, type) {
  let b = await new Response(stream).blob();
  return b.type === type ? b : b.slice(0, b.size, type);
}
__name(streamToBlob, "streamToBlob");
var ERROR_TYPES = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
  AggregateError
  // TODO: DOMError? Others?
};
var Devaluator = class _Devaluator {
  static {
    __name(this, "_Devaluator");
  }
  constructor(exporter, source) {
    this.exporter = exporter;
    this.source = source;
  }
  // Devaluate the given value.
  // * value: The value to devaluate.
  // * parent: The value's parent object, which would be used as `this` if the value were called
  //     as a function.
  // * exporter: Callbacks to the RPC session for exporting capabilities found in this message.
  // * source: The RpcPayload which contains the value, and therefore owns stubs within.
  //
  // Returns: The devaluated value, ready to be JSON-serialized.
  static devaluate(value, parent, exporter = NULL_EXPORTER, source) {
    let devaluator = new _Devaluator(exporter, source);
    try {
      return devaluator.devaluateImpl(value, parent, 0);
    } catch (err) {
      if (devaluator.exports) {
        try {
          exporter.unexport(devaluator.exports);
        } catch (err2) {
        }
      }
      throw err;
    }
  }
  exports;
  devaluateImpl(value, parent, depth) {
    if (depth >= 64) {
      throw new Error(
        "Serialization exceeded maximum allowed depth. (Does the message contain cycles?)"
      );
    }
    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported": {
        let msg;
        try {
          msg = `Cannot serialize value: ${value}`;
        } catch (err) {
          msg = "Cannot serialize value: (couldn't stringify value)";
        }
        throw new TypeError(msg);
      }
      case "primitive":
        if (typeof value === "number" && !isFinite(value)) {
          if (value === Infinity) {
            return ["inf"];
          } else if (value === -Infinity) {
            return ["-inf"];
          } else {
            return ["nan"];
          }
        } else {
          return value;
        }
      case "object": {
        let object = value;
        let result = {};
        for (let key in object) {
          result[key] = this.devaluateImpl(object[key], object, depth + 1);
        }
        return result;
      }
      case "array": {
        let array = value;
        let len = array.length;
        let result = new Array(len);
        for (let i = 0; i < len; i++) {
          result[i] = this.devaluateImpl(array[i], array, depth + 1);
        }
        return [result];
      }
      case "bigint":
        return ["bigint", value.toString()];
      case "date": {
        const time = value.getTime();
        return ["date", Number.isNaN(time) ? null : time];
      }
      case "bytes": {
        let bytes = value;
        if (bytes.toBase64) {
          return ["bytes", bytes.toBase64({ omitPadding: true })];
        }
        let b64;
        if (typeof Buffer !== "undefined") {
          let buf = bytes instanceof Buffer ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          b64 = buf.toString("base64");
        } else {
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          b64 = btoa(binary);
        }
        return ["bytes", b64.replace(/=+$/, "")];
      }
      case "headers":
        return ["headers", [...value]];
      case "request": {
        let req = value;
        let init = {};
        if (req.method !== "GET") init.method = req.method;
        let headers = [...req.headers];
        if (headers.length > 0) {
          init.headers = headers;
        }
        if (req.body) {
          init.body = this.devaluateImpl(req.body, req, depth + 1);
          init.duplex = req.duplex || "half";
        } else if (req.body === void 0 && !["GET", "HEAD", "OPTIONS", "TRACE", "DELETE"].includes(req.method)) {
          let bodyPromise = req.arrayBuffer();
          let readable = new ReadableStream({
            async start(controller) {
              try {
                controller.enqueue(new Uint8Array(await bodyPromise));
                controller.close();
              } catch (err) {
                controller.error(err);
              }
            }
          });
          let hook = streamImpl.createReadableStreamHook(readable);
          let importId = this.exporter.createPipe(readable, hook);
          init.body = ["readable", importId];
          init.duplex = req.duplex || "half";
        }
        if (req.cache && req.cache !== "default") init.cache = req.cache;
        if (req.redirect !== "follow") init.redirect = req.redirect;
        if (req.integrity) init.integrity = req.integrity;
        if (req.mode && req.mode !== "cors") init.mode = req.mode;
        if (req.credentials && req.credentials !== "same-origin") {
          init.credentials = req.credentials;
        }
        if (req.referrer && req.referrer !== "about:client") init.referrer = req.referrer;
        if (req.referrerPolicy) init.referrerPolicy = req.referrerPolicy;
        if (req.keepalive) init.keepalive = req.keepalive;
        let cfReq = req;
        if (cfReq.cf) init.cf = cfReq.cf;
        if (cfReq.encodeResponseBody && cfReq.encodeResponseBody !== "automatic") {
          init.encodeResponseBody = cfReq.encodeResponseBody;
        }
        return ["request", req.url, init];
      }
      case "response": {
        let resp = value;
        let body = this.devaluateImpl(resp.body, resp, depth + 1);
        let init = {};
        if (resp.status !== 200) init.status = resp.status;
        if (resp.statusText) init.statusText = resp.statusText;
        let headers = [...resp.headers];
        if (headers.length > 0) {
          init.headers = headers;
        }
        let cfResp = resp;
        if (cfResp.cf) init.cf = cfResp.cf;
        if (cfResp.encodeBody && cfResp.encodeBody !== "automatic") {
          init.encodeBody = cfResp.encodeBody;
        }
        if (cfResp.webSocket) {
          throw new TypeError("Can't serialize a Response containing a webSocket.");
        }
        return ["response", body, init];
      }
      case "blob": {
        let blob = value;
        let readable = blob.stream();
        let hook = streamImpl.createReadableStreamHook(readable);
        let importId = this.exporter.createPipe(readable, hook);
        return ["blob", blob.type, ["readable", importId]];
      }
      case "error": {
        let e = value;
        let rewritten = this.exporter.onSendError(e);
        if (rewritten) {
          e = rewritten;
        }
        let anyE = e;
        let props;
        let captureProp = /* @__PURE__ */ __name((key, val) => {
          let exportsBefore = this.exports?.length ?? 0;
          try {
            let encoded = this.devaluateImpl(val, e, depth + 1);
            if (!props) props = {};
            props[key] = encoded;
          } catch (err) {
            if (this.exports && this.exports.length > exportsBefore) {
              let tail = this.exports.splice(exportsBefore);
              try {
                this.exporter.unexport(tail);
              } catch (err2) {
              }
            }
          }
        }, "captureProp");
        for (let key of Object.keys(e)) {
          if (key === "name" || key === "message" || key === "stack") continue;
          captureProp(key, anyE[key]);
        }
        if ("cause" in e) {
          captureProp("cause", anyE.cause);
        }
        if (e instanceof AggregateError) {
          captureProp("errors", e.errors);
        }
        let result = ["error", e.name, e.message];
        if (props) {
          result.push(rewritten && rewritten.stack ? rewritten.stack : null);
          result.push(props);
        } else if (rewritten && rewritten.stack) {
          result.push(rewritten.stack);
        }
        return result;
      }
      case "undefined":
        return ["undefined"];
      case "stub":
      case "rpc-promise": {
        if (!this.source) {
          throw new Error("Can't serialize RPC stubs in this context.");
        }
        let { hook, pathIfPromise } = unwrapStubAndPath(value);
        let importId = this.exporter.getImport(hook);
        if (importId !== void 0) {
          if (pathIfPromise) {
            if (pathIfPromise.length > 0) {
              return ["pipeline", importId, pathIfPromise];
            } else {
              return ["pipeline", importId];
            }
          } else {
            return ["import", importId];
          }
        }
        if (pathIfPromise) {
          hook = hook.get(pathIfPromise);
        } else {
          hook = hook.dup();
        }
        return this.devaluateHook(pathIfPromise ? "promise" : "export", hook);
      }
      case "function":
      case "rpc-target": {
        if (!this.source) {
          throw new Error("Can't serialize RPC stubs in this context.");
        }
        let hook = this.source.getHookForRpcTarget(value, parent);
        return this.devaluateHook("export", hook);
      }
      case "rpc-thenable": {
        if (!this.source) {
          throw new Error("Can't serialize RPC stubs in this context.");
        }
        let hook = this.source.getHookForRpcTarget(value, parent);
        return this.devaluateHook("promise", hook);
      }
      case "writable": {
        if (!this.source) {
          throw new Error("Can't serialize WritableStream in this context.");
        }
        let hook = this.source.getHookForWritableStream(value, parent);
        return this.devaluateHook("writable", hook);
      }
      case "readable": {
        if (!this.source) {
          throw new Error("Can't serialize ReadableStream in this context.");
        }
        let ws = value;
        let hook = this.source.getHookForReadableStream(ws, parent);
        let importId = this.exporter.createPipe(ws, hook);
        return ["readable", importId];
      }
      default:
        throw new Error("unreachable");
    }
  }
  devaluateHook(type, hook) {
    if (!this.exports) this.exports = [];
    let exportId = type === "promise" ? this.exporter.exportPromise(hook) : this.exporter.exportStub(hook);
    this.exports.push(exportId);
    return [type, exportId];
  }
};
var NullImporter = class {
  static {
    __name(this, "NullImporter");
  }
  importStub(idx) {
    throw new Error("Cannot deserialize RPC stubs without an RPC session.");
  }
  importPromise(idx) {
    throw new Error("Cannot deserialize RPC stubs without an RPC session.");
  }
  getExport(idx) {
    return void 0;
  }
  getPipeReadable(exportId) {
    throw new Error("Cannot retrieve pipe readable without an RPC session.");
  }
};
var NULL_IMPORTER = new NullImporter();
function fixBrokenRequestBody(request, body) {
  let promise = new Response(body).arrayBuffer().then((arrayBuffer) => {
    let bytes = new Uint8Array(arrayBuffer);
    let result = new Request(request, { body: bytes });
    return new PayloadStubHook(RpcPayload.fromAppReturn(result));
  });
  return new RpcPromise(new PromiseStubHook(promise), []);
}
__name(fixBrokenRequestBody, "fixBrokenRequestBody");
function streamToBlobPromise(stream, type) {
  let promise = streamToBlob(stream, type).then((blob) => {
    return new PayloadStubHook(RpcPayload.fromAppReturn(blob));
  });
  return new RpcPromise(new PromiseStubHook(promise), []);
}
__name(streamToBlobPromise, "streamToBlobPromise");
var Evaluator = class _Evaluator {
  static {
    __name(this, "_Evaluator");
  }
  constructor(importer) {
    this.importer = importer;
  }
  hooks = [];
  promises = [];
  evaluate(value) {
    let payload = RpcPayload.forEvaluate(this.hooks, this.promises);
    try {
      payload.value = this.evaluateImpl(value, payload, "value");
      return payload;
    } catch (err) {
      payload.dispose();
      throw err;
    }
  }
  // Evaluate the value without destroying it.
  evaluateCopy(value) {
    return this.evaluate(structuredClone(value));
  }
  evaluateImpl(value, parent, property) {
    if (value instanceof Array) {
      if (value.length == 1 && value[0] instanceof Array) {
        let result = value[0];
        for (let i = 0; i < result.length; i++) {
          result[i] = this.evaluateImpl(result[i], result, i);
        }
        return result;
      } else switch (value[0]) {
        case "bigint":
          if (typeof value[1] == "string") {
            return BigInt(value[1]);
          }
          break;
        case "date":
          if (value[1] === null) {
            return /* @__PURE__ */ new Date(NaN);
          }
          if (typeof value[1] == "number") {
            return new Date(value[1]);
          }
          break;
        case "bytes": {
          if (typeof value[1] == "string") {
            if (typeof Buffer !== "undefined") {
              return Buffer.from(value[1], "base64");
            } else if (Uint8Array.fromBase64) {
              return Uint8Array.fromBase64(value[1]);
            } else {
              let bs = atob(value[1]);
              let len = bs.length;
              let bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = bs.charCodeAt(i);
              }
              return bytes;
            }
          }
          break;
        }
        case "error":
          if (value.length >= 3 && typeof value[1] === "string" && typeof value[2] === "string") {
            let cls = ERROR_TYPES[value[1]] || Error;
            let result = cls === AggregateError ? new cls([], value[2]) : new cls(value[2]);
            if (typeof value[3] === "string") {
              result.stack = value[3];
            }
            if (value.length >= 5) {
              let props = value[4];
              if (!props || typeof props !== "object" || Array.isArray(props)) {
                break;
              }
              let anyResult = result;
              let propsObj = props;
              for (let key of Object.keys(propsObj)) {
                if (key === "name" || key === "message" || key === "stack") continue;
                anyResult[key] = this.evaluateImpl(propsObj[key], result, key);
              }
            }
            return result;
          }
          break;
        case "undefined":
          if (value.length === 1) {
            return void 0;
          }
          break;
        case "inf":
          return Infinity;
        case "-inf":
          return -Infinity;
        case "nan":
          return NaN;
        case "headers":
          if (value.length === 2 && value[1] instanceof Array) {
            return new Headers(value[1]);
          }
          break;
        case "request": {
          if (value.length !== 3 || typeof value[1] !== "string") break;
          let url = value[1];
          let init = value[2];
          if (typeof init !== "object" || init === null) break;
          if (init.body) {
            init.body = this.evaluateImpl(init.body, init, "body");
            if (init.body === null || typeof init.body === "string" || init.body instanceof Uint8Array || init.body instanceof ReadableStream) ;
            else {
              throw new TypeError("Request body must be of type ReadableStream.");
            }
          }
          if (init.signal) {
            init.signal = this.evaluateImpl(init.signal, init, "signal");
            if (!(init.signal instanceof AbortSignal)) {
              throw new TypeError("Request siganl must be of type AbortSignal.");
            }
          }
          if (init.headers && !(init.headers instanceof Array)) {
            throw new TypeError("Request headers must be serialized as an array of pairs.");
          }
          let result = new Request(url, init);
          if (init.body instanceof ReadableStream && result.body === void 0) {
            let promise = fixBrokenRequestBody(result, init.body);
            this.promises.push({ promise, parent, property });
            return promise;
          } else {
            return result;
          }
        }
        case "response": {
          if (value.length !== 3) break;
          let body = this.evaluateImpl(value[1], parent, property);
          if (body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream) ;
          else {
            throw new TypeError("Response body must be of type ReadableStream.");
          }
          let init = value[2];
          if (typeof init !== "object" || init === null) break;
          if (init.webSocket) {
            throw new TypeError("Can't deserialize a Response containing a webSocket.");
          }
          if (init.headers && !(init.headers instanceof Array)) {
            throw new TypeError("Request headers must be serialized as an array of pairs.");
          }
          return new Response(body, init);
        }
        case "blob": {
          if (value.length !== 3 || typeof value[1] !== "string") break;
          let contentType = value[1];
          let content = this.evaluateImpl(value[2], parent, property);
          if (!(content instanceof ReadableStream)) {
            throw new TypeError("Blob content must be serialized as a ReadableStream.");
          }
          let promise = streamToBlobPromise(content, contentType);
          this.promises.push({ promise, parent, property });
          return promise;
        }
        case "import":
        case "pipeline": {
          if (value.length < 2 || value.length > 4) {
            break;
          }
          if (typeof value[1] != "number") {
            break;
          }
          let hook = this.importer.getExport(value[1]);
          if (!hook) {
            throw new Error(`no such entry on exports table: ${value[1]}`);
          }
          let isPromise = value[0] == "pipeline";
          let addStub = /* @__PURE__ */ __name((hook2) => {
            if (isPromise) {
              let promise = new RpcPromise(hook2, []);
              this.promises.push({ promise, parent, property });
              return promise;
            } else {
              this.hooks.push(hook2);
              return new RpcPromise(hook2, []);
            }
          }, "addStub");
          if (value.length == 2) {
            if (isPromise) {
              return addStub(hook.get([]));
            } else {
              return addStub(hook.dup());
            }
          }
          let path = value[2];
          if (!(path instanceof Array)) {
            break;
          }
          if (!path.every(
            (part) => {
              return typeof part == "string" || typeof part == "number";
            }
          )) {
            break;
          }
          if (value.length == 3) {
            return addStub(hook.get(path));
          }
          let args = value[3];
          if (!(args instanceof Array)) {
            break;
          }
          let subEval = new _Evaluator(this.importer);
          args = subEval.evaluate([args]);
          return addStub(hook.call(path, args));
        }
        case "remap": {
          if (value.length !== 5 || typeof value[1] !== "number" || !(value[2] instanceof Array) || !(value[3] instanceof Array) || !(value[4] instanceof Array)) {
            break;
          }
          let hook = this.importer.getExport(value[1]);
          if (!hook) {
            throw new Error(`no such entry on exports table: ${value[1]}`);
          }
          let path = value[2];
          if (!path.every(
            (part) => {
              return typeof part == "string" || typeof part == "number";
            }
          )) {
            break;
          }
          let captures = value[3].map((cap) => {
            if (!(cap instanceof Array) || cap.length !== 2 || cap[0] !== "import" && cap[0] !== "export" || typeof cap[1] !== "number") {
              throw new TypeError(`unknown map capture: ${JSON.stringify(cap)}`);
            }
            if (cap[0] === "export") {
              return this.importer.importStub(cap[1]);
            } else {
              let exp = this.importer.getExport(cap[1]);
              if (!exp) {
                throw new Error(`no such entry on exports table: ${cap[1]}`);
              }
              return exp.dup();
            }
          });
          let instructions = value[4];
          let resultHook = hook.map(path, captures, instructions);
          let promise = new RpcPromise(resultHook, []);
          this.promises.push({ promise, parent, property });
          return promise;
        }
        case "export":
        case "promise":
          if (typeof value[1] == "number") {
            if (value[0] == "promise") {
              let hook = this.importer.importPromise(value[1]);
              let promise = new RpcPromise(hook, []);
              this.promises.push({ parent, property, promise });
              return promise;
            } else {
              let hook = this.importer.importStub(value[1]);
              this.hooks.push(hook);
              return new RpcStub(hook);
            }
          }
          break;
        case "writable":
          if (typeof value[1] == "number") {
            let hook = this.importer.importStub(value[1]);
            let stream = streamImpl.createWritableStreamFromHook(hook);
            this.hooks.push(hook);
            return stream;
          }
          break;
        case "readable":
          if (typeof value[1] == "number") {
            let stream = this.importer.getPipeReadable(value[1]);
            let hook = streamImpl.createReadableStreamHook(stream);
            this.hooks.push(hook);
            return stream;
          }
          break;
      }
      throw new TypeError(`unknown special value: ${JSON.stringify(value)}`);
    } else if (value instanceof Object) {
      let result = value;
      for (let key in result) {
        if (key in Object.prototype || key === "toJSON") {
          this.evaluateImpl(result[key], result, key);
          delete result[key];
        } else {
          result[key] = this.evaluateImpl(result[key], result, key);
        }
      }
      return result;
    } else {
      return value;
    }
  }
};
var currentMapBuilder;
var MapBuilder = class {
  static {
    __name(this, "MapBuilder");
  }
  context;
  captureMap = /* @__PURE__ */ new Map();
  instructions = [];
  constructor(subject, path) {
    if (currentMapBuilder) {
      this.context = {
        parent: currentMapBuilder,
        captures: [],
        subject: currentMapBuilder.capture(subject),
        path
      };
    } else {
      this.context = {
        parent: void 0,
        captures: [],
        subject,
        path
      };
    }
    currentMapBuilder = this;
  }
  unregister() {
    currentMapBuilder = this.context.parent;
  }
  makeInput() {
    return new MapVariableHook(this, 0);
  }
  makeOutput(result) {
    let devalued;
    try {
      devalued = Devaluator.devaluate(result.value, void 0, this, result);
    } finally {
      result.dispose();
    }
    this.instructions.push(devalued);
    if (this.context.parent) {
      this.context.parent.instructions.push(
        [
          "remap",
          this.context.subject,
          this.context.path,
          this.context.captures.map((cap) => ["import", cap]),
          this.instructions
        ]
      );
      return new MapVariableHook(this.context.parent, this.context.parent.instructions.length);
    } else {
      return this.context.subject.map(this.context.path, this.context.captures, this.instructions);
    }
  }
  pushCall(hook, path, params) {
    let devalued = Devaluator.devaluate(params.value, void 0, this, params);
    devalued = devalued[0];
    let subject = this.capture(hook.dup());
    this.instructions.push(["pipeline", subject, path, devalued]);
    return new MapVariableHook(this, this.instructions.length);
  }
  pushGet(hook, path) {
    let subject = this.capture(hook.dup());
    this.instructions.push(["pipeline", subject, path]);
    return new MapVariableHook(this, this.instructions.length);
  }
  capture(hook) {
    if (hook instanceof MapVariableHook && hook.mapper === this) {
      return hook.idx;
    }
    let result = this.captureMap.get(hook);
    if (result === void 0) {
      if (this.context.parent) {
        let parentIdx = this.context.parent.capture(hook);
        this.context.captures.push(parentIdx);
      } else {
        this.context.captures.push(hook);
      }
      result = -this.context.captures.length;
      this.captureMap.set(hook, result);
    }
    return result;
  }
  // ---------------------------------------------------------------------------
  // implements Exporter
  exportStub(hook) {
    throw new Error(
      "Can't construct an RpcTarget or RPC callback inside a mapper function. Try creating a new RpcStub outside the callback first, then using it inside the callback."
    );
  }
  exportPromise(hook) {
    return this.exportStub(hook);
  }
  getImport(hook) {
    return this.capture(hook);
  }
  unexport(ids) {
  }
  createPipe(readable) {
    throw new Error("Cannot send ReadableStream inside a mapper function.");
  }
  onSendError(error) {
  }
};
mapImpl.sendMap = (hook, path, func) => {
  let builder = new MapBuilder(hook, path);
  let result;
  try {
    result = RpcPayload.fromAppReturn(withCallInterceptor(builder.pushCall.bind(builder), () => {
      return func(new RpcPromise(builder.makeInput(), []));
    }));
  } finally {
    builder.unregister();
  }
  if (result instanceof Promise) {
    result.catch((err) => {
    });
    throw new Error("RPC map() callbacks cannot be async.");
  }
  return new RpcPromise(builder.makeOutput(result), []);
};
function throwMapperBuilderUseError() {
  throw new Error(
    "Attempted to use an abstract placeholder from a mapper function. Please make sure your map function has no side effects."
  );
}
__name(throwMapperBuilderUseError, "throwMapperBuilderUseError");
var MapVariableHook = class extends StubHook {
  static {
    __name(this, "MapVariableHook");
  }
  constructor(mapper, idx) {
    super();
    this.mapper = mapper;
    this.idx = idx;
  }
  // We don't have anything we actually need to dispose, so dup() can just return the same hook.
  dup() {
    return this;
  }
  dispose() {
  }
  get(path) {
    if (path.length == 0) {
      return this;
    } else if (currentMapBuilder) {
      return currentMapBuilder.pushGet(this, path);
    } else {
      throwMapperBuilderUseError();
    }
  }
  // Other methods should never be called.
  call(path, args) {
    throwMapperBuilderUseError();
  }
  map(path, captures, instructions) {
    throwMapperBuilderUseError();
  }
  pull() {
    throwMapperBuilderUseError();
  }
  ignoreUnhandledRejections() {
  }
  onBroken(callback) {
    throwMapperBuilderUseError();
  }
};
var MapApplicator = class {
  static {
    __name(this, "MapApplicator");
  }
  constructor(captures, input) {
    this.captures = captures;
    this.variables = [input];
  }
  variables;
  dispose() {
    for (let variable of this.variables) {
      variable.dispose();
    }
  }
  apply(instructions) {
    try {
      if (instructions.length < 1) {
        throw new Error("Invalid empty mapper function.");
      }
      for (let instruction of instructions.slice(0, -1)) {
        let payload = new Evaluator(this).evaluateCopy(instruction);
        if (payload.value instanceof RpcStub) {
          let hook = unwrapStubNoProperties(payload.value);
          if (hook) {
            this.variables.push(hook);
            continue;
          }
        }
        this.variables.push(new PayloadStubHook(payload));
      }
      return new Evaluator(this).evaluateCopy(instructions[instructions.length - 1]);
    } finally {
      for (let variable of this.variables) {
        variable.dispose();
      }
    }
  }
  importStub(idx) {
    throw new Error("A mapper function cannot refer to exports.");
  }
  importPromise(idx) {
    return this.importStub(idx);
  }
  getExport(idx) {
    if (idx < 0) {
      return this.captures[-idx - 1];
    } else {
      return this.variables[idx];
    }
  }
  getPipeReadable(exportId) {
    throw new Error("A mapper function cannot use pipe readables.");
  }
};
function applyMapToElement(input, parent, owner, captures, instructions) {
  let inputHook = new PayloadStubHook(RpcPayload.deepCopyFrom(input, parent, owner));
  let mapper = new MapApplicator(captures, inputHook);
  try {
    return mapper.apply(instructions);
  } finally {
    mapper.dispose();
  }
}
__name(applyMapToElement, "applyMapToElement");
mapImpl.applyMap = (input, parent, owner, captures, instructions) => {
  try {
    let result;
    if (input instanceof RpcPromise) {
      throw new Error("applyMap() can't be called on RpcPromise");
    } else if (input instanceof Array) {
      let payloads = [];
      try {
        for (let elem of input) {
          payloads.push(applyMapToElement(elem, input, owner, captures, instructions));
        }
      } catch (err) {
        for (let payload of payloads) {
          payload.dispose();
        }
        throw err;
      }
      result = RpcPayload.fromArray(payloads);
    } else if (input === null || input === void 0) {
      result = RpcPayload.fromAppReturn(input);
    } else {
      result = applyMapToElement(input, parent, owner, captures, instructions);
    }
    return new PayloadStubHook(result);
  } finally {
    for (let cap of captures) {
      cap.dispose();
    }
  }
};
var WritableStreamStubHook = class _WritableStreamStubHook extends StubHook {
  static {
    __name(this, "_WritableStreamStubHook");
  }
  state;
  // undefined when disposed
  // Creates a new WritableStreamStubHook that is not duplicated from an existing hook.
  static create(stream) {
    let writer = stream.getWriter();
    return new _WritableStreamStubHook({ refcount: 1, writer, closed: false });
  }
  constructor(state, dupFrom) {
    super();
    this.state = state;
    if (dupFrom) {
      ++state.refcount;
    }
  }
  getState() {
    if (this.state) {
      return this.state;
    } else {
      throw new Error("Attempted to use a WritableStreamStubHook after it was disposed.");
    }
  }
  call(path, args) {
    try {
      let state = this.getState();
      if (path.length !== 1 || typeof path[0] !== "string") {
        throw new Error("WritableStream stub only supports direct method calls");
      }
      const method = path[0];
      if (method !== "write" && method !== "close" && method !== "abort") {
        args.dispose();
        throw new Error(`Unknown WritableStream method: ${method}`);
      }
      if (method === "close" || method === "abort") {
        state.closed = true;
      }
      let func = state.writer[method];
      let promise = args.deliverCall(func, state.writer);
      return new PromiseStubHook(promise.then((payload) => new PayloadStubHook(payload)));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }
  map(path, captures, instructions) {
    for (let cap of captures) {
      cap.dispose();
    }
    return new ErrorStubHook(new Error("Cannot use map() on a WritableStream"));
  }
  get(path) {
    return new ErrorStubHook(new Error("Cannot access properties on a WritableStream stub"));
  }
  dup() {
    let state = this.getState();
    return new _WritableStreamStubHook(state, this);
  }
  pull() {
    return Promise.reject(new Error("Cannot pull a WritableStream stub"));
  }
  ignoreUnhandledRejections() {
  }
  dispose() {
    let state = this.state;
    this.state = void 0;
    if (state) {
      if (--state.refcount === 0) {
        if (!state.closed) {
          state.writer.abort(new Error("WritableStream RPC stub was disposed without calling close()")).catch(() => {
          });
        }
        state.writer.releaseLock();
      }
    }
  }
  onBroken(callback) {
  }
};
var INITIAL_WINDOW = 256 * 1024;
var MAX_WINDOW = 1024 * 1024 * 1024;
var MIN_WINDOW = 64 * 1024;
var STARTUP_GROWTH_FACTOR = 2;
var STEADY_GROWTH_FACTOR = 1.25;
var DECAY_FACTOR = 0.9;
var STARTUP_EXIT_ROUNDS = 3;
var FlowController = class {
  static {
    __name(this, "FlowController");
  }
  constructor(now) {
    this.now = now;
  }
  // The current window size in bytes. The sender blocks when bytesInFlight >= window.
  window = INITIAL_WINDOW;
  // Total bytes currently in flight (sent but not yet acked).
  bytesInFlight = 0;
  // Whether we're still in the startup phase.
  inStartupPhase = true;
  // ----- BDP estimation state (private) -----
  // Total bytes acked so far.
  delivered = 0;
  // Time of most recent ack.
  deliveredTime = 0;
  // Time when the very first ack was received.
  firstAckTime = 0;
  firstAckDelivered = 0;
  // Global minimum RTT observed (milliseconds).
  minRtt = Infinity;
  // For startup exit: count of consecutive RTT rounds where the window didn't meaningfully grow.
  roundsWithoutIncrease = 0;
  // Window size at the start of the current round, for startup exit detection.
  lastRoundWindow = 0;
  // Time when the current round started.
  roundStartTime = 0;
  // Called when a write of `size` bytes is about to be sent. Returns a token that must be
  // passed to onAck() when the ack arrives, and whether the sender should block (window full).
  onSend(size) {
    this.bytesInFlight += size;
    let token = {
      sentTime: this.now(),
      size,
      deliveredAtSend: this.delivered,
      deliveredTimeAtSend: this.deliveredTime,
      windowAtSend: this.window,
      windowFullAtSend: this.bytesInFlight >= this.window
    };
    return { token, shouldBlock: token.windowFullAtSend };
  }
  // Called when a previously-sent write fails. Restores bytesInFlight without updating
  // any BDP estimates.
  onError(token) {
    this.bytesInFlight -= token.size;
  }
  // Called when an ack is received for a previously-sent write. Updates BDP estimates and
  // the window. Returns whether a blocked sender should now unblock.
  onAck(token) {
    let ackTime = this.now();
    this.delivered += token.size;
    this.deliveredTime = ackTime;
    this.bytesInFlight -= token.size;
    let rtt = ackTime - token.sentTime;
    this.minRtt = Math.min(this.minRtt, rtt);
    if (this.firstAckTime === 0) {
      this.firstAckTime = ackTime;
      this.firstAckDelivered = this.delivered;
    } else {
      let baseTime;
      let baseDelivered;
      if (token.deliveredTimeAtSend === 0) {
        baseTime = this.firstAckTime;
        baseDelivered = this.firstAckDelivered;
      } else {
        baseTime = token.deliveredTimeAtSend;
        baseDelivered = token.deliveredAtSend;
      }
      let interval = ackTime - baseTime;
      let bytes = this.delivered - baseDelivered;
      let bandwidth = bytes / interval;
      let growthFactor = this.inStartupPhase ? STARTUP_GROWTH_FACTOR : STEADY_GROWTH_FACTOR;
      let newWindow = bandwidth * this.minRtt * growthFactor;
      newWindow = Math.min(newWindow, token.windowAtSend * growthFactor);
      if (token.windowFullAtSend) {
        newWindow = Math.max(newWindow, token.windowAtSend * DECAY_FACTOR);
      } else {
        newWindow = Math.max(newWindow, this.window);
      }
      this.window = Math.max(Math.min(newWindow, MAX_WINDOW), MIN_WINDOW);
      if (this.inStartupPhase && token.sentTime >= this.roundStartTime) {
        if (this.window > this.lastRoundWindow * STEADY_GROWTH_FACTOR) {
          this.roundsWithoutIncrease = 0;
        } else {
          if (++this.roundsWithoutIncrease >= STARTUP_EXIT_ROUNDS) {
            this.inStartupPhase = false;
          }
        }
        this.roundStartTime = ackTime;
        this.lastRoundWindow = this.window;
      }
    }
    return this.bytesInFlight < this.window;
  }
};
function createWritableStreamFromHook(hook) {
  let pendingError = void 0;
  let hookDisposed = false;
  let fc = new FlowController(() => performance.now());
  let windowResolve;
  let windowReject;
  const disposeHook = /* @__PURE__ */ __name(() => {
    if (!hookDisposed) {
      hookDisposed = true;
      hook.dispose();
    }
  }, "disposeHook");
  return new WritableStream({
    write(chunk, controller) {
      if (pendingError !== void 0) {
        throw pendingError;
      }
      const payload = RpcPayload.fromAppParams([chunk]);
      const { promise, size } = hook.stream(["write"], payload);
      if (size === void 0) {
        return promise.catch((err) => {
          if (pendingError === void 0) {
            pendingError = err;
          }
          throw err;
        });
      } else {
        let { token, shouldBlock } = fc.onSend(size);
        promise.then(() => {
          let hasCapacity = fc.onAck(token);
          if (hasCapacity && windowResolve) {
            windowResolve();
            windowResolve = void 0;
            windowReject = void 0;
          }
        }, (err) => {
          fc.onError(token);
          if (pendingError === void 0) {
            pendingError = err;
            controller.error(err);
            disposeHook();
          }
          if (windowReject) {
            windowReject(err);
            windowResolve = void 0;
            windowReject = void 0;
          }
        });
        if (shouldBlock) {
          return new Promise((resolve, reject) => {
            windowResolve = resolve;
            windowReject = reject;
          });
        }
      }
    },
    async close() {
      if (pendingError !== void 0) {
        disposeHook();
        throw pendingError;
      }
      const { promise } = hook.stream(["close"], RpcPayload.fromAppParams([]));
      try {
        await promise;
      } catch (err) {
        throw pendingError ?? err;
      } finally {
        disposeHook();
      }
    },
    abort(reason) {
      if (pendingError !== void 0) {
        return;
      }
      pendingError = reason ?? new Error("WritableStream was aborted");
      if (windowReject) {
        windowReject(pendingError);
        windowResolve = void 0;
        windowReject = void 0;
      }
      const { promise } = hook.stream(["abort"], RpcPayload.fromAppParams([reason]));
      promise.then(() => disposeHook(), () => disposeHook());
    }
  });
}
__name(createWritableStreamFromHook, "createWritableStreamFromHook");
var ReadableStreamStubHook = class _ReadableStreamStubHook extends StubHook {
  static {
    __name(this, "_ReadableStreamStubHook");
  }
  state;
  // undefined when disposed
  // Creates a new ReadableStreamStubHook.
  static create(stream) {
    return new _ReadableStreamStubHook({ refcount: 1, stream, canceled: false });
  }
  constructor(state, dupFrom) {
    super();
    this.state = state;
    if (dupFrom) {
      ++state.refcount;
    }
  }
  call(path, args) {
    args.dispose();
    return new ErrorStubHook(new Error("Cannot call methods on a ReadableStream stub"));
  }
  map(path, captures, instructions) {
    for (let cap of captures) {
      cap.dispose();
    }
    return new ErrorStubHook(new Error("Cannot use map() on a ReadableStream"));
  }
  get(path) {
    return new ErrorStubHook(new Error("Cannot access properties on a ReadableStream stub"));
  }
  dup() {
    let state = this.state;
    if (!state) {
      throw new Error("Attempted to dup a ReadableStreamStubHook after it was disposed.");
    }
    return new _ReadableStreamStubHook(state, this);
  }
  pull() {
    return Promise.reject(new Error("Cannot pull a ReadableStream stub"));
  }
  ignoreUnhandledRejections() {
  }
  dispose() {
    let state = this.state;
    this.state = void 0;
    if (state) {
      if (--state.refcount === 0) {
        if (!state.canceled) {
          state.canceled = true;
          if (!state.stream.locked) {
            state.stream.cancel(
              new Error("ReadableStream RPC stub was disposed without being consumed")
            ).catch(() => {
            });
          }
        }
      }
    }
  }
  onBroken(callback) {
  }
};
streamImpl.createWritableStreamHook = WritableStreamStubHook.create;
streamImpl.createWritableStreamFromHook = createWritableStreamFromHook;
streamImpl.createReadableStreamHook = ReadableStreamStubHook.create;
var RpcTarget4 = RpcTarget;

// ../../packages/capnweb-validate/dist/index.mjs
var newWorkersRpcResponse = uncompiledMarker;
function uncompiledMarker() {
  throw new Error("capnweb-validate marker API was called before it was transformed. Configure the capnweb-validate bundler plugin or run the capnweb-validate CLI.");
}
__name(uncompiledMarker, "uncompiledMarker");

// server/validation/worker.ts
var sleep = /* @__PURE__ */ __name((ms) => new Promise((r) => setTimeout(r, ms)), "sleep");
var jittered = /* @__PURE__ */ __name((base, jitter) => base + (jitter ? Math.random() * jitter : 0), "jittered");
var USERS = /* @__PURE__ */ new Map([
  ["cookie-123", { id: "u_1", name: "Ada Lovelace" }],
  ["cookie-456", { id: "u_2", name: "Alan Turing" }]
]);
var PROFILES = /* @__PURE__ */ new Map([
  ["u_1", { id: "u_1", bio: "Mathematician & first programmer" }],
  ["u_2", { id: "u_2", bio: "Mathematician & CS pioneer" }]
]);
var NOTIFICATIONS = /* @__PURE__ */ new Map([
  ["u_1", ["Welcome to Cap'n Web!", "You have 2 new followers"]],
  ["u_2", ["New feature: pipelining!", "Security tips for your account"]]
]);
var Api = class extends RpcTarget4 {
  constructor(env) {
    super();
    this.env = env;
  }
  static {
    __name(this, "Api");
  }
  async authenticate(sessionToken) {
    await sleep(Number(this.env.DELAY_AUTH_MS ?? 80));
    const user = USERS.get(sessionToken);
    if (!user) throw new Error("Invalid session");
    return user;
  }
  async getUserProfile(userId) {
    await sleep(Number(this.env.DELAY_PROFILE_MS ?? 120));
    const profile = PROFILES.get(userId);
    if (!profile) throw new Error("No such user");
    return profile;
  }
  async getNotifications(userId) {
    await sleep(Number(this.env.DELAY_NOTIFS_MS ?? 120));
    return NOTIFICATIONS.get(userId) ?? [];
  }
};
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname === "/api") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
          Vary: "Origin"
        }
      });
    }
    if (url.pathname === "/api") {
      const rttBase = Number(env.SIMULATED_RTT_MS ?? 0);
      const rttJitter = Number(env.SIMULATED_RTT_JITTER_MS ?? 0);
      if (rttBase || rttJitter) await sleep(jittered(rttBase, rttJitter));
      const resp = await newWorkersRpcResponse(request, new Api(env));
      if (rttBase || rttJitter) await sleep(jittered(rttBase, rttJitter));
      const headers = new Headers(resp.headers);
      const origin = request.headers.get("Origin");
      if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Vary", "Origin");
      }
      return new Response(resp.body, { status: resp.status, headers });
    }
    return new Response("Not found", { status: 404 });
  }
};
export {
  Api,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
