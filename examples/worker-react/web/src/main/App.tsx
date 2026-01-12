import { useCallback, useMemo, useState } from 'react'
import { newHttpBatchRpcSession } from 'capnweb'
import type { Api } from '../../../src/worker'
import './App.css'

type Result = {
  posts: number
  ms: number
  user: any
  profile: any
  notifications: any
  trace: Trace
}

type CallEvent = { label: string, start: number, end: number }
type NetEvent = { label: string, start: number, end: number }
type Trace = { total: number, calls: CallEvent[], network: NetEvent[] }

export function App() {
  const [pipelined, setPipelined] = useState<Result | null>(null)
  const [sequential, setSequential] = useState<Result | null>(null)
  const [running, setRunning] = useState(false)

  // Network RTT is now simulated on the server (Worker). See wrangler.toml vars.

  /** Count RPC POSTs and capture network timing by wrapping fetch while this component is mounted. */
  const wrapFetch = useMemo(() => {
    let posts = 0
    let origin = 0
    let events: NetEvent[] = []
    const orig = globalThis.fetch
    function install() {
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
    }
    function uninstall() { ;(globalThis as any).fetch = orig }
    function get() { return posts }
    function reset() { posts = 0; events = [] }
    function setOrigin(o: number) { origin = o }
    function getEvents(): NetEvent[] { return events.slice() }
    return { install, uninstall, get, reset, setOrigin, getEvents }
  }, [])

  const runPipelined = useCallback(async () => {
    wrapFetch.reset()
    const t0 = performance.now()
    wrapFetch.setOrigin(t0)
    const calls: CallEvent[] = []
    const api = newHttpBatchRpcSession<Api>('/api')
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
  }, [wrapFetch])

  const runSequential = useCallback(async () => {
    wrapFetch.reset()
    const t0 = performance.now()
    wrapFetch.setOrigin(t0)
    const calls: CallEvent[] = []
    const api1 = newHttpBatchRpcSession<Api>('/api')
    const aStart = 0; calls.push({ label: 'authenticate', start: aStart, end: NaN })
    const uPromise = api1.authenticate('cookie-123')
    uPromise.then(() => { calls.find(c => c.label==='authenticate')!.end = performance.now() - t0 })
    const u = await uPromise

    const api2 = newHttpBatchRpcSession<Api>('/api')
    const pStart = performance.now() - t0; calls.push({ label: 'getUserProfile', start: pStart, end: NaN })
    const pPromise = api2.getUserProfile(u.id)
    pPromise.then(() => { calls.find(c => c.label==='getUserProfile')!.end = performance.now() - t0 })
    const p = await pPromise

    const api3 = newHttpBatchRpcSession<Api>('/api')
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
  }, [wrapFetch])

  const runDemo = useCallback(async () => {
    if (running) return
    setRunning(true)
    wrapFetch.install()
    try {
      const piped = await runPipelined()
      setPipelined(piped)
      const seq = await runSequential()
      setSequential(seq)
    } finally {
      wrapFetch.uninstall()
      setRunning(false)
    }
  }, [running, wrapFetch, runPipelined, runSequential])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.5 }}>
      <h1>Cap'n Web: Cloudflare Workers + React</h1>
      <div style={{ opacity: 0.8 }}>Network RTT is simulated on the server (configurable via <code>SIMULATED_RTT_MS</code>/<code>SIMULATED_RTT_JITTER_MS</code> in <code>wrangler.toml</code>).</div>
      <p>This demo calls the Worker API in two ways:</p>
      <ul>
        <li><b>Pipelined (batched)</b>: dependent calls in one round trip</li>
        <li><b>Sequential (non-batched)</b>: three separate round trips</li>
      </ul>
      <button onClick={runDemo} disabled={running}>
        {running ? 'Running…' : 'Run demo'}
      </button>

      {pipelined ? (
        <section style={{ marginTop: 24 }}>
          <h2>Pipelined (batched)</h2>
          <div>HTTP POSTs: {pipelined.posts}</div>
          <div>Time: {pipelined.ms.toFixed(1)} ms</div>
          <TraceView trace={pipelined.trace} />
          <pre>{JSON.stringify({
            user: pipelined.user,
            profile: pipelined.profile,
            notifications: pipelined.notifications,
          }, null, 2)}</pre>
        </section>
      ) : null}

      {sequential ? (
        <section style={{ marginTop: 24 }}>
          <h2>Sequential (non-batched)</h2>
          <div>HTTP POSTs: {sequential.posts}</div>
          <div>Time: {sequential.ms.toFixed(1)} ms</div>
          <TraceView trace={sequential.trace} />
          <pre>{JSON.stringify({
            user: sequential.user,
            profile: sequential.profile,
            notifications: sequential.notifications,
          }, null, 2)}</pre>
        </section>
      ) : null}

      {(pipelined && sequential) ? (
        <section style={{ marginTop: 24 }}>
          <h2>Summary</h2>
          <div>Pipelined: {pipelined.posts} POST, {pipelined.ms.toFixed(1)} ms</div>
          <div>Sequential: {sequential.posts} POSTs, {sequential.ms.toFixed(1)} ms</div>
        </section>
      ) : null}
    </div>
  )
}

function TraceView({ trace }: { trace: Trace }) {
  const renderedCalls = trace.calls.map((c, i) => ({...c, idx: i}))

  return (
    <div className="chart">
      {/* Network row */}
      <div className="chart-row">
        <div className="chart-label">Network</div>
        <div className="chart-timeline">
          {trace.network.map((e, i) => (
            <div
              key={`net-${i}`}
              className="chart-bar chart-bar-network"
              style={{
                left: `${(e.start / Math.max(trace.total, 1)) * 100}%`,
                width: `${Math.max(0.2, ((e.end - e.start) / Math.max(trace.total, 1)) * 100)}%`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Call rows */}
      {renderedCalls.map((c, idx) => (
        <div key={`call-${idx}`} className="chart-row">
          <div className="chart-label">{c.label}</div>
          <div className="chart-timeline">
            <div
              className="chart-bar chart-bar-call"
              style={{
                left: `${(c.start / Math.max(trace.total, 1)) * 100}%`,
                width: `${Math.max(0.2, ((c.end - c.start) / Math.max(trace.total, 1)) * 100)}%`,
                backgroundColor: colorFor(idx),
              }}
            >
              &nbsp;&nbsp;{(c.end - c.start).toFixed(0)}ms
            </div>
          </div>
        </div>
      ))}

      {/* Axis */}
      <div className="chart-axis">
        <div className="chart-label"></div>
        <div className="chart-axis-line">
          {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
            <div
              key={`tick-${i}`}
              className="chart-tick"
              style={{ left: `${f * 100}%` }}
            >
              <div className="chart-tick-label">
                {(trace.total * f).toFixed(0)}ms
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function colorFor(i: number): string {
  const palette = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6']
  return palette[i % palette.length]
}
