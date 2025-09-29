import { Hono } from 'hono'
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'
import { newHttpBatchRpcResponse, newWebSocketRpcSession } from '../../../dist/index.js'
import { MyApiServer } from './my-api-server'

const app = new Hono()

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.get(
  '/api',
  upgradeWebSocket((_c) => {
    return {
      onOpen(_event, ws) {
        newWebSocketRpcSession(ws.raw!, new MyApiServer())
      }
    }
  })
)

app.post('/api', (c) => {
  return newHttpBatchRpcResponse(c.req.raw, new MyApiServer())
})

const server = serve({
  port: 8787,
  fetch: app.fetch
})

injectWebSocket(server)
