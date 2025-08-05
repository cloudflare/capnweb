import { RpcTarget, RpcStub as RpcStubImpl, RpcPromise as RpcPromiseImpl } from "./core.js";
import { serialize, deserialize } from "./serialize.js";
import { RpcTransport, RpcSession as RpcSessionImpl } from "./rpc.js";
import { Serializable, Stub, Stubify } from "./types.js";

// Re-export public API types.
export { RpcTarget, serialize, deserialize };
export type { RpcTransport };

// Hack the type system to make RpcStub's types work nicely!
export type RpcStub<T extends Serializable<T>> = Stub<T>;
export const RpcStub: {
  new <T extends Serializable<T>>(value: T): RpcStub<T>;
} = <any>RpcStubImpl;

export type RpcPromise<T extends Serializable<T>> = Stub<T> | Promise<Stubify<T>>;
export const RpcPromise: {
  // Note: Cannot construct directly!
} = <any>RpcPromiseImpl;

export interface RpcSession<T extends Serializable<T> = undefined> {
  getRemoteMain(): RpcStub<T>;
  getStats(): {imports: number, exports: number};
}
export const RpcSession: {
  new <T extends Serializable<T> = undefined>(
      transport: RpcTransport, localMain?: any): RpcSession<T>;
} = <any>RpcSessionImpl;

export { receiveRpcOverHttp } from "./worker.js";
export { rpcOverWebSocket } from "./client.js";
