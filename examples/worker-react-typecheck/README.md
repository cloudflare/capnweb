# worker-react-typecheck

Worker React RPC example with `capnweb-typecheck` enabled at both RPC
boundaries.

The Worker source lives in this directory. The debug client is copied from
[`../worker-react/web`](../worker-react/web) into `.wrangler/typecheck-web` and
patched to import `capnweb-typecheck` before Vite starts.

## What's different from `../worker-react`

The RPC boundary import comes from `capnweb-typecheck`, and RPC methods have
explicit return types so the TypeScript checker can resolve the service shape:

```diff
- import { newWorkersRpcResponse, RpcTarget } from 'capnweb';
+ import { newWorkersRpcResponse, RpcTarget } from 'capnweb-typecheck';

- async authenticate(sessionToken: string) {
+ async authenticate(sessionToken: string): Promise<User> {
  // same for getUserProfile and getNotifications

  newWorkersRpcResponse(request, new Api(env))
```

Wrangler does not expose the bundler plugin hook, so the Worker path uses the
`capnweb-typecheck` CLI first and points Wrangler at the transformed output.
The Vite client path uses the `capnweb-typecheck/vite` plugin.

## Worker-only run

From the repo root:

```sh
# Build local packages once.
npm run build

# Wrangler runs the capnweb-typecheck build step from wrangler.toml.
npx wrangler dev --config examples/worker-react-typecheck/wrangler.toml
```

`wrangler.toml` points `main` at `.wrangler/typecheck/src/worker.ts` and has a
custom build step that regenerates that directory before Wrangler starts:

```toml
[build]
command = "node ../../packages/capnweb-typecheck/dist/cli.cjs build --cwd . --out .wrangler/typecheck"
cwd = "examples/worker-react-typecheck"
watch_dir = "src"
```

A request that violates the declared types, such as calling `authenticate` with
a number, throws `RpcValidationError` at the Worker boundary before user code
runs.

## Full client and Worker debug

Preferred VS Code flow:

1. Open Run and Debug.
2. Select `typecheck: debug all`.
3. Press F5.

That starts both dev servers, waits until they are ready, attaches the Worker
inspector, and opens Chrome at `http://127.0.0.1:5173`.

The same flow can be run by hand from two terminals. Start the Worker first;
the client waits for `http://127.0.0.1:8787/api` before starting Vite:

```sh
examples/worker-react-typecheck/dev-debug-server.sh
examples/worker-react-typecheck/dev-debug-client.sh
```

Useful ports:

- `5173`: Vite client UI.
- `8787`: Worker HTTP/RPC endpoint.
- `9229`: Worker inspector used by VS Code.

Breakpoint paths printed by the scripts are the transformed debug copies. Set
Worker breakpoints in `.wrangler/typecheck/src/worker.ts` and client breakpoints
in `.wrangler/typecheck-web/src/main/App.tsx`.

## Removing typecheck

Import the boundary API from `capnweb` again and point `wrangler.toml` back at
`src/worker.ts`.
