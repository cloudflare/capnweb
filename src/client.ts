import { RpcSession, RpcStub } from "./index.js";
import type { Serializable } from "./types.js";
import { WebSocketTransport } from "./worker.js";

export interface RpcWebSocketSession<T extends Serializable<T> = undefined> {
  getStub(): RpcStub<T>;
  getStats(): { imports: number; exports: number };
  close(): void;
}

class RpcWebSocketSessionImpl<T extends Serializable<T>>
  implements RpcWebSocketSession<T>
{
  private session: RpcSession<T>;
  private transport: WebSocketTransport;

  constructor(session: RpcSession<T>, transport: WebSocketTransport) {
    this.session = session;
    this.transport = transport;
  }

  getStub(): RpcStub<T> {
    return this.session.getRemoteMain();
  }

  getStats(): { imports: number; exports: number } {
    return this.session.getStats();
  }

  close(): void {
    this.transport.abort(new Error("Session closed by client"));
  }
}

// Main WebSocket client function
export function rpcOverWebSocket<T extends Serializable<T> = undefined>(
  url: string,
  localMain?: any
): RpcWebSocketSession<T> {
  const transport = new WebSocketTransport(new WebSocket(url));
  const session = new RpcSession<T>(transport, localMain);

  // @ts-ignore nested types
  return new RpcWebSocketSessionImpl(session, transport);
}
