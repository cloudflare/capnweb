// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Cap'n Web-specific runtime helpers. The decorator runtime lives in
// ./core.ts and intentionally has no capnweb dependency.

import * as capnweb from "capnweb";
import {
  splitTrailingValidator,
  wrapClientStub,
  wrapServerTarget,
  type ServiceValidator,
} from "./core.js";
export {
  __validateRpcClass,
  v,
  type MethodSpec,
  type ServiceValidator,
  type Validator,
} from "./core.js";

export function __newWorkersRpcResponseWithValidation(
  request: Request,
  localMain: object,
  validator: ServiceValidator
): Promise<Response> {
  return capnweb.newWorkersRpcResponse(
    request,
    wrapServerTarget(localMain, validator)
  );
}

export function __newHttpBatchRpcResponseWithValidation(
  request: Request,
  localMain: object,
  ...rest:
    | [ServiceValidator]
    | [capnweb.RpcSessionOptions | undefined, ServiceValidator]
): Promise<Response> {
  let { args, validator } = splitTrailingValidator(rest);
  let [options] = args as [capnweb.RpcSessionOptions?];
  return capnweb.newHttpBatchRpcResponse(
    request,
    wrapServerTarget(localMain, validator),
    options
  );
}

export function __newWorkersWebSocketRpcResponseWithValidation(
  request: Request,
  localMain: object,
  ...rest:
    | [ServiceValidator]
    | [capnweb.RpcSessionOptions | undefined, ServiceValidator]
): Response {
  let { args, validator } = splitTrailingValidator(rest);
  let [options] = args as [capnweb.RpcSessionOptions?];
  return capnweb.newWorkersWebSocketRpcResponse(
    request,
    wrapServerTarget(localMain, validator),
    options
  );
}

export function __nodeHttpBatchRpcResponseWithValidation<
  Req extends { method?: string; url?: string; headers?: unknown },
  Res extends object
>(
  request: Req,
  response: Res,
  localMain: object,
  ...rest:
    | [ServiceValidator]
    | [capnweb.RpcSessionOptions | undefined, ServiceValidator]
): Promise<void> {
  let { args, validator } = splitTrailingValidator(rest);
  let [options] = args as [capnweb.RpcSessionOptions?];
  return (
    capnweb.nodeHttpBatchRpcResponse as unknown as (
      req: Req,
      res: Res,
      target: unknown,
      opts?: capnweb.RpcSessionOptions
    ) => Promise<void>
  )(request, response, wrapServerTarget(localMain, validator), options);
}

export function __newHttpBatchRpcSessionWithValidation<T>(
  urlOrRequest: string | Request,
  ...rest:
    | [ServiceValidator]
    | [capnweb.RpcSessionOptions | undefined, ServiceValidator]
): T {
  let { args, validator } = splitTrailingValidator(rest);
  let [options] = args as [capnweb.RpcSessionOptions?];
  let stub = capnweb.newHttpBatchRpcSession(urlOrRequest, options);
  return wrapClientStub(stub as unknown as object, validator) as T;
}

export function __newWebSocketRpcSessionWithValidation<T>(
  webSocket: WebSocket | string,
  ...rest:
    | [ServiceValidator]
    | [unknown, ServiceValidator]
    | [unknown, capnweb.RpcSessionOptions | undefined, ServiceValidator]
): T {
  let { args, validator } = splitTrailingValidator(rest);
  let [localMain, options] = args as [unknown?, capnweb.RpcSessionOptions?];
  let stub = capnweb.newWebSocketRpcSession(webSocket, localMain, options);
  return wrapClientStub(stub as unknown as object, validator) as T;
}

export function __newMessagePortRpcSessionWithValidation<T>(
  port: MessagePort,
  ...rest:
    | [ServiceValidator]
    | [unknown, ServiceValidator]
    | [unknown, capnweb.RpcSessionOptions | undefined, ServiceValidator]
): T {
  let { args, validator } = splitTrailingValidator(rest);
  let [localMain, options] = args as [unknown?, capnweb.RpcSessionOptions?];
  let stub = capnweb.newMessagePortRpcSession(port, localMain, options);
  return wrapClientStub(stub as unknown as object, validator) as T;
}

export function __newRpcSessionWithValidation<
  T extends capnweb.RpcCompatible<T>
>(
  transport: capnweb.RpcTransport,
  ...rest:
    | [ServiceValidator]
    | [unknown, ServiceValidator]
    | [unknown, capnweb.RpcSessionOptions | undefined, ServiceValidator]
): capnweb.RpcSession<T> {
  let { args, validator } = splitTrailingValidator(rest);
  let [localMain, options] = args as [unknown?, capnweb.RpcSessionOptions?];
  let session = new capnweb.RpcSession<T>(
    transport,
    localMain as undefined,
    options
  );
  return new Proxy(session, {
    get(target, prop, receiver) {
      let orig = Reflect.get(target, prop, receiver);
      if (prop === "getRemoteMain" && typeof orig === "function") {
        return function (): unknown {
          let remote = (orig as () => unknown).call(target);
          return wrapClientStub(remote as object, validator);
        };
      }
      return typeof orig === "function" ? orig.bind(target) : orig;
    },
  });
}
