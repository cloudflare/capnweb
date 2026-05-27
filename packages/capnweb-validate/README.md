# capnweb-validate

Build-time runtime validation for [capnweb](https://github.com/cloudflare/capnweb) RPC services.

`capnweb-validate` keeps TypeScript method signatures as the source of
truth. You import RPC boundary APIs from `capnweb-validate`; a bundler plugin
or CLI rewrites those call sites and injects validators generated from the
resolved TypeScript types.

If the transform does not run, the marker APIs throw with a configuration
error instead of silently running without validation.

## Install

```sh
npm install capnweb capnweb-validate
```

## Server Usage

```ts
import { newWorkersRpcResponse, RpcTarget } from "capnweb-validate";

type User = { id: string; name: string };

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

The transform resolves the concrete service type at `newWorkersRpcResponse(...)`,
emits a private validator for `Api`, and rewrites the call to an internal helper.

## Client Usage

```ts
import { newHttpBatchRpcSession } from "capnweb-validate";

import type { Api } from "./worker";

export const api = newHttpBatchRpcSession<Api>("/rpc");
```

For custom transports built on top of `RpcSession`, the constructor form is
also a marker:

```ts
import { RpcSession } from "capnweb-validate";

import type { Api } from "./worker";

const session = new RpcSession<Api>(myTransport);
const api = session.getRemoteMain();
```

Either form drives the same validator. Client calls validate outgoing arguments
before transport and validate resolved return values before application code
receives them.

## Bundler Plugins

Use the adapter that matches your bundler:

```ts
import capnwebValidate from "capnweb-validate/vite";     // or
import capnwebValidate from "capnweb-validate/rollup";    // or
import capnwebValidate from "capnweb-validate/webpack";   // or
import capnwebValidate from "capnweb-validate/rspack";    // or
import capnwebValidate from "capnweb-validate/esbuild";   // or
import capnwebValidate from "capnweb-validate/farm";

export default {
  plugins: [capnwebValidate()],
};
```

The plugin transforms matching modules in memory; user source files are not
modified on disk.

## CLI

Wrangler does not expose a bundler plugin hook. For Wrangler, CI, or any flow
that needs transformed files on disk, run:

```sh
capnweb-validate build --out .capnweb-validate
```

Options:

- `--out <dir>` writes the transformed source tree. Required.
- `--tsconfig <path>` defaults to `./tsconfig.json`.
- `--cwd <dir>` defaults to `process.cwd()`.

Point the downstream build tool at the generated entry under `--out`.

## Opting out per method

Use `@skipRpcValidation` when one RPC method should not get generated
argument or return validators:

```ts
import { RpcTarget, skipRpcValidation } from "capnweb-validate";

class Api extends RpcTarget {
  @skipRpcValidation
  unsafe(payload: unknown): unknown {
    return payload;
  }
}
```

The method still goes through capnweb normally. This only disables
capnweb-validate validation for that method.

## Validation Errors

Validation failures throw `RpcValidationError`, exported from
`capnweb-validate`. It extends `TypeError` and carries structured detail in
`error.rpcValidation`:

```ts
import { RpcValidationError } from "capnweb-validate";

try {
  await api.authenticate(123 as never);
} catch (err) {
  if (err instanceof RpcValidationError) {
    console.log(err.rpcValidation.path, err.rpcValidation.expected);
  }
}
```

## Current Type Coverage

The supported set matches capnweb's published wire format. Every type capnweb
guarantees can travel over RPC also has a precise build-time validator:

**Pass-by-value:**

- Primitives: `string`, `number`, `boolean`, `null`, `undefined`, `bigint`,
  `any`, `unknown`, plus string / number / boolean literal types. `any` and
  `unknown` use a permissive validator.
- Containers: arrays, tuples (validated by exact length and per-position
  element type), plain object shapes, unions, `Record<string, T>` and string
  index signatures, and `Promise<T>` return values (unwrapped one level).
  Optional properties (`foo?: T`) widen to `T | undefined`, matching how the
  wire deserializes a missing key. Numeric index signatures are not treated
  as dictionary schemas; use arrays for ordered numeric collections.
- Built-ins from capnweb's catalogue: `Date`, `Uint8Array`, `Error` and its
  standard subclasses (`EvalError`, `RangeError`, `ReferenceError`,
  `SyntaxError`, `TypeError`, `URIError`, `AggregateError`), `Blob` (and
  `File`, which extends `Blob`), `ReadableStream`, `WritableStream`,
  `Headers`, `Request`, `Response`.

**Pass-by-reference:**

- Plain functions (validated as `typeof === "function"`).
- `RpcStub<T>` and `RpcPromise<T>` by symbol name, and any user-defined class
  that extends `RpcTarget` (the resolver walks `getBaseTypes`).

**Rejected types**: capnweb intentionally does not transport these, and the
transform refuses to compile a service that uses them so the user finds out at
build time, not at the first RPC call:

| Type               | Build error hint                                           |
| ------------------ | ---------------------------------------------------------- |
| `Map`              | Use a plain object or an array of entries instead.         |
| `Set`              | Use an array instead.                                      |
| `WeakMap`          | `WeakMap` is not a capnweb wire type.                      |
| `WeakSet`          | `WeakSet` is not a capnweb wire type.                      |
| `ArrayBuffer`      | Use `Uint8Array` instead.                                  |
| `SharedArrayBuffer`| `SharedArrayBuffer` is not a capnweb wire type.            |
| `RegExp`           | `RegExp` is not a capnweb wire type.                       |
| `DataView`         | Use `Uint8Array` instead.                                  |
| Other typed arrays | Use `Uint8Array` instead.                                  |

If a method signature contains a leaf the resolver cannot lower, such as a generic
type parameter with no inference source, an unsupported recursive corner, or a rejected
built-in nested inside an object, the transform fails at the call site with a
JSON-pointer-style list of every offending field. You fix them in one pass
rather than rebuilding once per field.

## License

MIT.
