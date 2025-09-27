import { useMemo, useState } from 'react'
import { newHttpBatchRpcSession } from '@cloudflare/jsrpc'
import type { Api } from '../../../src/worker'

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

  // Count RPC POSTs and capture network timing by wrapping fetch while this component is mounted.
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

  async function runPipelined() {
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
  }

  async function runSequential() {
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
  }

  async function runDemo() {
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
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.5 }}>
      <h1>JSRPC: Workers + React</h1>
      <div style={{ opacity: 0.8 }}>Network RTT is simulated on the server (configurable via SIMULATED_RTT_MS/SIMULATED_RTT_JITTER_MS in wrangler.toml).</div>
      <p>This demo calls the Worker API in two ways:</p>
      <ul>
        <li><b>Pipelined batch</b>: dependent calls in one round trip</li>
        <li><b>Sequential non-batched</b>: three separate round trips</li>
      </ul>
      <button onClick={runDemo} disabled={running}>
        {running ? 'Running…' : 'Run demo'}
      </button>

      {pipelined && (
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
      )}

      {sequential && (
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
      )}

      {(pipelined && sequential) && (
        <section style={{ marginTop: 24 }}>
          <h2>Summary</h2>
          <div>Pipelined: {pipelined.posts} POST, {pipelined.ms.toFixed(1)} ms</div>
          <div>Sequential: {sequential.posts} POSTs, {sequential.ms.toFixed(1)} ms</div>
        </section>
      )}
    </div>
  )
}

function TraceView({ trace }: { trace: Trace }) {
  const width = 700
  const rowHeight = 22
  const gap = 8
  const rows = [ 'Network', ...trace.calls.map(c => c.label) ]
  const totalHeight = rows.length * (rowHeight + gap) + 10
  const scale = (t: number) => (t / Math.max(trace.total, 1)) * width

  // Deduplicate call labels in case of repeats
  const renderedCalls = trace.calls.map((c, i) => ({...c, idx: i}))

  return (
    <svg width={width + 160} height={totalHeight} style={{ border: '1px solid #eee', background: '#fafafa', margin: '12px 0' }}>
      {rows.map((label, i) => (
        <text key={`label-${i}`} x={8} y={i * (rowHeight + gap) + rowHeight - 6} fill="#444" fontSize="12" fontFamily="system-ui, sans-serif">{label}</text>
      ))}

      {/* Network row */}
      {trace.network.map((e, i) => (
        <g key={`net-${i}`}>
          <rect x={140 + scale(e.start)} y={i * 0 + 4} width={Math.max(2, scale(e.end - e.start))} height={rowHeight - 6} fill="#bbb" transform={`translate(0, ${0 * (rowHeight + gap)})`} />
        </g>
      ))}

      {/* Call rows */}
      {renderedCalls.map((c, idx) => (
        <g key={`call-${idx}`} transform={`translate(0, ${(idx + 1) * (rowHeight + gap)})`}>
          <rect x={140 + scale(c.start)} y={4} width={Math.max(2, scale(c.end - c.start))} height={rowHeight - 6} fill={colorFor(idx)} />
          <text x={140 + scale(c.start) + 4} y={rowHeight - 6} fill="#fff" fontSize="11" fontFamily="system-ui, sans-serif">{(c.end - c.start).toFixed(0)}ms</text>
        </g>
      ))}

      {/* Axis */}
      <line x1={140} x2={140 + width} y1={rows.length * (rowHeight + gap) + 2} y2={rows.length * (rowHeight + gap) + 2} stroke="#ddd" />
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
        <g key={`tick-${i}`}>
          <line x1={140 + width * f} x2={140 + width * f} y1={5} y2={rows.length * (rowHeight + gap)} stroke="#eee" />
          <text x={140 + width * f - 10} y={rows.length * (rowHeight + gap) + 14} fill="#666" fontSize="10">{(trace.total * f).toFixed(0)}ms</text>
        </g>
      ))}
    </svg>
  )
}

function colorFor(i: number): string {
  const palette = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6']
  return palette[i % palette.length]
}
