# Testing `capnweb-validate` by hand

This package is a build-time transform. Users import marker APIs from
`capnweb-validate`; the bundler plugin or CLI rewrites those call sites and
injects validators that run at runtime.

This doc covers two things:

1. How to run the package's own test + build pipeline.
2. How to drive the transform against a one-file fixture by hand so you can
   read the rewritten output and confirm a real validator was emitted.

## 1. Run the build + tests

From the repo root:

```sh
npm run -w capnweb-validate build
npm run -w capnweb-validate test
```

`build` runs `tsdown` and emits `dist/` (one file per entry: root,
`/internal`, `/vite`, `/rollup`, `/webpack`, `/rspack`, `/esbuild`, `/farm`,
and the `cli`). `test` runs the package's vitest project from the repo root
so the shared `vitest.config.ts` resolves.

The test suite is two files:

- `__tests__/plugin.test.ts` checks marker exports, `RpcValidationError`, the
  transform context, bundler adapters, and `runBuild` orchestration.
- `__tests__/transform-module.test.ts` writes small fixtures to a tempdir,
  builds a real `TransformContext`, runs `transformModule()`, and asserts on
  the rewritten code. One case evaluates the emitted validator against the live
  runtime to prove `RpcValidationError` fires.

## 2. Drive the transform against a fixture by hand

The simplest path is to write a `.ts` file, point the CLI at it, and read
`./out/`.

### 2a. Build the package once

```sh
npm run -w capnweb-validate build
```

This produces `packages/capnweb-validate/dist/cli.cjs`, which is what `npm`
links as the `capnweb-validate` bin.

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
}
declare module "capnweb-validate" {
  export function newWorkersRpcResponse(
    request: Request, target: object, options?: unknown,
  ): Response;
  export function newHttpBatchRpcSession<T>(
    url: string, options?: unknown,
  ): T;
}
```

`/tmp/cwt-demo/src/worker.ts`:

```ts
import { newWorkersRpcResponse } from "capnweb-validate";
import { RpcTarget } from "capnweb";

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
`capnweb.d.ts` is a declaration file, so it is not transformed or copied.

### 2d. Read the output

`/tmp/cwt-demo/out/src/worker.ts` will contain something like:

```ts
import * as __rt from "capnweb-validate/internal";
const __capnweb_typecheck_Api_server = {
  serviceName: "Api",
  methods: {
    "greet": { args: [__rt.v.string], returns: __rt.v.string },
  },
};
import { newWorkersRpcResponse } from "capnweb-validate";
import { RpcTarget } from "capnweb";

class Api extends RpcTarget {
  greet(name: string): string {
    return "hi " + name;
  }
}

export function handler(req: Request): Response {
  return __rt.__newWorkersRpcResponsewithValidation(req, new Api(), __capnweb_typecheck_Api_server);
}
```

Things worth checking on that output:

- Source outside edit ranges is preserved by the transform.
- The marker call site is rewritten to an internal helper with one added
  validator argument.
- The validator literal is a plain JS object built from `__rt.v.*` primitives.
- The internal runtime import is inserted by the transform.

### 2e. Make it fail to see the error path

Change the call site so the checker can't pin a concrete service type:

```ts
export function handler(req: Request, target: RpcTarget): Response {
  return newWorkersRpcResponse(req, target); // type RpcTarget: too generic
}
```

Re-running the CLI prints a build error pointing at the file, line, and column:

```txt
capnweb-validate: /tmp/cwt-demo/src/worker.ts:5:10: capnweb-validate:
could not resolve a concrete service type for
`newWorkersRpcResponse(...)`. Annotate the target argument with a
specific RPC service type (e.g. `new MyApi(env)` or
`const target: MyApi = ...`).
```

This is covered by `transformModule: failure modes` in
`__tests__/transform-module.test.ts`.

### 2f. Try the client-side rewrite too

`/tmp/cwt-demo/src/client.ts`:

```ts
import { newHttpBatchRpcSession } from "capnweb-validate";
import { RpcTarget } from "capnweb";

interface Api extends RpcTarget {
  echo(value: string): Promise<string>;
}

export const api = newHttpBatchRpcSession<Api>("/rpc");
```

Re-run the build. `out/src/client.ts` should rewrite the callee to
`__rt.__newHttpBatchRpcSessionwithValidation<Api>("/rpc", __capnweb_typecheck_Api_client)`.
The `<Api>` type argument is preserved.

### 2g. See the wire-type catalogue at work

Add a method that uses a built-in capnweb supports (`Uint8Array`) and one
capnweb rejects (`Map`):

```ts
class Api extends RpcTarget {
  sign(payload: Uint8Array): Promise<Uint8Array> { /* ... */ }
  index(): Promise<Map<string, number>> { /* ... */ }
}
```

Re-run the build. The transform emits:

```ts
const __capnweb_typecheck_Api_server = {
  serviceName: "Api",
  methods: {
    "sign":  { args: [__rt.v.bytes], returns: __rt.v.bytes },
    "index": { args: [], returns: /* ...error... */ },
  },
};
```

— actually the `Map` return type makes the build _fail_ before printing
anything:

```
capnweb-validate: /tmp/cwt-demo/src/worker.ts:10:10: capnweb-validate:
  `newWorkersRpcResponse(...)` references types that capnweb cannot transport.
  Fix or replace these fields:
    - index.return: Map is not a capnweb wire type. Use a plain object or an
      array of entries instead.
```

The error lists every offending leaf in one pass (e.g. `args[0].userId`,
`return.results[].when`), so a service with five bad fields needs one
fix-and-rebuild cycle, not five. Replace `Map<string, number>` with
`{ [key: string]: number }` and the build is clean. The `sign` method then
emits `args: [__rt.v.bytes], returns: __rt.v.bytes` — at runtime that calls
`value instanceof Uint8Array`, so any of the typed-array siblings the checker
recognised as `bytes` validate the same way.

For the matching client-side picture, declare the same shape on a
`newHttpBatchRpcSession<Api>("/rpc")` call and read the rewritten
`out/src/client.ts`. The `_client` validator is structurally identical to
`_server` — same `bytes` leaves, same path-aware error if the remote ever
returns a non-`Uint8Array`.

## 3. What to look at if something goes wrong

- **"Module is in the program but no rewrite happens"** — the transform
  short-circuits on files whose raw text does not contain
  `"capnweb-validate"`. Confirm your import string is exact.
- **"Could not resolve a concrete service type"** — annotate the call site so
  the checker can pin one. Construct the target inline (`new Api()`), pass an
  explicit client type argument (`newHttpBatchRpcSession<Api>(...)`), or
  annotate the variable.
- **"References types that capnweb cannot transport"** — your service mentions
  a type the wire format does not support (`Map`, `Set`, `RegExp`, etc.) or
  contains an unresolvable leaf (a generic parameter, a bare `unknown`). The
  README's "Current Type Coverage" table lists the rejected built-ins with the
  suggested replacement. This is by design — silently downgrading to a
  permissive validator would let bad data ship.
- **"Validator validates the wrong thing"** — `src/transform/type-introspector.ts`
  lowers `ts.Type` values into `ServiceShape`; start there.
- **"The transform crashed mid-build"** — crashes are intentionally surfaced as
  build errors. The plugin does not swallow `transformModule` errors.

## 4. What this does not test

Wrangler-driven workflows are covered by the example app under
`examples/worker-react-typecheck/`, not this package's unit tests.
