// Minimal Node HTTP server exposing an RPC endpoint over HTTP batching.
//
// Usage:
//   1) From repo root: npm run build
//   2) Start: node examples/batch-pipelining/server-node.mjs
//   3) Client: node examples/batch-pipelining/client.mjs
//
// The same API is served from a Cloudflare Worker in `worker.js`; both share
// the `Api` class in `api.mjs`.

import http from 'node:http';
import { nodeHttpBatchRpcResponse } from 'capnweb';
import { Api, delaysFrom } from './api.mjs';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const delays = delaysFrom(process.env);

const server = http.createServer(async (req, res) => {
  // Only handle POST /rpc as a batch endpoint.
  if (req.method !== 'POST' || req.url !== '/rpc') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    await nodeHttpBatchRpcResponse(req, res, new Api(delays));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err?.stack || err));
  }
});

server.listen(PORT, () => {
  console.log(`RPC server listening on http://localhost:${PORT}/rpc`);
});
