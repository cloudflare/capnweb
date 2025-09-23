import { newWorkersRpcResponse, RpcTarget } from 'capnweb';

type Env = {
  DELAY_AUTH_MS?: string;
  DELAY_PROFILE_MS?: string;
  DELAY_NOTIFS_MS?: string;
  SIMULATED_RTT_MS?: string;
  SIMULATED_RTT_JITTER_MS?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jittered = (base: number, jitter: number) => base + (jitter ? Math.random() * jitter : 0);

const USERS = new Map([
  ['cookie-123', { id: 'u_1', name: 'Ada Lovelace' }],
  ['cookie-456', { id: 'u_2', name: 'Alan Turing' }],
]);

const PROFILES = new Map([
  ['u_1', { id: 'u_1', bio: 'Mathematician & first programmer' }],
  ['u_2', { id: 'u_2', bio: 'Mathematician & CS pioneer' }],
]);

const NOTIFICATIONS = new Map([
  ['u_1', ['Welcome to Cap\'n Web!', 'You have 2 new followers']],
  ['u_2', ['New feature: pipelining!', 'Security tips for your account']],
]);

export class Api extends RpcTarget {
  constructor(private env: Env) { super(); }

  async authenticate(sessionToken: string) {
    await sleep(Number(this.env.DELAY_AUTH_MS ?? 80));
    const user = USERS.get(sessionToken);
    if (!user) throw new Error('Invalid session');
    return user;
  }

  async getUserProfile(userId: string) {
    await sleep(Number(this.env.DELAY_PROFILE_MS ?? 120));
    const profile = PROFILES.get(userId);
    if (!profile) throw new Error('No such user');
    return profile;
  }

  async getNotifications(userId: string) {
    await sleep(Number(this.env.DELAY_NOTIFS_MS ?? 120));
    return NOTIFICATIONS.get(userId) ?? [];
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname === '/api') {
      // Basic CORS preflight support if testing cross-origin
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
          Vary: 'Origin',
        },
      });
    }

    if (url.pathname === '/api') {
      // Simulate uplink latency (browser -> server)
      const rttBase = Number(env.SIMULATED_RTT_MS ?? 0);
      const rttJitter = Number(env.SIMULATED_RTT_JITTER_MS ?? 0);
      if (rttBase || rttJitter) await sleep(jittered(rttBase, rttJitter));

      const resp = await newWorkersRpcResponse(request, new Api(env));

      // Simulate downlink latency (server -> browser)
      if (rttBase || rttJitter) await sleep(jittered(rttBase, rttJitter));
      // Add CORS so the example also works cross-origin
      const headers = new Headers(resp.headers);
      const origin = request.headers.get('Origin');
      if (origin) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Vary', 'Origin');
      }
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Static assets are served from web/dist by Wrangler assets config.
    return new Response('Not found', { status: 404 });
  },
};
