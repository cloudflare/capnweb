---
title: Runtime Validation
description: Generate runtime validators from your TypeScript types at build time with capnweb-validate.
---

Cap'n Web does not type-check incoming values at runtime; TypeScript types are erased. The
companion package [`capnweb-validate`](https://www.npmjs.com/package/capnweb-validate) closes that
gap by keeping **TypeScript method signatures as the source of truth** and generating validators
from them at build time.

Add `@validateRpc()` to a service class; a bundler plugin or the CLI rewrites the decorator and
injects validators generated from the resolved TypeScript types.

:::note
If a validation decorator is left untransformed, it throws a configuration error rather than
silently running without validation. You cannot accidentally ship an unvalidated service.
:::

## Does this mean defining my API twice?

No, and this is the reason `capnweb-validate` exists in this shape.

"Schemaless" means the *library* needs no schema: Cap'n Web forwards whatever call you make without
being told about it in advance. It does not mean you have no contract. Your contract is the
TypeScript interface, used on both ends. The only problem is that TypeScript is erased before your
code ever meets a hostile input.

There are two honest ways to close that gap without writing the interface out twice:

- **Generate the validators from the types.** That is what `capnweb-validate` does: the TypeScript
  signature stays the single source of truth and the runtime check is derived from it at build time.
- **Generate the types from the validators.** Schema libraries like [Zod](https://zod.dev/) infer
  TypeScript types from the schema object, so you write the schema and get the types for free.
  [ArkType](https://arktype.io/), [typia](https://typia.io/) and
  [ts-runtime-checks](https://github.com/GoogleFeud/ts-runtime-checks) occupy similar territory,
  the last two also transforming TypeScript types directly into checks.

Either way you write one description of the boundary, not two. What you must not do is write only
the TypeScript and assume it is doing something at runtime.

## Install

Two packages, or one if you are on Workers RPC:

```sh
npm install capnweb capnweb-validate
```

Workers RPC users can install `capnweb-validate` without installing `capnweb`. The root package has
no runtime dependency on `capnweb`; Cap'n Web-specific helpers live under `capnweb-validate/capnweb`.

## Server usage

Decorate the class you expose. Every call that arrives is checked against the method's declared
parameter types before your code runs:

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
matching signatures, but it does **not** hide extra public class methods. Keep local-only helpers
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
outgoing arguments; the receiver validates those on arrival.

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

| Option              | Meaning                                               |
| ------------------- | ----------------------------------------------------- |
| `--out <dir>`       | Where to write the transformed source tree. Required. |
| `--tsconfig <path>` | Defaults to `./tsconfig.json`.                        |
| `--cwd <dir>`       | Defaults to `process.cwd()`.                          |

Point the downstream build tool at the generated entry under `--out`.

## Opting out per method

`@skipRpcValidation()` exempts one method from an otherwise validated class:

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

| Boundary      | Failure               | How it surfaces                                             |
| ------------- | --------------------- | ----------------------------------------------------------- |
| Client stub   | Bad resolved return   | The returned promise rejects.                               |
| Server target | Bad incoming argument | The server throws and the caller observes an RPC rejection. |

## Type coverage

The supported set matches Cap'n Web's published wire format: every type Cap'n Web guarantees can
travel over RPC also has a precise build-time validator. That includes primitives and literal types,
arrays, tuples, `Map`/`Set`, plain object shapes, unions, `Record`/index signatures, `Promise<T>`
returns, and the RPC-compatible built-ins (`Date`, `ArrayBuffer`, typed arrays, `Error` subclasses,
`Blob`, streams, `URL`, `Headers`, `Request`, `Response`). Pass-by-reference values are validated
as stubs: functions, `RpcStub<T>`, `RpcPromise<T>`, `RpcTarget` subclasses, and Workers
`Fetcher<T>`.

These are rejected **at build time** so you find out before the first RPC call:

| Type                | Reason                                |
| ------------------- | ------------------------------------- |
| `WeakMap`           | Not a supported RPC validation type.  |
| `WeakSet`           | Not a supported RPC validation type.  |
| `SharedArrayBuffer` | Not a supported RPC validation type.  |
| `File`              | Use a `Blob` or `Uint8Array` instead. |

Overloaded methods are passed through unvalidated with a warning. Validating against one signature
would reject valid calls to the others. Collapse the overloads into a single signature with union
parameters, or use `@skipRpcValidation()` to silence the warning.

For generics, the transform emits one validator at the class declaration, so it cannot specialize
per-`new`-expression. Use an explicit surface such as `@validateRpc<Cursor<string>>()` when the type
arguments are known at the decorator site. An unconstrained type parameter defaults to `any` with a
warning; a constrained one validates against its constraint.

## Schema evolution

A validator built from one version of your types will eventually meet a peer built from another.
Additive changes go through; changes that would let an unchecked value reach your code do not:

| Change                                 | Result  |
| -------------------------------------- | ------- |
| Extra argument                         | Allowed |
| Extra object property                  | Allowed |
| Extra index-signature key              | Allowed |
| New optional parameter or property     | Allowed |
| Missing required parameter or property | Refused |
| Renamed or retyped member              | Refused |
| Changed tuple length, no rest element  | Refused |
| New union member                       | Refused |
| New method                             | Refused |

To remove a required member, make it optional in one release and delete it in a later one, so no
build ever requires something a peer has already stopped sending.

"Allowed" is not the same as "visible". Extra arguments are **dropped before the method runs**, so an
implementation cannot read an argument no validator checked:

```ts
// spec generated from: greet(name: string)
greet(name: string, ...rest: unknown[]) {
  // rest is always empty
}

// spec generated from: sum(label: string, ...values: number[])
sum(label: string, ...values: number[]) {
  // gets every argument, each one validated
}
```

Truncation only applies where the spec declares its parameters. A client-side spec omits `args`
entirely, so nothing is dropped there. Extra *object properties*, by contrast, are forwarded to the
implementation unvalidated; an index signature is the exception, since it validates every property
outside the declared ones.

Keep `strictNullChecks` on. Without it TypeScript erases `null` from your types, and the generated
validator will refuse a `null` that a peer built with the flag on considers perfectly valid.

Full details are in the
[`capnweb-validate` README](https://github.com/cloudflare/capnweb/tree/main/packages/capnweb-validate).
