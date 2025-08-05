import { RpcTransport } from "./rpc.js";
import { RpcSession } from "./index.js";
import { RpcTarget } from "./core.js";

// WebSocket transport for Cloudflare Workers
export class WebSocketTransport implements RpcTransport {
  private pendingMessages: string[] = [];

  private pendingReceiveRequests: Omit<
    ReturnType<typeof Promise.withResolvers<string>>,
    "promise"
  >[] = [];

  private aborted = false;
  private abortReason?: any;
  private ws: WebSocket;

  private setup() {
    // Set up WebSocket event handlers
    this.ws.addEventListener("message", (event) => {
      const message = event.data as string;
      console.log("receive", message);

      const request = this.pendingReceiveRequests.shift();
      if (request) {
        request.resolve(message);
      } else {
        this.pendingMessages.push(message);
      }
    });

    this.ws.addEventListener("close", (event) => {
      const error = new Error(
        `WebSocket closed: ${event.code} ${event.reason}`
      );
      this.handleError(error);
    });

    this.ws.addEventListener("error", () => {
      const error = new Error("WebSocket error occurred");
      this.handleError(error);
    });
  }

  constructor(websocket: WebSocket) {
    this.ws = websocket;
    this.setup();
  }

  private handleError(error: any) {
    if (this.aborted) return;

    this.aborted = true;
    this.abortReason = error;

    for (const { reject } of this.pendingReceiveRequests) {
      reject(error);
    }

    this.pendingReceiveRequests = [];
  }

  async send(message: string): Promise<void> {
    console.log("send", message);
    if (this.aborted) {
      throw this.abortReason;
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const onOpen = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (ev: WebSocketEventMap["error"]) => {
        console.log(ev);
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
        reject(new Error("WebSocket failed to connect"));
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
      await promise;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }

    await this.ws.send(message);
  }

  async receive(): Promise<string> {
    if (this.aborted) {
      throw this.abortReason;
    }

    const message = this.pendingMessages.shift();
    if (message !== undefined) {
      return message;
    }
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    if (this.aborted) {
      reject(this.abortReason);
    }
    this.pendingReceiveRequests.push({ resolve, reject });
    return promise;
  }

  abort(reason: any): void {
    console.log("abort", reason);
    if (this.aborted) return;

    this.handleError(reason);
    this.ws?.close();
  }
}

// Handle WebSocket upgrade for RPC
export function receiveRpcOverHttp(
  request: Request,
  target: RpcTarget
): Response {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 400 });
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  const transport = new WebSocketTransport(server);

  new RpcSession(transport, target);

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
