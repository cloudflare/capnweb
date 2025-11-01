// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { StubHook, RpcPayload, typeForRpc, RpcStub, RpcPromise, LocatedPromise, RpcTarget, PropertyPath, unwrapStubAndPath } from "./core.js";

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
        // Supported directly by JSON.
        return value;

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

      case "special-number": {
        let num = value as number;
        if (Number.isNaN(num)) {
          return ["special-number", "NaN"];
        } else if (num === Infinity) {
          return ["special-number", "Infinity"];
        } else if (num === -Infinity) {
          return ["special-number", "-Infinity"];
        }
        // Should not happen if typeForRpc is correct - fall through to default case
        break;
      }

      case "regexp": {
        let re = value as RegExp;
        return ["regexp", { source: re.source, flags: re.flags }];
      }

      case "map": {
        let map = value as Map<unknown, unknown>;
        let entries: unknown[] = [];
        for (let [key, val] of map) {
          // Each entry is a [key, val] array, which needs to be wrapped like any array
          let keyVal = [
            this.devaluateImpl(key, map, depth + 1),
            this.devaluateImpl(val, map, depth + 1)
          ];
          entries.push([keyVal]);
        }
        return ["map", entries];
      }

      case "set": {
        let set = value as Set<unknown>;
        let values: unknown[] = [];
        for (let val of set) {
          let serializedVal = this.devaluateImpl(val, set, depth + 1);
          // If the value serialized to an array, it's already wrapped by devaluateImpl
          // But for Set, we need to wrap array values one more time
          if (serializedVal instanceof Array && !(serializedVal.length > 0 && typeof serializedVal[0] === "string")) {
            values.push([serializedVal]);
          } else {
            values.push(serializedVal);
          }
        }
        return ["set", values];
      }

      case "arraybuffer": {
        let buffer = value as ArrayBuffer;
        let bytes = new Uint8Array(buffer);
        if ((bytes as any).toBase64) {
          return ["arraybuffer", (bytes as any).toBase64({omitPadding: true})];
        } else {
          // Convert Uint8Array to number array for String.fromCharCode
          let bytesArray = new Array(bytes.length);
          for (let i = 0; i < bytes.length; i++) {
            bytesArray[i] = bytes[i];
          }
          return ["arraybuffer",
              btoa(String.fromCharCode.apply(null, bytesArray).replace(/=*$/, ""))];
        }
      }

      case "url": {
        let url = value as URL;
        return ["url", url.href];
      }

      case "headers": {
        let headers = value as Headers;
        let entries: Array<[string, string]> = [];
        headers.forEach((value, key) => {
          entries.push([key, value]);
        });
        return ["headers", entries];
      }

      case "error": {
        let e = <Error>value;

        let rewritten = this.exporter.onSendError(e);
        if (rewritten) {
          e = rewritten;
        }

        // Full fidelity error serialization: name, message, stack, cause (recursive), customProps
        let errorData: Record<string, unknown> = {
          name: e.name || "Error",
          message: e.message || ""
        };

        // Preserve stack trace only if onSendError returned an Error with stack property
        // (same behavior as original implementation)
        if (rewritten && rewritten.stack !== undefined) {
          errorData.stack = rewritten.stack;
        }

        // Preserve cause (recursive - cause can be another Error)
        if (e.cause !== undefined) {
          errorData.cause = this.devaluateImpl(e.cause, e, depth + 1);
        }

        // Capture custom properties (best effort)
        // Use getOwnPropertyNames to capture both enumerable and non-enumerable properties
        // Standard Error properties: name, message, stack, cause
        // Browser-specific properties to exclude: line, column, sourceURL (WebKit), fileName, lineNumber, columnNumber (Firefox)
        const browserProps = new Set(["line", "column", "sourceURL", "fileName", "lineNumber", "columnNumber"]);
        let customProps: Record<string, unknown> = {};
        const allProps = Object.getOwnPropertyNames(e);
        for (const key of allProps) {
          if (key !== "name" && key !== "message" && key !== "stack" && key !== "cause" && !browserProps.has(key)) {
            try {
              customProps[key] = this.devaluateImpl(e[key as keyof Error], e, depth + 1);
            } catch (err) {
              // Skip properties that can't be accessed or serialized
            }
          }
        }

        // Only include customProps if not empty
        if (Object.keys(customProps).length > 0) {
          errorData.customProps = customProps;
        }

        return ["error", errorData];
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

      default:
        kind satisfies never;
        throw new Error("unreachable");
    }
  }

  private devaluateHook(type: "export" | "promise", hook: StubHook): unknown {
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
}

const NULL_IMPORTER = new NullImporter();

// Takes object trees parse from JSON and converts them into fully-hydrated JavaScript objects for
// delivery to the app. This is used to implement deserialization, except that it doesn't actually
// start from a raw string.
export class Evaluator {
  constructor(private importer: Importer) {}

  private stubs: RpcStub[] = [];
  private promises: LocatedPromise[] = [];

  public evaluate(value: unknown): RpcPayload {
    let payload = RpcPayload.forEvaluate(this.stubs, this.promises);
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
        case "special-number":
          if (typeof value[1] == "string") {
            if (value[1] == "NaN") {
              return NaN;
            } else if (value[1] == "Infinity") {
              return Infinity;
            } else if (value[1] == "-Infinity") {
              return -Infinity;
            }
          }
          break;
        case "regexp":
          if (value[1] && typeof value[1] == "object" && typeof value[1].source == "string") {
            return new RegExp(value[1].source, value[1].flags || "");
          }
          break;
        case "map":
          if (value[1] instanceof Array) {
            let map = new Map();
            for (let wrappedEntry of value[1]) {
              // Each entry is wrapped: [[key, val]]
              if (wrappedEntry instanceof Array && wrappedEntry.length == 1 &&
                  wrappedEntry[0] instanceof Array && wrappedEntry[0].length == 2) {
                let entry = wrappedEntry[0];
                map.set(
                  this.evaluateImpl(entry[0], map, 0),
                  this.evaluateImpl(entry[1], map, 1)
                );
              }
            }
            return map;
          }
          break;
        case "set":
          if (value[1] instanceof Array) {
            let set = new Set();
            for (let wrappedItem of value[1]) {
              // Items in Set may be wrapped if they were arrays: [[value]]
              let item = wrappedItem;
              if (wrappedItem instanceof Array && wrappedItem.length === 1 && 
                  wrappedItem[0] instanceof Array && !(wrappedItem[0].length > 0 && typeof wrappedItem[0][0] === "string")) {
                // It's a wrapped array, unwrap it
                item = wrappedItem[0];
              }
              set.add(this.evaluateImpl(item, set, 0));
            }
            return set;
          }
          break;
        case "arraybuffer": {
          let b64 = Uint8Array as any as FromBase64;
          if (typeof value[1] == "string") {
            if (b64.fromBase64) {
              let bytes = b64.fromBase64(value[1]);
              return (bytes as any).buffer as ArrayBuffer;
            } else {
              let bs = atob(value[1]);
              let len = bs.length;
              let bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = bs.charCodeAt(i);
              }
              return bytes.buffer;
            }
          }
          break;
        }
        case "url":
          if (typeof value[1] == "string") {
            return new URL(value[1]);
          }
          break;
        case "headers":
          if (value[1] instanceof Array) {
            let headers = new Headers();
            for (let entry of value[1]) {
              if (entry instanceof Array && entry.length == 2 &&
                  typeof entry[0] == "string" && typeof entry[1] == "string") {
                headers.set(entry[0], entry[1]);
              }
            }
            return headers;
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
          // Support both old format: ["error", name, message, stack?]
          // and new format: ["error", {name, message, stack?, cause?, customProps?}]
          if (value.length >= 3 && typeof value[1] === "string" && typeof value[2] === "string") {
            // Old format - backward compatibility
            let cls = ERROR_TYPES[value[1]] || Error;
            let result = new cls(value[2]);
            if (typeof value[3] === "string") {
              result.stack = value[3];
            }
            return result;
          } else if (value.length >= 2 && value[1] && typeof value[1] === "object") {
            // New format with full fidelity
            let errorData = value[1] as {
              name: string;
              message: string;
              stack?: string;
              cause?: unknown;
              customProps?: Record<string, unknown>;
            };
            let cls = ERROR_TYPES[errorData.name] || Error;
            let result = new cls(errorData.message || "");
            
            // Always delete auto-generated stack first
            delete result.stack;
            
            // Only set name explicitly if it's not a standard error type or differs from default
            // This preserves the correct non-enumerable property for standard errors
            if (!ERROR_TYPES[errorData.name] || result.name !== errorData.name) {
              // Delete the auto-set name first, then set our own
              delete (result as any).name;
              Object.defineProperty(result, 'name', {
                value: errorData.name,
                writable: true,
                enumerable: false,
                configurable: true
              });
            }

            if (errorData.stack !== undefined) {
              result.stack = errorData.stack;
            }

            if (errorData.cause !== undefined) {
              result.cause = this.evaluateImpl(errorData.cause, result, "cause");
            }

            if (errorData.customProps) {
              for (let key in errorData.customProps) {
                result[key] = this.evaluateImpl(errorData.customProps[key], result, key);
              }
            }

            return result;
          }
          break;
        case "undefined":
          if (value.length === 1) {
            return undefined;
          }
          break;

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
              let stub = new RpcPromise(hook, []);
              this.stubs.push(stub);
              return stub;
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
              let stub = new RpcStub(hook);
              this.stubs.push(stub);
              return stub;
            }
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
