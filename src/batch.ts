// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import type { IncomingMessage, ServerResponse, OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http";

type SendBatchFunc = (batch: string[]) => Promise<string[]>;

class BatchClientTransport implements RpcTransport {
  constructor(sendBatch: SendBatchFunc) {
    this.#promise = this.#scheduleBatch(sendBatch);
  }

  #promise: Promise<void>;
  #aborted: any;

  #batchToSend: string[] | null = [];
  #batchToReceive: string[] | null = null;

  async send(message: string): Promise<void> {
    // If the batch was already sent, we just ignore the message, because throwing may cause the
    // RPC system to abort prematurely. Once the last receive() is done then we'll throw an error
    // that aborts the RPC system at the right time and will propagate to all other requests.
    if (this.#batchToSend !== null) {
      this.#batchToSend.push(message);
    }
  }

  async receive(): Promise<string> {
    if (!this.#batchToReceive) {
      await this.#promise;
    }

    let msg = this.#batchToReceive!.shift();
    if (msg !== undefined) {
      return msg;
    } else {
      // No more messages. An error thrown here will propagate out of any calls that are still
      // open.
      throw new Error("Batch RPC request ended.");
    }
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
    await new Promise(resolve => setTimeout(resolve, 0));

    if (this.#aborted !== undefined) {
      throw this.#aborted;
    }

    let batch = this.#batchToSend!;
    this.#batchToSend = null;
    this.#batchToReceive = await sendBatch(batch);
  }
}

export function newHttpBatchRpcSession(
    urlOrRequest: string | Request, options?: RpcSessionOptions): RpcStub {
  let sendBatch: SendBatchFunc = async (batch: string[]) => {
    let response = await fetch(urlOrRequest, {
      method: "POST",
      body: batch.join("\n"),
    });

    if (!response.ok) {
      response.body?.cancel();
      throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
    }

    let body = await response.text();
    return body == "" ? [] : body.split("\n");
  };

  let transport = new BatchClientTransport(sendBatch);
  let rpc = new RpcSession(transport, undefined, options);
  return rpc.getRemoteMain();
}

class BatchServerTransport implements RpcTransport {
  constructor(batch: string[]) {
    this.#batchToReceive = batch;
  }

  #batchToSend: string[] = [];
  #batchToReceive: string[];
  #allReceived: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  async send(message: string): Promise<void> {
    this.#batchToSend.push(message);
  }

  async receive(): Promise<string> {
    let msg = this.#batchToReceive!.shift();
    if (msg !== undefined) {
      return msg;
    } else {
      // No more messages.
      this.#allReceived.resolve();
      return new Promise(r => {});
    }
  }

  abort?(reason: any): void {
    this.#allReceived.reject(reason);
  }

  whenAllReceived() {
    return this.#allReceived.promise;
  }

  getResponseBody(): string {
    return this.#batchToSend.join("\n");
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

  let body = await request.text();
  let batch = body === "" ? [] : body.split("\n");

  let transport = new BatchServerTransport(batch);
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
  if (request.method !== "POST") {
    response.writeHead(405, "This endpoint only accepts POST requests.");
  }

  let body = await new Promise<string>((resolve, reject) => {
    let chunks: Buffer[] = [];
    request.on("data", chunk => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    request.on("error", reject);
  });
  let batch = body === "" ? [] : body.split("\n");

  let transport = new BatchServerTransport(batch);
  let rpc = new RpcSession(transport, localMain, options);

  await transport.whenAllReceived();
  await rpc.drain();

  response.writeHead(200, options?.headers);
  response.end(transport.getResponseBody());
}
