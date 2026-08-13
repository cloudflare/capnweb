Examples

- batch-pipelining: Node server + client. Shows batching and pipelining to execute a dependent sequence of RPC calls in a single HTTP round trip, with timing vs sequential.
- websocket-bidirectional: Node server + client. Shows each side exposing an RPC interface over the same WebSocket connection.
- worker-react: Cloudflare Worker backend + React frontend. Shows the same pattern from a browser app, served by the Worker.

Notes

- Examples import from `../../dist/index.js`. Run `npm run build` at the repo root before running an example.
- Requires Node 18+ (built-in `fetch`, `Request`, `Response`).
