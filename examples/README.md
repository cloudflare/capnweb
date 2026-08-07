# Examples

Both examples make the same point from opposite ends of the stack: a chain of dependent RPC calls
costs one HTTP round trip when pipelined, and three when it isn't. Both are deployed, and both run
locally.

| Example                                    | Live                                                          | What it is                                              |
| ------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------- |
| [`batch-pipelining`](./batch-pipelining)   | [batch-pipelining.capnweb.com](https://batch-pipelining.capnweb.com) | Worker + zero-build browser page, plus a Node server and CLI client |
| [`worker-react`](./worker-react)           | [worker-react.capnweb.com](https://worker-react.capnweb.com)  | Worker + React/Vite app, with runtime validation        |

## Running everything locally

From the repo root:

```sh
npm run setup   # first time only: installs the docs and React client, which are
                # outside the npm workspace and so have their own lockfiles
npm run dev
```

That builds the library and starts three servers at once:

| URL                     | What                                |
| ----------------------- | ----------------------------------- |
| `http://localhost:4321` | the docs site                       |
| `http://127.0.0.1:8787` | the `worker-react` example          |
| `http://127.0.0.1:8788` | the `batch-pipelining` example      |

The docs landing page links to the two local ports while running under `npm run dev`, and to the
deployed subdomains in a production build. See `packages/docs/.env.development`.

To run just one, use `npm run dev:docs`, `npm run dev:worker-react` or `npm run dev:batch`.

> **If `npm run dev` dies with `EMFILE: too many open files`**, you are out of inotify instances —
> three file watchers is more than the default budget on some Linux systems once an IDE and a
> browser are running. Raise it with
> `sudo sysctl -w fs.inotify.max_user_instances=512` (add it to `/etc/sysctl.conf` to persist), or
> set `CHOKIDAR_USEPOLLING=1` to avoid inotify entirely.

## Deploying

```sh
npm run deploy:examples
```

Each example owns its subdomain through a `custom_domain` route in its `wrangler.jsonc`, so the
hostname is claimed on first deploy.

## Notes

- Examples import `capnweb` as a bare specifier. Under Node that resolves through the repo's own
  workspace self-link; under Workers it is mapped to the workerd build by the `alias` block in each
  `wrangler.jsonc`. Either way, run `npm run build` at the repo root first — both resolve to `dist/`.
- Requires Node 18+ (built-in `fetch`, `Request`, `Response`).
