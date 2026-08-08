// Every RPC call this app makes, and the instrumentation used to time them.
// Kept out of App.tsx so the comparison can be read without the chart and the
// layout around it. Nothing here touches React or the DOM.
import { newHttpBatchRpcSession } from 'capnweb'
import { validateStub } from 'capnweb-validate'
import type { Api } from '../../../server/worker'

export type CallEvent = { label: string, start: number, end: number }
export type NetEvent = { label: string, start: number, end: number }
export type Trace = { total: number, calls: CallEvent[], network: NetEvent[] }

export type Result = {
  posts: number
  ms: number
  user: any
  profile: any
  notifications: any
  trace: Trace
}

/**
 * A new session. `validateStub` wraps it so arguments and return values are
 * checked against the server's types at the boundary -- see runValidationFailure.
 */
function connectApi() {
  return validateStub<Api>(newHttpBatchRpcSession<Api>('/api'))
}

export type FetchInstrument = ReturnType<typeof createFetchInstrument>

/**
 * Counts RPC POSTs and records when each one was in flight, by replacing
 * `fetch` for as long as it is installed. Latency itself is simulated on the
 * Worker (see `SIMULATED_RTT_MS` in wrangler.jsonc), so this only observes.
 */
export function createFetchInstrument() {
  let posts = 0
  let origin = 0
  let events: NetEvent[] = []
  const orig = globalThis.fetch

  return {
    install() {
      ;(globalThis as any).fetch = async (input: RequestInfo, init?: RequestInit) => {
        const method = (init?.method) || (input instanceof Request ? input.method : 'GET')
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/api') && method === 'POST') {
          posts++
          const start = performance.now() - origin
          const resp = await orig(input as any, init)
          const end = performance.now() - origin
          events.push({ label: 'POST /api', start, end })
          return resp
        }
        return orig(input as any, init)
      }
    },
    uninstall() { ;(globalThis as any).fetch = orig },
    get() { return posts },
    reset() { posts = 0; events = [] },
    setOrigin(o: number) { origin = o },
    getEvents(): NetEvent[] { return events.slice() },
  }
}

/**
 * One session, three dependent calls, one round trip. `user` is never awaited
 * before `user.id` is passed to the next two calls, so those travel as promise
 * references in the same batch rather than waiting for a value to come back.
 */
export async function runPipelined(wrapFetch: FetchInstrument): Promise<Result> {
  wrapFetch.reset()
  const t0 = performance.now()
  wrapFetch.setOrigin(t0)
  const calls: CallEvent[] = []
  const api = connectApi()

  const userStart = 0; calls.push({ label: 'authenticate', start: userStart, end: NaN })
  const user = api.authenticate('cookie-123')
  user.then(() => { calls.find(c => c.label==='authenticate')!.end = performance.now() - t0 })

  const profStart = performance.now() - t0; calls.push({ label: 'getUserProfile', start: profStart, end: NaN })
  const profile = api.getUserProfile(user.id)
  profile.then(() => { calls.find(c => c.label==='getUserProfile')!.end = performance.now() - t0 })

  const notiStart = performance.now() - t0; calls.push({ label: 'getNotifications', start: notiStart, end: NaN })
  const notifications = api.getNotifications(user.id)
  notifications.then(() => { calls.find(c => c.label==='getNotifications')!.end = performance.now() - t0 })

  const [u, p, n] = await Promise.all([user, profile, notifications])
  const t1 = performance.now()
  const net = wrapFetch.getEvents()
  const total = t1 - t0
  // Ensure any missing ends are set
  calls.forEach(c => { if (!Number.isFinite(c.end)) c.end = total })
  return { posts: wrapFetch.get(), ms: total, user: u, profile: p, notifications: n,
    trace: { total, calls, network: net } }
}

/**
 * The same three calls, each awaited before the next can be built. Three
 * sessions, three round trips -- the value of `u.id` has to arrive in the
 * browser before the second call can name it.
 */
export async function runSequential(wrapFetch: FetchInstrument): Promise<Result> {
  wrapFetch.reset()
  const t0 = performance.now()
  wrapFetch.setOrigin(t0)
  const calls: CallEvent[] = []

  const api1 = connectApi()
  const aStart = 0; calls.push({ label: 'authenticate', start: aStart, end: NaN })
  const uPromise = api1.authenticate('cookie-123')
  uPromise.then(() => { calls.find(c => c.label==='authenticate')!.end = performance.now() - t0 })
  const u = await uPromise

  const api2 = connectApi()
  const pStart = performance.now() - t0; calls.push({ label: 'getUserProfile', start: pStart, end: NaN })
  const pPromise = api2.getUserProfile(u.id)
  pPromise.then(() => { calls.find(c => c.label==='getUserProfile')!.end = performance.now() - t0 })
  const p = await pPromise

  const api3 = connectApi()
  const nStart = performance.now() - t0; calls.push({ label: 'getNotifications', start: nStart, end: NaN })
  const nPromise = api3.getNotifications(u.id)
  nPromise.then(() => { calls.find(c => c.label==='getNotifications')!.end = performance.now() - t0 })
  const n = await nPromise

  const t1 = performance.now()
  const net = wrapFetch.getEvents()
  const total = t1 - t0
  calls.forEach(c => { if (!Number.isFinite(c.end)) c.end = total })
  return { posts: wrapFetch.get(), ms: total, user: u, profile: p, notifications: n,
    trace: { total, calls, network: net } }
}

/**
 * Deliberately passes a number where the server declares a string. Returns the
 * rejection message, which comes from the validation wrapper rather than from
 * anything the server had to hand-write.
 */
export async function runValidationFailure(): Promise<string> {
  const api = connectApi() as any
  try {
    await api.authenticate(12345)
    return '(no error — unexpected)'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
