// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { StubHook, RpcPayload, typeForRpc, RpcStub, RpcPromise, LocatedPromise, RpcTarget, unwrapStubAndPath, streamImpl, PromiseStubHook, PayloadStubHook } from "./core.js";

export type ImportId = number;
export type ExportId = number;

// =======================================================================================

export interface Exporter {
  exportStub(hook: StubHook): ExportId;
  exportPromise(hook: StubHook): ExportId;
  getImport(hook: StubHook): ImportId | undefined;

  // If a serialization error occurs after having exported some capabilities, this will be called
  // to roll back the exports.
  unexport(ids: Array<ExportId>): void;

  // Creates a pipe by sending a ["pipe"] message, then starts pumping the given ReadableStream
  // into the pipe's writable end. Returns the import ID assigned to the pipe. `hook` should be
  // disposed when the pipe finishes.
  createPipe(readable: ReadableStream, hook: StubHook): ImportId;

  onSendError(error: Error): Error | void;
}

class NullExporter implements Exporter {
  exportStub(stub: StubHook): never {
    throw new Error("Cannot serialize RPC stubs without an RPC session.");
  }
  exportPromise(stub: StubHook): never {
    throw new Error("Cannot serialize RPC stubs without an RPC session.");
  }
  getImport(hook: StubHook): ImportId | undefined {
    return undefined;
  }
  unexport(ids: Array<ExportId>): void {}
  createPipe(readable: ReadableStream): never {
    throw new Error("Cannot create pipes without an RPC session.");
  }

  onSendError(error: Error): Error | void {}
}

const NULL_EXPORTER = new NullExporter();

// Maps error name to error class for deserialization.
const ERROR_TYPES: Record<string, any> = {
  Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError,
  // TODO: DOMError? Others?
};

// Polyfill type for UInt8Array.toBase64(), which has started landing in JS runtimes but is not
// supported everywhere just yet.
interface Uint8Array {
  toBase64?(options?: {
    alphabet?: "base64" | "base64url",
    omitPadding?: boolean
  }): string;
};

interface FromBase64 {
  fromBase64?(text: string, options?: {
    alphabet?: "base64" | "base64url",
    lastChunkHandling?: "loose" | "strict" | "stop-before-partial"
  }): Uint8Array;
}

// Converts fully-hydrated messages into object trees that are JSON-serializable for sending over
// the wire. This is used to implement serialization -- but it doesn't take the last step of
// actually converting to a string. (The name is meant to be the opposite of "Evaluator", which
// implements the opposite direction.)
export class Devaluator {
  private constructor(private exporter: Exporter, private source: RpcPayload | undefined) {}

  // Devaluate the given value.
  // * value: The value to devaluate.
  // * parent: The value's parent object, which would be used as `this` if the value were called
  //     as a function.
  // * exporter: Callbacks to the RPC session for exporting capabilities found in this message.
  // * source: The RpcPayload which contains the value, and therefore owns stubs within.
  //
  // Returns: The devaluated value, ready to be JSON-serialized.
  public static devaluate(
      value: unknown, parent?: object, exporter: Exporter = NULL_EXPORTER, source?: RpcPayload)
      : unknown {
    let devaluator = new Devaluator(exporter, source);
    try {
      return devaluator.devaluateImpl(value, parent, 0);
    } catch (err) {
      if (devaluator.exports) {
        try {
          exporter.unexport(devaluator.exports);
        } catch (err) {
          // probably a side effect of the original error, ignore it
        }
      }
      throw err;
    }
  }

  private exports?: Array<ExportId>;

  private devaluateImpl(value: unknown, parent: object | undefined, depth: number): unknown {
    if (depth >= 64) {
      throw new Error(
          "Serialization exceeded maximum allowed depth. (Does the message contain cycles?)");
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
          // Supported directly by JSON.
          return value;
        }

      case "object": {
        let object = <Record<string, unknown>>value;
        let result: Record<string, unknown> = {};
        for (let key in object) {
          result[key] = this.devaluateImpl(object[key], object, depth + 1);
        }
        return result;
      }

      case "array": {
        let array = <Array<unknown>>value;
        let len = array.length;
        let result = new Array(len);
        for (let i = 0; i < len; i++) {
          result[i] = this.devaluateImpl(array[i], array, depth + 1);
        }
        // Wrap literal arrays in an outer one-element array, to "escape" them.
        return [result];
      }

      case "bigint":
        return ["bigint", (<bigint>value).toString()];

      case "date":
        return ["date", (<Date>value).getTime()];

      case "bytes": {
        let bytes = value as Uint8Array;
        if (bytes.toBase64) {
          return ["bytes", bytes.toBase64({omitPadding: true})];
        } else {
          return ["bytes",
              btoa(String.fromCharCode.apply(null, bytes as number[]).replace(/=*$/, ""))];
        }
      }

      case "headers":
        // The `Headers` TS type apparently doesn't declare itself as being
        // Iterable<[string, string]>, but it is.
        return ["headers", [...<Iterable<[string, string]>>value]];

      case "request": {
        let req = <Request>value;
        let init: Record<string, unknown> = {};

        // For many properties below, the official Fetch spec says they must always be present,
        // but some platforms don't support them. So, we check both whether the property exists,
        // and whether it is equal to the default, before bothering to add it to `init`.

        if (req.method !== "GET") init.method = req.method;

        let headers = [...<Iterable<[string, string]>><any>req.headers];
        if (headers.length > 0) {
          // Note that we don't need to serialize this as ["headers", headers] because we are only
          // trying to create a valid RequestInit object.
          init.headers = headers;
        }

        if (req.body) {
          init.body = this.devaluateImpl(req.body, req, depth + 1);

          // Apparently the fetch spec technically requires that `duplex` be specified when a
          // body is specified, and Chrome in fact requires this, and requires the value is "half".
          // Workers hasn't implemented this (and actually supports full duplex by default, lol).
          // The TS types for Request currently don't define this property, but it is there (on
          // Chrome at least).
          init.duplex = (<any>req).duplex || "half";
        } else if (req.body === undefined &&
            !["GET", "HEAD", "OPTIONS", "TRACE", "DELETE"].includes(req.method)) {
          // If the body is undefined rather than null, most likely we're on a platform that
          // doesn't support request body streams (*cough*Firefox*cough*). We'll need to hack
          // around this by using `req.arrayBuffer()` to get the body. Unfortunately this is async,
          // so we can't just embed the resulting body into the message we are constructing. We
          // will actually have to construct a ReadableStream. Ugh!

          let bodyPromise = req.arrayBuffer();

          let readable = new ReadableStream<Uint8Array>({
            async start(controller) {
              try {
                // `as Uint8Array` is needed here to work around some sort of weird bug in the TS
                // types where `new Uint8Array` somehow doesn't return a `Uint8Array`. Instead it
                // somehow returns `Uint8Array<ArrayBuffer>` -- but `Uint8Array` is not a generic
                // type! WTF?
                controller.enqueue(new Uint8Array(await bodyPromise) as Uint8Array);
                controller.close();
              } catch (err) {
                controller.error(err);
              }
            }
          });

          // We can't recurse to devaluateImpl() to serialize the body because it'll call
          // source.getHookForReadableStream(), adding a hook on the payload which isn't actually
          // reachable by walking the payload, which will cause trouble later. So we have to
          // inline it a bit here...
          let hook = streamImpl.createReadableStreamHook(readable);
          let importId = this.exporter.createPipe(readable, hook);
          init.body = ["readable", importId];
          init.duplex = (<any>req).duplex || "half";
        }

        if (req.cache && req.cache !== "default") init.cache = req.cache;
        if (req.redirect !== "follow") init.redirect = req.redirect;
        if (req.integrity) init.integrity = req.integrity;

        // These properties are only meaningful in browsers and not supported by most WinterCG
        // (server-side) platforms.
        if (req.mode && req.mode !== "cors") init.mode = req.mode;
        if (req.credentials && req.credentials !== "same-origin") {
          init.credentials = req.credentials;
        }
        if (req.referrer && req.referrer !== "about:client") init.referrer = req.referrer;
        if (req.referrerPolicy) init.referrerPolicy = req.referrerPolicy;
        if (req.keepalive) init.keepalive = req.keepalive;

        // These properties are specific to Cloudflare Workers. Cast the request to `any` to
        // silence type errors on other platforms.
        let cfReq = req as any;
        if (cfReq.cf) init.cf = cfReq.cf;
        if (cfReq.encodeResponseBody && cfReq.encodeResponseBody !== "automatic") {
          init.encodeResponseBody = cfReq.encodeResponseBody;
        }

        // TODO: Support request.signal. Annoyingly, all `Request`s have a `signal` property even
        //   if none was passed to the constructor, and there's no way to tell if it's a real
        //   signal. So for now, since we don't support AbortSignal yet, all we can do is ignore
        //   it; we can't throw an error if it's present.

        return ["request", req.url, init];
      }

      case "response": {
        let resp = <Response>value;
        let body = this.devaluateImpl(resp.body, resp, depth + 1);
        let init: Record<string, unknown> = {};

        if (resp.status !== 200) init.status = resp.status;
        if (resp.statusText) init.statusText = resp.statusText;

        let headers = [...<Iterable<[string, string]>><any>resp.headers];
        if (headers.length > 0) {
          // Note that we don't need to serialize this as ["headers", headers] because we are only
          // trying to create a valid ResponseInit object.
          init.headers = headers;
        }

        // These properties are specific to Cloudflare Workers. Cast the request to `any` to
        // silence type errors on other platforms.
        let cfResp = resp as any;
        if (cfResp.cf) init.cf = cfResp.cf;
        if (cfResp.encodeBody && cfResp.encodeBody !== "automatic") {
          init.encodeBody = cfResp.encodeBody;
        }
        if (cfResp.webSocket) {
          // As of this writing, we don't support WebSocket, but we might someday.
          throw new TypeError("Can't serialize a Response containing a webSocket.");
        }

        return ["response", body, init];
      }

      case "error": {
        let e = <Error>value;

        // TODO:
        // - Determine type by checking prototype rather than `name`, which can be overridden?
        // - Serialize cause / suppressed error / etc.
        // - Serialize added properties.

        let rewritten = this.exporter.onSendError(e);
        if (rewritten) {
          e = rewritten;
        }

        let result = ["error", e.name, e.message];
        if (rewritten && rewritten.stack) {
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

        let {hook, pathIfPromise} = unwrapStubAndPath(<RpcStub>value);
        let importId = this.exporter.getImport(hook);
        if (importId !== undefined) {
          if (pathIfPromise) {
            // It's a promise pointing back to the peer, so we are doing pipelining here.
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

        let hook = this.source.getHookForRpcTarget(<RpcTarget|Function>value, parent);
        return this.devaluateHook("export", hook);
      }

      case "rpc-thenable": {
        if (!this.source) {
          throw new Error("Can't serialize RPC stubs in this context.");
        }

        let hook = this.source.getHookForRpcTarget(<RpcTarget>value, parent);
        return this.devaluateHook("promise", hook);
      }

      case "writable": {
        if (!this.source) {
          throw new Error("Can't serialize WritableStream in this context.");
        }

        let hook = this.source.getHookForWritableStream(<WritableStream>value, parent);
        return this.devaluateHook("writable", hook);
      }

      case "readable": {
        if (!this.source) {
          throw new Error("Can't serialize ReadableStream in this context.");
        }

        let ws = <ReadableStream>value;
        let hook = this.source.getHookForReadableStream(ws, parent);

        // Create a pipe and start pumping the ReadableStream into it.
        let importId = this.exporter.createPipe(ws, hook);

        return ["readable", importId];
      }

      default:
        kind satisfies never;
        throw new Error("unreachable");
    }
  }

  private devaluateHook(type: "export" | "promise" | "writable", hook: StubHook): unknown {
    if (!this.exports) this.exports = [];
    let exportId = type === "promise" ? this.exporter.exportPromise(hook)
                                      : this.exporter.exportStub(hook);
    this.exports.push(exportId);
    return [type, exportId];
  }
}

/**
 * Serialize a value, using Cap'n Web's underlying serialization. This won't be able to serialize
 * RPC stubs, but it will support basic data types.
 */
export function serialize(value: unknown): string {
  return JSON.stringify(Devaluator.devaluate(value));
}

// =======================================================================================

export interface Importer {
  importStub(idx: ImportId): StubHook;
  importPromise(idx: ImportId): StubHook;
  getExport(idx: ExportId): StubHook | undefined;

  // Retrieves the ReadableStream end of a pipe created by a ["pipe"] message.
  // The exportId must refer to an export that was created as a pipe.
  // This can only be called once per pipe.
  getPipeReadable(exportId: ExportId): ReadableStream;
}

class NullImporter implements Importer {
  importStub(idx: ImportId): never {
    throw new Error("Cannot deserialize RPC stubs without an RPC session.");
  }
  importPromise(idx: ImportId): never {
    throw new Error("Cannot deserialize RPC stubs without an RPC session.");
  }
  getExport(idx: ExportId): StubHook | undefined {
    return undefined;
  }
  getPipeReadable(exportId: ExportId): never {
    throw new Error("Cannot retrieve pipe readable without an RPC session.");
  }
}

const NULL_IMPORTER = new NullImporter();

// Some runtimes (Firefox) don't support `request.body` as a stream, but we receive request bodies
// as streams. We'll need to read the body into an ArrayBuffer and recreate the request. This is
// asynchronous, so we'll have to swap in a promise here. This potentially breaks e-order but
// that's something people will just have to live with when sending a Request to a Firefox
// endpoint (probably rare).
function fixBrokenRequestBody(request: Request, body: ReadableStream): RpcPromise {
  // Reuse built-in code to read the stream into an array.
  let promise = new Response(body).arrayBuffer().then(arrayBuffer => {
    let bytes = new Uint8Array(arrayBuffer);
    let result = new Request(request, {body: bytes});
    return new PayloadStubHook(RpcPayload.fromAppReturn(result));
  });
  return new RpcPromise(new PromiseStubHook(promise), []);
}

// Takes object trees parse from JSON and converts them into fully-hydrated JavaScript objects for
// delivery to the app. This is used to implement deserialization, except that it doesn't actually
// start from a raw string.
export class Evaluator {
  constructor(private importer: Importer) {}

  private hooks: StubHook[] = [];
  private promises: LocatedPromise[] = [];

  public evaluate(value: unknown): RpcPayload {
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
  public evaluateCopy(value: unknown): RpcPayload {
    return this.evaluate(structuredClone(value));
  }

  private evaluateImpl(value: unknown, parent: object, property: string | number): unknown {
    if (value instanceof Array) {
      if (value.length == 1 && value[0] instanceof Array) {
        // Escaped array. Evaluate the contents.
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
          if (typeof value[1] == "number") {
            return new Date(value[1]);
          }
          break;
        case "bytes": {
          let b64 = Uint8Array as FromBase64;
          if (typeof value[1] == "string") {
            if (b64.fromBase64) {
              return b64.fromBase64(value[1]);
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
            let result = new cls(value[2]);
            if (typeof value[3] === "string") {
              result.stack = value[3];
            }
            return result;
          }
          break;
        case "undefined":
          if (value.length === 1) {
            return undefined;
          }
          break;
        case "inf":
          return Infinity;
        case "-inf":
          return -Infinity;
        case "nan":
          return NaN;

        case "headers":
          // We only need to validate that the parameter is an array, so as not to invoke an
          // unexpected variant of the Headers constructor. So long as it is an array then we can
          // rely on the constructor to perform type checking.
          if (value.length === 2 && value[1] instanceof Array) {
            return new Headers(value[1] as [string, string][]);
          }
          break;

        case "request": {
          if (value.length !== 3 || typeof value[1] !== "string") break;
          let url = value[1] as string;
          let init = value[2];
          if (typeof init !== "object" || init === null) break;

          // Evaluate specific properties which are expected to contain non-trivial types.
          if (init.body) {
            init.body = this.evaluateImpl(init.body, init, "body");
            if (init.body === null ||
                typeof init.body === "string" ||
                init.body instanceof Uint8Array ||
                init.body instanceof ReadableStream) {
              // Acceptable types.
            } else {
              throw new TypeError("Request body must be of type ReadableStream.");
            }
          }
          if (init.signal) {
            init.signal = this.evaluateImpl(init.signal, init, "signal");
            if (!(init.signal instanceof AbortSignal)) {
              throw new TypeError("Request siganl must be of type AbortSignal.");
            }
          }

          // Type-check `headers` is an array because the constructor allows multiple
          // representations and we don't want to allow the others.
          if (init.headers && !(init.headers instanceof Array)) {
            throw new TypeError("Request headers must be serialized as an array of pairs.");
          }

          // We assume the `Request` constructor can type-check the remaining properties.
          let result = new Request(url, init as RequestInit);

          if (init.body instanceof ReadableStream && result.body === undefined) {
            // Oh no! We must be on Firefox where request bodies are not supported, but we had a
            // body.
            let promise = fixBrokenRequestBody(result, init.body);
            this.promises.push({promise, parent, property});
            return promise;
          } else {
            return result;
          }
        }

        case "response": {
          if (value.length !== 3) break;

          let body = this.evaluateImpl(value[1], parent, property);
          if (body === null ||
              typeof body === "string" ||
              body instanceof Uint8Array ||
              body instanceof ReadableStream) {
            // Acceptable types.
          } else {
            throw new TypeError("Response body must be of type ReadableStream.");
          }

          let init = value[2];
          if (typeof init !== "object" || init === null) break;

          // Evaluate specific properties which are expected to contain non-trivial types.
          if (init.webSocket) {
            // `response.webSocket` is a Cloudflare Workers extension. Not (yet?) supported for
            // serialization.
            throw new TypeError("Can't deserialize a Response containing a webSocket.");
          }

          // Type-check `headers` is an array because the constructor allows multiple
          // representations and we don't want to allow the others.
          if (init.headers && !(init.headers instanceof Array)) {
            throw new TypeError("Request headers must be serialized as an array of pairs.");
          }

          return new Response(body as BodyInit | null, init as ResponseInit);
        }

        case "import":
        case "pipeline": {
          // It's an "import" from the perspective of the sender, so it's an export from our
          // side. In other words, the sender is passing our own object back to us.

          if (value.length < 2 || value.length > 4) {
            break;   // report error below
          }

          // First parameter is import ID (from the sender's perspective, so export ID from
          // ours).
          if (typeof value[1] != "number") {
            break;   // report error below
          }

          let hook = this.importer.getExport(value[1]);
          if (!hook) {
            throw new Error(`no such entry on exports table: ${value[1]}`);
          }

          let isPromise = value[0] == "pipeline";

          let addStub = (hook: StubHook) => {
            if (isPromise) {
              let promise = new RpcPromise(hook, []);
              this.promises.push({promise, parent, property});
              return promise;
            } else {
              this.hooks.push(hook);
              return new RpcPromise(hook, []);
            }
          };

          if (value.length == 2) {
            // Just referencing the export itself.
            if (isPromise) {
              // We need to use hook.get([]) to make sure we get a promise hook.
              return addStub(hook.get([]));
            } else {
              // dup() returns a stub hook.
              return addStub(hook.dup());
            }
          }

          // Second parameter, if given, is a property path.
          let path = value[2];
          if (!(path instanceof Array)) {
            break;  // report error below
          }
          if (!path.every(
              part => { return typeof part == "string" || typeof part == "number"; })) {
            break;  // report error below
          }

          if (value.length == 3) {
            // Just referencing the path, not a call.
            return addStub(hook.get(path));
          }

          // Third parameter, if given, is call arguments. The sender has identified a function
          // and wants us to call it.
          //
          // Usually this is used with "pipeline", in which case we evaluate to an
          // RpcPromise. However, this can be used with "import", in which case the caller is
          // asking that the result be coerced to RpcStub. This distinction matters if the
          // result of this evaluation is to be passed as arguments to another call -- promises
          // must be resolved in advance, but stubs can be passed immediately.
          let args = value[3];
          if (!(args instanceof Array)) {
            break;  // report error below
          }

          // We need a new evaluator for the args, to build a separate payload.
          let subEval = new Evaluator(this.importer);
          args = subEval.evaluate([args]);

          return addStub(hook.call(path, args));
        }

        case "remap": {
          if (value.length !== 5 ||
              typeof value[1] !== "number" ||
              !(value[2] instanceof Array) ||
              !(value[3] instanceof Array) ||
              !(value[4] instanceof Array)) {
            break;   // report error below
          }

          let hook = this.importer.getExport(value[1]);
          if (!hook) {
            throw new Error(`no such entry on exports table: ${value[1]}`);
          }

          let path = value[2];
          if (!path.every(
              part => { return typeof part == "string" || typeof part == "number"; })) {
            break;  // report error below
          }

          let captures: StubHook[] = value[3].map(cap => {
            if (!(cap instanceof Array) ||
                cap.length !== 2 ||
                (cap[0] !== "import" && cap[0] !== "export") ||
                typeof cap[1] !== "number") {
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
          this.promises.push({promise, parent, property});
          return promise;
        }

        case "export":
        case "promise":
          // It's an "export" from the perspective of the sender, i.e. they sent us a new object
          // which we want to import.
          //
          // "promise" is same as "export" but should not be delivered to the application. If any
          // promises appear in a value, they must be resolved and substituted with their results
          // before delivery. Note that if the value being evaluated appeared in call params, or
          // appeared in a resolve message for a promise that is being pulled, then the new promise
          // is automatically also being pulled, otherwise it is not.
          if (typeof value[1] == "number") {
            if (value[0] == "promise") {
              let hook = this.importer.importPromise(value[1]);
              let promise = new RpcPromise(hook, []);
              this.promises.push({parent, property, promise});
              return promise;
            } else {
              let hook = this.importer.importStub(value[1]);
              this.hooks.push(hook);
              return new RpcStub(hook);
            }
          }
          break;

        case "writable":
          // It's a WritableStream export from the sender. We import it and create a proxy
          // WritableStream that forwards writes to the remote end.
          if (typeof value[1] == "number") {
            let hook = this.importer.importStub(value[1]);
            let stream = streamImpl.createWritableStreamFromHook(hook);
            // Track the stream for disposal.
            this.hooks.push(hook);
            return stream;
          }
          break;

        case "readable":
          // References the readable end of a pipe. The import ID (from the sender's perspective)
          // is our export ID.
          if (typeof value[1] == "number") {
            let stream = this.importer.getPipeReadable(value[1]);
            // Track the stream for disposal so that if the payload is disposed before the
            // app reads the stream, the ReadableStream is properly canceled.
            let hook = streamImpl.createReadableStreamHook(stream);
            this.hooks.push(hook);
            return stream;
          }
          break;
      }
      throw new TypeError(`unknown special value: ${JSON.stringify(value)}`);
    } else if (value instanceof Object) {
      let result = <Record<string, unknown>>value;
      for (let key in result) {
        if (key in Object.prototype || key === "toJSON") {
          // Out of an abundance of caution, we will ignore properties that override properties
          // of Object.prototype. It's especially important that we don't allow `__proto__` as it
          // may lead to prototype pollution. We also would rather not allow, e.g., `toString()`,
          // as overriding this could lead to various mischief.
          //
          // We also block `toJSON()` for similar reasons -- even though Object.prototype doesn't
          // actually define it, `JSON.stringify()` treats it specially and we don't want someone
          // snooping on JSON calls.
          //
          // We do still evaluate the inner value so that we can properly release any stubs.
          this.evaluateImpl(result[key], result, key);
          delete result[key];
        } else {
          result[key] = this.evaluateImpl(result[key], result, key);
        }
      }
      return result;
    } else {
      // Other JSON types just pass through.
      return value;
    }
  }
}

/**
 * Deserialize a value serialized using serialize().
 */
export function deserialize(value: string): unknown {
  let payload = new Evaluator(NULL_IMPORTER).evaluate(JSON.parse(value));
  payload.dispose();  // should be no-op but just in case
  return payload.value;
}
