// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { WebSocketServer } from "ws";
import { RpcTarget, newWebSocketRpcSession } from "../../dist/index.js";

class ServerApi extends RpcTarget {
  #client;

  static accept(webSocket) {
    const api = new ServerApi();

    // Expose api to the client and retain the returned stub for the client's
    // root interface. Closing the WebSocket disposes both sides of the session.
    api.#client = newWebSocketRpcSession(webSocket, api);
  }

  async greet(name) {
    await this.#client.showNotification(`The server received ${name}.`);
    return `Hello, ${name}!`;
  }
}

const webSocketServer = new WebSocketServer({ port: 8080 });

webSocketServer.on("connection", (webSocket) => {
  ServerApi.accept(webSocket);
});

console.log("Listening on ws://127.0.0.1:8080");
