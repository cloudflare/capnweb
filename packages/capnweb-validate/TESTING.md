# Testing `capnweb-validate` by hand

This package is a build-time transform. Users mark RPC service classes with
`@validateRpc()` and keep importing Cap'n Web APIs from `capnweb`. The bundler
plugin or CLI rewrites validation decorators and Cap'n Web client session calls,
then injects generated validators.

## 1. Run the build and tests

From the repo root:

```sh
npm run -w capnweb-validate build
npm run -w capnweb-validate test
```

`build` runs `tsdown` and emits `dist/` entries for the root decorators,
`/capnweb`, `/internal`, `/internal/core`, `/internal/capnweb`, the bundler
adapters, and the CLI. `test` runs the package's Vitest project from the repo
root so the shared `vitest.config.ts` resolves.

The test suite is two files:

- `__tests__/plugin.test.ts` checks marker exports, `RpcValidationError`, the
  transform context, bundler adapters, and `runBuild` orchestration.
- `__tests__/transform-module.test.ts` writes small fixtures to a tempdir,
  builds a real `TransformContext`, runs `transformModule()`, and asserts on
  decorator rewrites, client session rewrites, and emitted validator behavior.

## 2. Drive the transform against a fixture by hand

### 2a. Build the package once

```sh
npm run -w capnweb-validate build
```

This produces `packages/capnweb-validate/dist/cli.cjs`.

### 2b. Write a fixture

```sh
mkdir -p /tmp/cwt-demo/src
cd /tmp/cwt-demo
```

`/tmp/cwt-demo/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src/**/*.ts"]
}
```

`/tmp/cwt-demo/src/capnweb.d.ts` provides minimal stand-ins so the checker can
resolve types without installing `capnweb`:

```ts
declare module "capnweb" {
  export class RpcTarget {}
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  type Provider<T> = { readonly [K in keyof T]: T[K] };
  export type RpcStub<T> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
  export function newWorkersRpcResponse(
    request: Request, target: object, options?: unknown,
  ): Response;
  export function newHttpBatchRpcSession<T>(
    url: string, options?: unknown,
  ): RpcStub<T>;
}
declare module "capnweb-validate" {
  export function validateRpc(...args: unknown[]): unknown;
  export function skipRpcValidation(...args: unknown[]): unknown;
}
```

`/tmp/cwt-demo/src/worker.ts`:

```ts
import { newWorkersRpcResponse, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";

@validateRpc()
class Api extends RpcTarget {
  greet(name: string): string {
    return "hi " + name;
  }
}

export function handler(req: Request): Response {
  return newWorkersRpcResponse(req, new Api());
}
```

### 2c. Run the transform

From this repo:

```sh
node packages/capnweb-validate/dist/cli.cjs build \
  --cwd /tmp/cwt-demo \
  --tsconfig /tmp/cwt-demo/tsconfig.json \
  --out /tmp/cwt-demo/out
```

You should see `capnweb-validate: 1 transformed, 0 copied -> /tmp/cwt-demo/out`.
Declaration files are not transformed or copied.

### 2d. Read the output

`/tmp/cwt-demo/out/src/worker.ts` will contain something like:

```ts
import * as __rt from "capnweb-validate/internal/core";
const __capnweb_validate_Api_server = {
  serviceName: "Api",
  methods: {
    "greet": { args: [__rt.v.string], returns: __rt.v.string },
  },
};
import { newWorkersRpcResponse, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";

@__rt.__validateRpcClass(__capnweb_validate_Api_server)
class Api extends RpcTarget {
  greet(name: string): string {
    return "hi " + name;
  }
}

export function handler(req: Request): Response {
  return newWorkersRpcResponse(req, new Api());
}
```

Things worth checking:

- Source outside edit ranges is preserved by the transform.
- The decorator is rewritten to an internal helper with one validator argument.
- The validator literal is a plain JS object built from `__rt.v.*` primitives.
- The decorator path imports `capnweb-validate/internal/core`, which has no
  runtime dependency on `capnweb`.

### 2e. Try the client-side rewrite too

`/tmp/cwt-demo/src/client.ts`:

```ts
import { newHttpBatchRpcSession, RpcTarget } from "capnweb";

interface Api extends RpcTarget {
  echo(value: string): Promise<string>;
}

export const api = newHttpBatchRpcSession<Api>("/rpc");
```

Re-run the build. `out/src/client.ts` should rewrite the callee to
`__rt.__newHttpBatchRpcSessionWithValidation<Api>("/rpc", __capnweb_validate_Api_client)`.
The `<Api>` type argument is preserved.

### 2f. See the wire-type catalogue at work

Add a method that uses a built-in capnweb supports (`Uint8Array`) and one
capnweb rejects (`Map`):

```ts
class Api extends RpcTarget {
  sign(payload: Uint8Array): Promise<Uint8Array> { /* ... */ }
  index(): Promise<Map<string, number>> { /* ... */ }
}
```

Re-run the build. The `Map` return type makes the build fail before writing a
validator:

```txt
capnweb-validate: /tmp/cwt-demo/src/worker.ts:5:1: capnweb-validate:
`validateRpc` references types that capnweb cannot transport. Fix or replace
these fields:
  - index.return: Map is not a capnweb wire type. Use a plain object or an
    array of entries instead.
```

Replace `Map<string, number>` with `{ [key: string]: number }` and the build is
clean. The `sign` method emits `args: [__rt.v.bytes], returns: __rt.v.bytes`.

## 3. What to look at if something goes wrong

- **"Module is in the program but no rewrite happens"**: the transform only
  considers files whose raw text mentions `capnweb-validate` or `capnweb`.
- **"Could not resolve a concrete service type"**: add `@validateRpc<T>()`,
  make the class implement exactly one public RPC interface, or pass an
  explicit client type argument such as `newHttpBatchRpcSession<Api>(...)`.
- **"References types that capnweb cannot transport"**: your service mentions
  a type the wire format does not support (`Map`, `Set`, `RegExp`, etc.) or an
  unresolvable leaf. The README's type coverage table lists replacements.
- **"Validator validates the wrong thing"**: start in
  `src/transform/type-introspector.ts`, which lowers `ts.Type` values into
  `ServiceShape`.
- **"The transform crashed mid-build"**: crashes are surfaced as build errors.
  The plugin does not swallow `transformModule` errors.

## 4. What this does not test

Wrangler-driven workflows are covered by the example app under
`examples/worker-react/`, not this package's unit tests.
