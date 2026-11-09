// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcStub } from "./core.js";
import { RpcTransportWithCustomEncoding, RpcSession, RpcSessionOptions } from "./rpc.js";
import {
  BINARY_CONTENT_TYPE,
  DEFAULT_LIMITS,
  decodeBinaryFrame,
  encodeBinaryFrame,
  hasBinaryFrameMagic,
  stringifyWithBase64Bytes,
} from "./serialize.js";
import type { IncomingMessage, ServerResponse, OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http";

type RawBatch =
  | { isBinary: true; buffer: ArrayBuffer }
  | { isBinary: false; body: string };
type SendBatchFunc = (batch: unknown[]) => Promise<RawBatch>;

// Yield a full macrotask; prefer setImmediate because Node/Bun clamp setTimeout(0) to 1ms.
const yieldToMacrotask: () => Promise<void> =
  typeof setImmediate === "function"
    ? () => new Promise(resolve => setImmediate(resolve))
    : () => new Promise(resolve => setTimeout(resolve, 0));

function hasBinaryMimeType(headerValue: string | null | undefined): boolean {
  return typeof headerValue === "string" &&
    headerValue.toLowerCase().includes(BINARY_CONTENT_TYPE);
}

function decodeBinaryBatch(
  buffer: ArrayBuffer,
  maxMessageSize: number,
  maxDepth: number
): unknown[] {
  if (buffer.byteLength === 0) return [];
  if (buffer.byteLength > maxMessageSize) {
    throw new TypeError(
      `Incoming message exceeds maximum size of ${maxMessageSize} bytes.`
    );
  }
  let decoded = decodeBinaryFrame(buffer, maxDepth * 2 + 2);
  if (!Array.isArray(decoded)) {
    throw new TypeError("Binary HTTP batch frame must decode to an array of messages.");
  }
  return decoded;
}

class BatchClientTransport implements RpcTransportWithCustomEncoding {
  readonly encodingLevel = "jsonCompatibleWithBytes" as const;

  constructor(sendBatch: SendBatchFunc, options?: RpcSessionOptions) {
    this.#maxMessageSize = options?.limits?.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize;
    this.#maxDepth = options?.limits?.maxDepth ?? DEFAULT_LIMITS.maxDepth;
    this.#promise = this.#scheduleBatch(sendBatch);
  }

  #maxMessageSize: number;
  #maxDepth: number;
  #promise: Promise<void>;
  #aborted: unknown;
  #batchToSend: unknown[] | null = [];
  #rawBatch: RawBatch | null = null;
  #batchToReceive?: unknown[];
  #linesToReceive?: string[];

  send(message: unknown): void {
    // If the batch was already sent, we just ignore the message, because throwing may cause the
    // RPC system to abort prematurely. Once the last receive() is done then we'll throw an error
    // that aborts the RPC system at the right time and will propagate to all other requests.
    if (this.#batchToSend !== null) {
      this.#batchToSend.push(message);
    }
  }

  async receive(): Promise<unknown> {
    if (!this.#rawBatch) {
      await this.#promise;
    }
    if (this.#batchToReceive === undefined && this.#linesToReceive === undefined) {
      if (this.#rawBatch!.isBinary) {
        this.#batchToReceive = decodeBinaryBatch(
          this.#rawBatch!.buffer,
          this.#maxMessageSize,
          this.#maxDepth
        );
      } else {
        let body = this.#rawBatch!.body;
        this.#linesToReceive = body === "" ? [] : body.split("\n");
      }
    }

    if (this.#linesToReceive !== undefined) {
      let line = this.#linesToReceive.shift();
      if (line !== undefined) {
        if (line.length > this.#maxMessageSize) {
          throw new TypeError(
            `Incoming message exceeds maximum size of ${this.#maxMessageSize} UTF-16 code units.`
          );
        }
        return JSON.parse(line);
      }
    } else if (this.#batchToReceive !== undefined) {
      let msg = this.#batchToReceive.shift();
      if (msg !== undefined) {
        return msg;
      }
    }

    // No more messages. An error thrown here will propagate out of any calls that are still
    // open.
    throw new Error("Batch RPC request ended.");
  }
  abort?(reason: any): void {
    this.#aborted = reason;
  }

  async #scheduleBatch(sendBatch: SendBatchFunc) {
    // Wait for microtask queue to clear before sending a batch.
    //
    // Note that simply waiting for one turn of the microtask queue (await Promise.resolve()) is
    // not good enough here as the application needs a chance to call `.then()` on every RPC
    // promise in order to explicitly indicate they want the results. Unfortunately, `await`ing
    // a thenable does not call `.then()` immediately -- for some reason it waits for a turn of
    // the microtask queue first, *then* calls `.then()`.
    await yieldToMacrotask();

    if (this.#aborted !== undefined) {
      throw this.#aborted;
    }

    let batch = this.#batchToSend!;
    this.#batchToSend = null;
    this.#rawBatch = await sendBatch(batch);
  }
}

export function newHttpBatchRpcSession(
  urlOrRequest: string | Request,
  options?: RpcSessionOptions
): RpcStub {
  let reqContentType = urlOrRequest instanceof Request
    ? urlOrRequest.headers.get("Content-Type")
    : null;
  let sendBinary = options?.binary ?? hasBinaryMimeType(reqContentType);
  let sendBatch: SendBatchFunc = async (batch: unknown[]) => {
    let response: Response;
    if (sendBinary) {
      let headers = new Headers(urlOrRequest instanceof Request ? urlOrRequest.headers : undefined);
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", BINARY_CONTENT_TYPE);
      }
      if (!headers.has("Accept")) {
        headers.set("Accept", `${BINARY_CONTENT_TYPE}, text/plain;q=0.9, */*;q=0.8`);
      }
      let frame = encodeBinaryFrame(batch);
      response = await fetch(urlOrRequest, {
        method: "POST",
        headers,
        body: frame as Uint8Array<ArrayBuffer>,
      });
    } else {
      response = await fetch(urlOrRequest, {
        method: "POST",
        body: batch.map(msg => stringifyWithBase64Bytes(msg)).join("\n"),
      });
    }

    if (!response.ok) {
      response.body?.cancel();
      throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
    }

    let responseContentType = response.headers.get("Content-Type");
    let buffer = await response.arrayBuffer();
    if (hasBinaryMimeType(responseContentType) || hasBinaryFrameMagic(buffer)) {
      return { isBinary: true, buffer };
    }
    return { isBinary: false, body: new TextDecoder().decode(buffer) };
  };

  let transport = new BatchClientTransport(sendBatch, options);
  let rpc = new RpcSession(transport, undefined, options);
  return rpc.getRemoteMain();
}

class BatchServerTransport implements RpcTransportWithCustomEncoding {
  readonly encodingLevel = "jsonCompatibleWithBytes" as const;

  constructor(rawBatch: RawBatch, options?: RpcSessionOptions) {
    this.#rawBatch = rawBatch;
    this.#maxMessageSize = options?.limits?.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize;
    this.#maxDepth = options?.limits?.maxDepth ?? DEFAULT_LIMITS.maxDepth;
  }

  #rawBatch?: RawBatch;
  #maxMessageSize: number;
  #maxDepth: number;
  #batchToSend: unknown[] = [];
  #batchToReceive?: unknown[];
  #linesToReceive?: string[];
  #allReceived: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  send(message: unknown): void {
    this.#batchToSend.push(message);
  }

  async receive(): Promise<unknown> {
    if (this.#rawBatch !== undefined) {
      let raw = this.#rawBatch;
      this.#rawBatch = undefined;
      if (raw.isBinary) {
        this.#batchToReceive = decodeBinaryBatch(
          raw.buffer,
          this.#maxMessageSize,
          this.#maxDepth
        );
      } else {
        this.#linesToReceive = raw.body === "" ? [] : raw.body.split("\n");
      }
    }

    if (this.#linesToReceive !== undefined) {
      let line = this.#linesToReceive.shift();
      if (line !== undefined) {
        if (line.length > this.#maxMessageSize) {
          throw new TypeError(
            `Incoming message exceeds maximum size of ${this.#maxMessageSize} UTF-16 code units.`
          );
        }
        return JSON.parse(line);
      }
    } else if (this.#batchToReceive !== undefined) {
      let msg = this.#batchToReceive.shift();
      if (msg !== undefined) {
        return msg;
      }
    }

    // No more messages.
    this.#allReceived.resolve();
    return new Promise(r => {});
  }
  abort?(reason: any): void {
    this.#allReceived.reject(reason);
  }

  whenAllReceived(): Promise<void> {
    return this.#allReceived.promise;
  }
  getResponseBody(): string {
    return this.#batchToSend.map(msg => stringifyWithBase64Bytes(msg)).join("\n");
  }

  getResponseBinaryBody(): Uint8Array<ArrayBuffer> {
    return encodeBinaryFrame(this.#batchToSend) as Uint8Array<ArrayBuffer>;
  }
}

/**
 * Implements the server end of an HTTP batch session, using standard Fetch API types to represent
 * HTTP requests and responses.
 *
 * @param request The request received from the client initiating the session.
 * @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
 * @param options Optional RPC session options.
 * @returns The HTTP response to return to the client. Note that the returned object has mutable
 *     headers, so you can modify them using e.g. `response.headers.set("Foo", "bar")`.
 */
export async function newHttpBatchRpcResponse(
    request: Request, localMain: any, options?: RpcSessionOptions): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("This endpoint only accepts POST requests.", { status: 405 });
  }
  let contentType = request.headers.get("Content-Type");
  let accept = request.headers.get("Accept");
  let buffer = await request.arrayBuffer();
  let isBinaryRequest = hasBinaryMimeType(contentType) || hasBinaryFrameMagic(buffer);
  let rawBatch: RawBatch = isBinaryRequest
    ? { isBinary: true, buffer }
    : { isBinary: false, body: new TextDecoder().decode(buffer) };

  let transport = new BatchServerTransport(rawBatch, options);
  let rpc = new RpcSession(transport, localMain, options);
  // TODO: Arguably we should arrange so any attempts to pull promise resolutions from the client
  //   will reject rather than just hang. But it IS valid to make server->client calls in order to
  //   then pipeline the result into something returned to the client. We don't want the errors to
  //   prematurely cancel anything that would eventually complete. So for now we just say, it's the
  //   app's responsibility to not wait on any server -> client calls since they will never
  //   complete.

  await transport.whenAllReceived();
  await rpc.drain();

  // TODO: Ask RpcSession to dispose everything it is still holding on to?

  let respondBinary = options?.binary ?? (isBinaryRequest || hasBinaryMimeType(accept));
  if (respondBinary) {
    return new Response(transport.getResponseBinaryBody(), {
      headers: { "Content-Type": BINARY_CONTENT_TYPE },
    });
  }
  return new Response(transport.getResponseBody());
}

/**
 * Implements the server end of an HTTP batch session using traditional Node.js HTTP APIs.
 *
 * @param request The request received from the client initiating the session.
 * @param response The response object, to which the response should be written.
 * @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
 * @param options Optional RPC session options. You can also pass headers to set on the response.
 */
export async function nodeHttpBatchRpcResponse(
    request: IncomingMessage, response: ServerResponse,
    localMain: any,
    options?: RpcSessionOptions & {
      headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
    }): Promise<void> {
  if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
    if (!response.hasHeader("access-control-allow-methods")) {
      response.setHeader("Access-Control-Allow-Methods", "POST");
    }
    let reqHeaders = request.headers["access-control-request-headers"];
    if (reqHeaders && !response.hasHeader("access-control-allow-headers")) {
      response.setHeader("Access-Control-Allow-Headers", reqHeaders);
    }
    response.writeHead(204, options?.headers);
    response.end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, "This endpoint only accepts POST requests.", options?.headers);
    response.end();
    return;
  }
  let { promise: bodyPromise, resolve, reject } = Promise.withResolvers<Buffer>();
  let chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  request.on("end", () => {
    resolve(Buffer.concat(chunks));
  });
  request.on("error", reject);
  let rawBody = await bodyPromise;
  let contentTypeHeader = request.headers["content-type"];
  let contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader.join(", ") : contentTypeHeader;
  let acceptHeader = request.headers["accept"];
  let accept = Array.isArray(acceptHeader) ? acceptHeader.join(", ") : acceptHeader;
  let isBinaryRequest = hasBinaryMimeType(contentType) || hasBinaryFrameMagic(rawBody);
  let rawBatch: RawBatch;
  if (isBinaryRequest) {
    let buffer = rawBody.byteOffset === 0 && rawBody.byteLength === rawBody.buffer.byteLength &&
        rawBody.buffer instanceof ArrayBuffer
      ? rawBody.buffer
      : rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength) as ArrayBuffer;
    rawBatch = { isBinary: true, buffer };
  } else {
    rawBatch = { isBinary: false, body: rawBody.toString() };
  }

  let transport = new BatchServerTransport(rawBatch, options);
  let rpc = new RpcSession(transport, localMain, options);

  await transport.whenAllReceived();
  await rpc.drain();
  let respondBinary = options?.binary ?? (isBinaryRequest || hasBinaryMimeType(accept));
  if (respondBinary) {
    if (!response.hasHeader("content-type")) {
      response.setHeader("Content-Type", BINARY_CONTENT_TYPE);
    }
    response.writeHead(200, options?.headers);
    response.end(transport.getResponseBinaryBody());
  } else {
    response.writeHead(200, options?.headers);
    response.end(transport.getResponseBody());
  }
}
