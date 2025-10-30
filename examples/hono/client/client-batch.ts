import { newHttpBatchRpcSession, RpcStub } from '../../../dist/index.js'
import type { PublicApi } from '../src/my-api-server'

const stub: RpcStub<PublicApi> = newHttpBatchRpcSession<PublicApi>('http://localhost:8787/api')

console.log(await stub.hello("Cap'n Web"))
