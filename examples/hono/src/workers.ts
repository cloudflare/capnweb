import { Hono } from 'hono'
import { newWorkersRpcResponse } from '../../../dist/index.js'
import { MyApiServer } from './my-api-server'

const app = new Hono()

app.all('/api', (c) => {
  return newWorkersRpcResponse(c.req.raw, new MyApiServer())
})

export default app
