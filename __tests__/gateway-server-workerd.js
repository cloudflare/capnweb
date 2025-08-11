import { newWebSocketRpcSession } from "../dist/index.js";
import { WorkerEntrypoint } from "cloudflare:workers";

export class Client extends WorkerEntrypoint {
  async fetch(request) {
    return new Response("Direct fetch response");
  }

  constructor(ctx, env) {
    const stub = newWebSocketRpcSession("ws://localhost:9897");

    super(ctx, env);

    return new Proxy(this, {
      get(target, prop) {
        if (Reflect.has(target, prop)) {
          return Reflect.get(target, prop);
        }

        return Reflect.get(stub, prop);
      },
    });
  }
}

export default {
  fetch() {},
};
