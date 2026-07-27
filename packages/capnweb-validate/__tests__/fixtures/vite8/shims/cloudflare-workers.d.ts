declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    readonly ctx: ExecutionContext;
    readonly env: Env;
    constructor(ctx: ExecutionContext, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
  export interface ExecutionContext { waitUntil(p: Promise<unknown>): void; }
}
