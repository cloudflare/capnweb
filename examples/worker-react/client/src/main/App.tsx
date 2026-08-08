import { useCallback, useMemo, useState } from 'react'
import {
  createFetchInstrument,
  runPipelined,
  runSequential,
  runValidationFailure,
  type Result,
  type Trace,
} from './runs'
import './App.css'

export function App() {
  const [pipelined, setPipelined] = useState<Result | null>(null)
  const [sequential, setSequential] = useState<Result | null>(null)
  const [running, setRunning] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  // Network RTT is simulated on the server (Worker). See wrangler.jsonc vars.
  const wrapFetch = useMemo(createFetchInstrument, [])

  const showValidationFailure = useCallback(async () => {
    setValidationError(null)
    setValidationError(await runValidationFailure())
  }, [])

  const runDemo = useCallback(async () => {
    if (running) return
    setRunning(true)
    wrapFetch.install()
    try {
      setPipelined(await runPipelined(wrapFetch))
      setSequential(await runSequential(wrapFetch))
    } finally {
      wrapFetch.uninstall()
      setRunning(false)
    }
  }, [running, wrapFetch])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.5 }}>
      <h1>Cap'n Web: Cloudflare Workers + React</h1>
      <div style={{ opacity: 0.8 }}>Network RTT (round-trip-time) is simulated on the server (configurable via <code>SIMULATED_RTT_MS</code>/<code>SIMULATED_RTT_JITTER_MS</code> in <code>wrangler.jsonc</code>).</div>
      <p>This demo calls the Worker API in two ways:</p>
      <ul>
        <li><b>Pipelined (batched)</b>: dependent calls in one round trip</li>
        <li><b>Sequential (non-batched)</b>: three separate round trips</li>
      </ul>
      <button onClick={runDemo} disabled={running}>
        {running ? 'Running…' : 'Run demo'}
      </button>

      <section style={{ marginTop: 24 }}>
        <h2>Validation</h2>
        <p>Calls <code>authenticate(12345)</code> instead of a string — the server rejects the wrong-typed argument.</p>
        <button onClick={showValidationFailure}>Test validation failure</button>
        {validationError && (
          <pre style={{ color: '#ef4444', marginTop: 8, whiteSpace: 'pre-wrap' }}>{validationError}</pre>
        )}
      </section>

      {(pipelined && sequential) ? (<>
        <section style={{ marginTop: 24 }}>
          <h2>Pipelined (batched)</h2>
          <div>HTTP POSTs: {pipelined.posts}</div>
          <div>Time: {pipelined.ms.toFixed(1)} ms</div>
          <TraceView trace={pipelined.trace} maxTime={sequential.trace.total} />
          <div className="response-container">
            <div className="response-title">Response</div>
            <pre>{JSON.stringify({
              user: pipelined.user,
              profile: pipelined.profile,
              notifications: pipelined.notifications,
            }, null, 2)}</pre>
          </div>
        </section>

        <section style={{ marginTop: 24 }}>
          <h2>Sequential (non-batched)</h2>
          <div>HTTP POSTs: {sequential.posts}</div>
          <div>Time: {sequential.ms.toFixed(1)} ms</div>
          <TraceView trace={sequential.trace} maxTime={sequential.trace.total} />
          <div className="response-container">
            <div className="response-title">Response</div>
            <pre>{JSON.stringify({
              user: sequential.user,
              profile: sequential.profile,
              notifications: sequential.notifications,
            }, null, 2)}</pre>
          </div>
        </section>

        <section style={{ marginTop: 24 }}>
          <h2>Summary</h2>
          <div>Pipelined: {pipelined.posts} POST, {pipelined.ms.toFixed(1)} ms</div>
          <div className="comparison-bar" style={{ width: `${(pipelined.ms / sequential.ms) * 100}%` }} />
          <div style={{ marginTop: 5 }}>Sequential: {sequential.posts} POSTs, {sequential.ms.toFixed(1)} ms</div>
          <div className="comparison-bar" style={{ width: '100%' }} />
        </section></>
      ) : null}
    </div>
  )
}

function TraceView({ trace, maxTime }: { trace: Trace, maxTime: number }) {
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
                left: `${(e.start / Math.max(maxTime, 1)) * 100}%`,
                width: `${Math.max(0.2, ((e.end - e.start) / Math.max(maxTime, 1)) * 100)}%`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Call rows */}
      {renderedCalls.map((c, idx) => (
        <div key={`call-${idx}`} className="chart-row">
          <div className="chart-label"><code>{c.label}</code></div>
          <div className="chart-timeline">
            <div
              className="chart-bar chart-bar-call"
              style={{
                left: `${(c.start / Math.max(maxTime, 1)) * 100}%`,
                width: `${Math.max(0.2, ((c.end - c.start) / Math.max(maxTime, 1)) * 100)}%`,
                backgroundColor: colorFor(idx),
              }}
            >
              &nbsp;{(c.end - c.start).toFixed(0)}ms
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
                {(maxTime * f).toFixed(0)}ms
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
