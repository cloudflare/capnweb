Cloudflare Workers + React Example

This example shows a Cloudflare Worker exposing a Cap'n Web API and a React app calling it from the browser. It demonstrates batching + promise pipelining vs sequential requests, with timing and request counts.

Prerequisites

- Node 18+
- Wrangler 3+ (for Workers)
- npm

Overview

- Worker endpoint: `/api` using `newWorkersRpcResponse()`
- Static assets (React build) served by the same Worker via Wrangler assets
- Client demonstrates:
  - Pipelined batch: authenticate -> get profile + notifications using the returned user.id without awaiting
  - Sequential non-batched: authenticate, then profile, then notifications in separate round trips

Run locally

1) Build the library at repo root (the example uses the local dist build):
   npm run build

2) Install and build the React app (Vite aliases `capnweb` to the local `dist`):
   cd examples/worker-react/web
   npm install
   npm run build

3) Run the Worker:
   cd ..
   npx wrangler dev

4) Open the app in your browser:
   http://127.0.0.1:8787

Tuning delays

- The Worker simulates server-side latency. Override defaults via Wrangler vars or env:
  - `DELAY_AUTH_MS` (default 80)
  - `DELAY_PROFILE_MS` (default 120)
  - `DELAY_NOTIFS_MS` (default 120)
  - `SIMULATED_RTT_MS` per direction (default 120)
  - `SIMULATED_RTT_JITTER_MS` per direction (default 40)