# Examples

The first two make the same point from opposite ends of the stack: a chain of dependent RPC calls
costs one HTTP round trip when pipelined, and three when it isn't. The third is about the other
half of the story: what a session is, and what breaks when it ends.

| Example                                  | What it is                                                          |
| ---------------------------------------- | ------------------------------------------------------------------- |
| [`batch-pipelining`](./batch-pipelining) | Worker + zero-build browser page, plus a Node server and CLI client |
| [`worker-react`](./worker-react)         | Worker + React/Vite app, with runtime validation                    |
| [`session-recovery`](./session-recovery) | Worker + WebSocket page: broken stubs, server push, gapless resume  |

All three also run as playgrounds in the docs, under **Examples**; see
[In the docs](#in-the-docs).

## Running them locally

From the repo root:

```sh
npm run setup              # first time only: installs the docs and the React
                           # client, which sit outside the npm workspace
npm run build              # the examples resolve `capnweb` to dist/

# then any of these, one per shell: each is a long-running server
npx wrangler dev --cwd examples/batch-pipelining --ip 127.0.0.1 --port 8788
npx wrangler dev --cwd examples/worker-react --ip 127.0.0.1 --port 8787
npx wrangler dev --cwd examples/session-recovery --ip 127.0.0.1 --port 8789
```

This is the version worth reaching for when you are changing an example: it is a real Worker
answering real requests over a real network, which the in-page playground deliberately is not.

> **Editing the React client while its `wrangler dev` is running?** Restart it. Wrangler builds its
> asset manifest from `worker-react/client/dist` at startup, so a fresh `vite build` mid-session
> leaves it serving a stale manifest and the new bundle 404s to a blank page. For a hot-reloading
> workflow, run the Vite dev server alongside it instead. See
> [`worker-react/README.md`](./worker-react/README.md). The `batch-pipelining` page has no build
> step, so a refresh is enough.

## In the docs

Each example has a page under **Examples** in the docs, showing its source next to the demo running
live. There is no server behind those: `packages/docs/scripts/build-playgrounds.mjs` bundles the
example's own Worker into the page next to its own client, then connects the two in-page. For the
HTTP examples it routes the client's `fetch` of the RPC path straight into the Worker's `fetch`
handler; for `session-recovery` it replaces the `WebSocket` constructor for that one path with a
linked pair of sockets and hands the far end to a real `newWebSocketRpcSession`. The protocol, the
batching, the round-trip counts and the disconnects are all genuine; only the network hop is
missing, which is what lets the docs deploy as static assets.

Two consequences worth knowing when editing an example:

- The docs read these files at build time and show them whole. Move or rename one that is listed in
  `packages/docs/src/examples.ts` and the docs build fails until it is updated. Because they are
  shown whole, a file worth putting in a tab is worth keeping short and free of unrelated wiring,
  which is why each example splits its RPC code out from its DOM code.
- The playground bundles `dist/`, so a library change needs `npm run build` at the repo root before
  it shows up in the docs.

## Deploying

These examples are not deployed anywhere. They exist to be read and to be run locally. Each still
has a working `wrangler.jsonc`, so `wrangler deploy --cwd examples/<name>` will put one on your own
`workers.dev` subdomain if you want it.

## Notes

- Examples import `capnweb` as a bare specifier. Under Node that resolves through the repo's own
  workspace self-link; under Workers it is mapped to the workerd build by the `alias` block in each
  `wrangler.jsonc`. Either way, run `npm run build` at the repo root first: both resolve to `dist/`.
- Requires Node 18+ (built-in `fetch`, `Request`, `Response`).
