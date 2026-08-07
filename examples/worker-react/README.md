# Cloudflare Workers + React example

This example exposes a Cap'n Web API from a Worker and calls it from a React app. It demonstrates batched promise pipelining versus sequential requests, with server-boundary runtime validation through `@validateRpc()` and explicit client stub validation through `validateStub()`.

Live at **[worker-react.capnweb.com](https://worker-react.capnweb.com)**.

## Quick start

From the repo root, `npm run dev` builds everything and serves this example on
`http://127.0.0.1:8787` alongside the docs and the other example. `npm run dev:worker-react` runs
just this one. The rest of this file covers running the pieces individually.

## Layout

- `server/worker.ts`: Worker RPC endpoint at `/api`.
- `client/`: React/Vite app.
- `wrangler.jsonc`: Worker config. Wrangler runs `capnweb-validate build` before starting and points `main` at the generated Worker copy.

## Run locally

From the repo root:

```sh
npm run build
cd examples/worker-react/client
npm install
npm run build
cd ..
npx wrangler dev --config wrangler.jsonc
```

Open `http://127.0.0.1:8787`.

For client debugging with Vite, run the Worker from the example directory:

```sh
cd examples/worker-react
npx wrangler dev --config wrangler.jsonc --ip 127.0.0.1 --port 8787 --inspector-port 9229
```

In another terminal, run Vite from the repo root:

```sh
cd examples/worker-react/client
npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8787`.

## VS Code debug

Use the `validate: debug all` launch configuration. It starts Wrangler and Vite without the old helper shell scripts.

Worker validation output is generated under `.wrangler/validate/worker.ts`.
The React client uses normal Cap'n Web client sessions wrapped explicitly with `validateStub()`.

## Tuning delays

Set these in `wrangler.jsonc`:

- `DELAY_AUTH_MS` (default 80)
- `DELAY_PROFILE_MS` (default 120)
- `DELAY_NOTIFS_MS` (default 120)
- `SIMULATED_RTT_MS` per direction (default 120)
- `SIMULATED_RTT_JITTER_MS` per direction (default 40)
