import { RpcTarget } from '../../../dist'

export interface PublicApi {
  hello(name: string): string
}

export class MyApiServer extends RpcTarget implements PublicApi {
  hello(name: string) {
    return `Hello, ${name}!`
  }
}
