// Minimal Node HTTP server exposing an RPC endpoint over HTTP batching.
//
// Usage:
//   1) From repo root: npm run build
//   2) Start: node examples/batch-pipelining/server-node.mjs
//   3) Client: node examples/batch-pipelining/client.mjs

import http from 'node:http';
import { nodeHttpBatchRpcResponse, RpcTarget } from '../../dist/index.js';

// Simple helper to simulate server-side processing latency.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simple in-memory data
const USERS = new Map([
  ['cookie-123', { id: 'u_1', name: 'Ada Lovelace' }],
  ['cookie-456', { id: 'u_2', name: 'Alan Turing' }],
]);

const PROFILES = new Map([
  ['u_1', { id: 'u_1', bio: 'Mathematician & first programmer' }],
  ['u_2', { id: 'u_2', bio: 'Mathematician & computer science pioneer' }],
]);

const NOTIFICATIONS = new Map([
  ['u_1', ['Welcome to Cap\'n Web!', 'You have 2 new followers']],
  ['u_2', ['New feature: pipelining!', 'Security tips for your account']],
]);

// Define the server-side API by extending RpcTarget.
class Api extends RpcTarget {
  // Simulate authentication from a session cookie/token.
  async authenticate(sessionToken) {
    await sleep(Number(process.env.DELAY_AUTH_MS ?? 80));
    const user = USERS.get(sessionToken);
    if (!user) throw new Error('Invalid session');
    return user; // { id, name }
  }

  async getUserProfile(userId) {
    await sleep(Number(process.env.DELAY_PROFILE_MS ?? 120));
    const profile = PROFILES.get(userId);
    if (!profile) throw new Error('No such user');
    return profile; // { id, bio }
  }

  async getNotifications(userId) {
    await sleep(Number(process.env.DELAY_NOTIFS_MS ?? 120));
    return NOTIFICATIONS.get(userId) ?? [];
  }
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const server = http.createServer(async (req, res) => {
  // Only handle POST /rpc as a batch endpoint.
  if (req.method !== 'POST' || req.url !== '/rpc') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    await nodeHttpBatchRpcResponse(req, res, new Api());
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err?.stack || err));
  }
});

server.listen(PORT, () => {
  console.log(`RPC server listening on http://localhost:${PORT}/rpc`);
});
