import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";

export interface Greeting { name: string; count: number }

@validateRpc()
export default class Api extends WorkerEntrypoint {
  greet(g: Greeting): string { return `hi ${g.name} x${g.count}`; }
  @skipRpcValidation()
  raw(x: unknown): unknown { return x; }
  override fetch(_req: Request): Response { return new Response("ok"); }
}
