# Batch + pipelining (single round trip)

A sequence of dependent RPC calls that all execute on the server in **one** HTTP round trip, using
batching and promise pipelining, measured against the same calls made the ordinary way.

Runs as a playground in the docs under **Examples**, and locally as a real Worker.

## What it does

- Authenticates a user.
- Uses the returned user ID (**without awaiting it**) to fetch the profile and notifications.
- Awaits all three results together.

Because the second and third calls are built from an unresolved promise, they are sent as pipelined
references rather than values. All three travel in one request and one response. The sequential
version does exactly the same work in three round trips.

## Layout

| File                | Role                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `api.mjs`           | The `Api` class and its data. Shared by both servers so they can't drift. |
| `worker.js`         | Cloudflare Worker serving `/rpc` and the browser demo.                    |
| `public/index.html` | The browser demo's markup and styling. No build step.                     |
| `public/demo.js`    | The two strategies being compared. No DOM in it.                          |
| `public/main.js`    | The page wiring: slider, buttons, results.                                |
| `server-node.mjs`   | The same API on a plain Node HTTP server.                                 |
| `client.mjs`        | Terminal client running the same comparison.                              |

## Run it

Build the library at the repo root first (every entry point resolves `capnweb` to `dist/`):

```sh
npm run build
```

### In a browser

```sh
npx wrangler dev --cwd examples/batch-pipelining --ip 127.0.0.1 --port 8788   # from the repo root
```

Then open `http://127.0.0.1:8788`. The page has a latency slider; the gap between the two columns
widens as latency grows, because only the number of round trips differs.

### In a terminal

```sh
node examples/batch-pipelining/server-node.mjs      # terminal 1
node examples/batch-pipelining/client.mjs           # terminal 2
```

The client works against any of the servers. Point it wherever one is running:

```sh
RPC_URL=http://127.0.0.1:8788/rpc node examples/batch-pipelining/client.mjs   # the Worker
RPC_URL=http://127.0.0.1:3000/rpc node examples/batch-pipelining/client.mjs   # the Node server
```

## Where the latency comes from

Two separate knobs, deliberately kept apart:

- **Server-side work**: per-method delays, set by `DELAY_AUTH_MS`, `DELAY_PROFILE_MS` and
  `DELAY_NOTIFS_MS` (`vars` in `wrangler.jsonc`, or environment variables for the Node server).
  Identical in both modes; this is *not* what the demo is measuring.
- **Network round trips**: simulated on the client, by the slider in the browser or by
  `SIMULATED_RTT_MS` / `SIMULATED_RTT_JITTER_MS` for `client.mjs`. This is the part pipelining
  removes.

Keeping the round-trip cost on the client means the deployed Worker adds no artificial network
delay, and the page can change it without a redeploy.

## Why latency stops multiplying

With plain HTTP, or naive GraphQL usage, each dependent call usually needs another round trip. Here
the dependent calls are constructed locally, sent once, and resolved on the server, so latency
stops multiplying with the depth of the chain.
