// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcTarget, newWebSocketRpcSession } from "../../dist/index.js";

class ClientApi extends RpcTarget {
  showNotification(message) {
    console.log(`Notification: ${message}`);
  }
}

// The second argument exposes ClientApi to the server. The return value is a
// stub for the server's root interface.
const server = newWebSocketRpcSession("ws://127.0.0.1:8080", new ClientApi());

try {
  console.log(`Response: ${await server.greet("Ada")}`);
} finally {
  server[Symbol.dispose]();
}
