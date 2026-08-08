// Cloudflare Worker serving the session-recovery demo.
//
// Static assets are served ahead of this Worker by the `assets` config, so
// `fetch` only ever sees `/ws` and unknown paths.

import { newWorkersRpcResponse } from 'capnweb';
import { createEventLog, PublicApi } from './api.mjs';

/**
 * The event log outlives any one connection.
 *
 * Module scope means it lives as long as the isolate, which is enough for a
 * demo and is exactly the wrong answer for production: isolates come and go,
 * and two clients can easily land on two different ones. Anything that must
 * genuinely survive a disconnect belongs in storage that is addressable --
 * a Durable Object, a database, a queue. The point being made here is only
 * that it has to live *somewhere that is not the session*.
 */
const log = createEventLog();

/**
 * The main interface handed to each new connection.
 *
 * Also imported directly by the docs playground, which runs both ends of the
 * session inside one page and so never goes through `fetch` at all.
 */
export function createMain() {
  return new PublicApi(log);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== '/ws') {
      return new Response('Not found', { status: 404 });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('This endpoint speaks WebSocket only.', { status: 426 });
    }

    return await newWorkersRpcResponse(request, createMain());
  },
};
