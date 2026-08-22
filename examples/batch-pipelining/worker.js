// Cloudflare Worker serving the same API as `server-node.mjs`, plus the
// browser demo in `public/`.
//
// Static assets are served ahead of this Worker by the `assets` config, so
// `fetch` only ever sees `/rpc` (assets do not handle POST) and unknown paths.
//
// Note there is no artificial network latency here. The round-trip cost is
// simulated in the browser instead, so the page can expose it as a slider
// without a redeploy -- exactly what `client.mjs` does for the CLI.

import { newWorkersRpcResponse } from 'capnweb';
import { Api, delaysFrom } from './api.mjs';

/** The demo endpoint is public, so allow it to be called from anywhere. */
function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      request.headers.get('Access-Control-Request-Headers') ?? 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/rpc') {
      return new Response('Not found', { status: 404 });
    }

    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors ?? {} });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'POST, OPTIONS' },
      });
    }

    const response = await newWorkersRpcResponse(request, new Api(delaysFrom(env)));

    if (!cors) return response;

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
