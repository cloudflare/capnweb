---
title: Runtime Validation
description: Generate runtime validators from your TypeScript types at build time with capnweb-validate.
---

Cap'n Web does not type-check incoming values at runtime — TypeScript types are erased. The
companion package [`capnweb-validate`](https://www.npmjs.com/package/capnweb-validate) closes that
gap by keeping **TypeScript method signatures as the source of truth** and generating validators
from them at build time.

Add `@validateRpc()` to a service class; a bundler plugin or the CLI rewrites the decorator and
injects validators generated from the resolved TypeScript types.

:::note
If a validation decorator is left untransformed, it throws a configuration error rather than
silently running without validation. You cannot accidentally ship an unvalidated service.
:::

## Install

```sh
npm install capnweb capnweb-validate
```

Workers RPC users can install `capnweb-validate` without installing `capnweb`. The root package has
no runtime dependency on `capnweb`; Cap'n Web-specific helpers live under `capnweb-validate/capnweb`.

## Server usage

```ts
import { newWorkersRpcResponse, RpcTarget } from 'capnweb';
import { validateRpc } from 'capnweb-validate';

type User = { id: string; name: string };

@validateRpc()
export class Api extends RpcTarget {
  async authenticate(sessionToken: string): Promise<User> {
    // ...
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return newWorkersRpcResponse(request, new Api());
  },
};
```

`@validateRpc()` validates calls on class instances, so it works with Cap'n Web, Workers
`WorkerEntrypoint`, and Workers `DurableObject` services.

With no explicit type argument, the RPC surface is the class's public string-named methods and
RPC-readable getters/properties, matching Cap'n Web dispatch. `implements SomeInterface` can sharpen
matching signatures, but it does **not** hide extra public class methods — keep local-only helpers
private or symbol-named.

An explicit `@validateRpc<SomeInterface>()` makes `SomeInterface` the RPC surface. Public class
methods outside that interface are rejected over RPC.

## Client usage

Client-side stub validation is explicit. Wrap a client stub with `validateStub<T>()` when the caller
wants return values and pipelined calls checked against a concrete surface:

```ts
import { newHttpBatchRpcSession } from 'capnweb';
import { validateStub } from 'capnweb-validate';

import type { Api } from './worker';

export const api = validateStub<Api>(newHttpBatchRpcSession<Api>('/rpc'));
```

`validateStub<T>()` validates resolved return values on the caller side. It does **not** validate
outgoing arguments — the receiver validates those on arrival.

## Wiring it into your build

### Bundler plugins

```ts
import capnwebValidate from 'capnweb-validate/vite';    // or
import capnwebValidate from 'capnweb-validate/rollup';  // or
import capnwebValidate from 'capnweb-validate/webpack'; // or
import capnwebValidate from 'capnweb-validate/rspack';  // or
import capnwebValidate from 'capnweb-validate/esbuild'; // or
import capnwebValidate from 'capnweb-validate/farm';

export default {
  plugins: [capnwebValidate()],
};
```

The plugin transforms matching modules in memory; your source files are not modified on disk.

### CLI

Wrangler does not expose a bundler plugin hook. For Wrangler, CI, or any flow that needs transformed
files on disk:

```sh
capnweb-validate build --out .capnweb-validate
```

| Option              | Meaning                                              |
| ------------------- | ---------------------------------------------------- |
| `--out <dir>`       | Where to write the transformed source tree. Required. |
| `--tsconfig <path>` | Defaults to `./tsconfig.json`.                        |
| `--cwd <dir>`       | Defaults to `process.cwd()`.                          |

Point the downstream build tool at the generated entry under `--out`.

## Opting out per method

```ts
import { RpcTarget } from 'capnweb';
import { skipRpcValidation, validateRpc } from 'capnweb-validate';

@validateRpc()
class Api extends RpcTarget {
  @skipRpcValidation()
  unsafe(payload: unknown): unknown {
    return payload;
  }
}
```

The method still goes through Cap'n Web normally. This only disables `capnweb-validate` validation
for that method.

## Validation errors

Failures throw `TypeError`, so they keep their standard error type when crossing RPC boundaries. The
message includes the failing path, expected type, and actual type.

| Boundary      | Failure                | How it surfaces                                             |
| ------------- | ---------------------- | ----------------------------------------------------------- |
| Client stub   | Bad resolved return    | The returned promise rejects.                                |
| Server target | Bad incoming argument  | The server throws and the caller observes an RPC rejection.  |

## Type coverage

The supported set matches Cap'n Web's published wire format: every type Cap'n Web guarantees can
travel over RPC also has a precise build-time validator. That includes primitives and literal types,
arrays, tuples, `Map`/`Set`, plain object shapes, unions, `Record`/index signatures, `Promise<T>`
returns, and the RPC-compatible built-ins (`Date`, `ArrayBuffer`, typed arrays, `Error` subclasses,
`Blob`, streams, `Headers`, `Request`, `Response`). Pass-by-reference values — functions,
`RpcStub<T>`, `RpcPromise<T>`, `RpcTarget` subclasses, and Workers `Fetcher<T>` — are validated as
stubs.

These are rejected **at build time** so you find out before the first RPC call:

| Type                | Reason                                        |
| ------------------- | --------------------------------------------- |
| `WeakMap`           | Not a supported RPC validation type.           |
| `WeakSet`           | Not a supported RPC validation type.           |
| `SharedArrayBuffer` | Not a supported RPC validation type.           |
| `File`              | Use a `Blob` or `Uint8Array` instead.          |

Overloaded methods are passed through unvalidated with a warning — validating against one signature
would reject valid calls to the others. Collapse the overloads into a single signature with union
parameters, or use `@skipRpcValidation()` to silence the warning.

For generics, the transform emits one validator at the class declaration, so it cannot specialize
per-`new`-expression. Use an explicit surface such as `@validateRpc<Cursor<string>>()` when the type
arguments are known at the decorator site. An unconstrained type parameter defaults to `any` with a
warning; a constrained one validates against its constraint.

Full details are in the
[`capnweb-validate` README](https://github.com/cloudflare/capnweb/tree/main/packages/capnweb-validate).
