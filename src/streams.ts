// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcTarget } from "./core.js";

/**
 * Internal wrapper for ReadableStream that exposes stream operations over RPC.
 *
 * This class wraps a ReadableStream and provides RPC-compatible methods for reading chunks.
 * When a ReadableStream is sent over RPC, it's automatically wrapped in this class.
 */
export class ReadableStreamRpcTarget extends RpcTarget {
  private reader: ReadableStreamDefaultReader<any> | null = null;
  private stream: ReadableStream;

  constructor(stream: ReadableStream) {
    super();
    this.stream = stream;
  }

  /**
   * Reads the next chunk from the stream.
   * Returns { done: false, value: chunk } or { done: true } when complete.
   */
  async read(): Promise<ReadableStreamReadResult<any>> {
    if (!this.reader) {
      this.reader = this.stream.getReader();
    }
    return await this.reader.read();
  }

  /**
   * Cancels the stream with an optional reason.
   */
  async cancel(reason?: any): Promise<void> {
    if (this.reader) {
      await this.reader.cancel(reason);
    } else {
      await this.stream.cancel(reason);
    }
  }

  /**
   * Cleanup when the RPC stub is disposed.
   */
  [Symbol.dispose](): void {
    if (this.reader) {
      this.reader.releaseLock();
      this.reader = null;
    }
  }
}

/**
 * Internal wrapper for WritableStream that exposes stream operations over RPC.
 *
 * This class wraps a WritableStream and provides RPC-compatible methods for writing chunks.
 * When a WritableStream is sent over RPC, it's automatically wrapped in this class.
 */
export class WritableStreamRpcTarget extends RpcTarget {
  private writer: WritableStreamDefaultWriter<any> | null = null;
  private stream: WritableStream;

  constructor(stream: WritableStream) {
    super();
    this.stream = stream;
  }

  /**
   * Writes a chunk to the stream.
   */
  async write(chunk: any): Promise<void> {
    if (!this.writer) {
      this.writer = this.stream.getWriter();
    }
    await this.writer.write(chunk);
  }

  /**
   * Closes the stream, indicating no more writes.
   */
  async close(): Promise<void> {
    if (!this.writer) {
      this.writer = this.stream.getWriter();
    }
    await this.writer.close();
  }

  /**
   * Aborts the stream with an optional reason.
   */
  async abort(reason?: any): Promise<void> {
    if (this.writer) {
      await this.writer.abort(reason);
    } else {
      await this.stream.abort(reason);
    }
  }

  /**
   * Cleanup when the RPC stub is disposed.
   */
  [Symbol.dispose](): void {
    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }
  }
}

/**
 * Creates a ReadableStream from an RPC stub of ReadableStreamRpcTarget.
 *
 * This is used on the receiving end to convert the RPC stub back into a usable ReadableStream.
 */
export function createReadableStreamFromStub(stub: any): ReadableStream {
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await stub.read();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await stub.cancel(reason);
      stub[Symbol.dispose]?.();
    }
  });
}

/**
 * Creates a WritableStream from an RPC stub of WritableStreamRpcTarget.
 *
 * This is used on the receiving end to convert the RPC stub back into a usable WritableStream.
 */
export function createWritableStreamFromStub(stub: any): WritableStream {
  return new WritableStream({
    async write(chunk) {
      await stub.write(chunk);
    },
    async close() {
      await stub.close();
      stub[Symbol.dispose]?.();
    },
    async abort(reason) {
      await stub.abort(reason);
      stub[Symbol.dispose]?.();
    }
  });
}
