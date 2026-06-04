# capnweb-validate

Build-time runtime validation for Cap'n Web and Workers RPC services.

`capnweb-validate` keeps TypeScript method signatures as the source of
truth. Add `@validateRpc()` to the service class; a bundler plugin or CLI
rewrites the decorator and injects validators generated from the resolved
TypeScript types. Cap'n Web client sessions can also be wrapped for client-side
argument and return-value checks.

If a validation decorator is left untransformed, it throws with a configuration
error instead of silently running without validation.

## Install

```sh
npm install capnweb capnweb-validate
```

Workers RPC users can install `capnweb-validate` without installing `capnweb`.
The root package has no runtime dependency on `capnweb`; Cap'n Web-specific
helpers live under `capnweb-validate/capnweb` and internal transform outputs.

## Server Usage

```ts
import { newWorkersRpcResponse, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";

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

`@validateRpc()` validates calls on class instances, so it works with Cap'n Web,
Workers `WorkerEntrypoint`, and Workers `DurableObject` services.

The RPC surface is the class's public string-named methods and RPC-readable
getters/properties, matching Cap'n Web dispatch. `implements SomeInterface` and
`@validateRpc<SomeInterface>()` only sharpen matching signatures; they do not
hide extra public class methods. Keep local-only helpers private or symbol-named.

## Generic service classes

A decorator emits one validator at the class declaration. If the class itself
is generic, the transform cannot specialize that validator for each later
`new` expression.

Use an explicit signature source when type arguments are known at the decorator
site:

```ts
@validateRpc<Gatekeeper<GmailSession, number, undefined>>()
class GmailGatekeeper
  extends RpcTarget
  implements Gatekeeper<GmailSession, number, undefined> {
  // ...
}
```

A generic implementation class needs no annotation. An unconstrained type
parameter defaults to `any` with a warning; a constrained parameter validates
against its constraint:

```ts
@validateRpc()
class ArrayCursor<T> extends RpcTarget implements Cursor<T> {
  // `T` defaults to `any` (warned). `<T extends Session>` would validate
  // those positions against `Session`.
}
```

Pass `@validateRpc<Cursor<string>>()` to validate matching generic positions, or
`@validateRpc<Cursor<any>>()` to silence the warning. Either way, the class's
public RPC surface is still validated; `any` positions are permissive.

## Client Usage

```ts
import { newHttpBatchRpcSession } from "capnweb";

import type { Api } from "./worker";

export const api = newHttpBatchRpcSession<Api>("/rpc");
```

Cap'n Web client session constructors are also recognized. Client calls validate
outgoing arguments before transport and resolved return values before application
code receives them. Native Workers RPC clients are not wrapped client-side; use
`@validateRpc()` on the service class to validate the server boundary.

For custom transports built on top of `RpcSession`, the constructor form is
also recognized:

```ts
import { RpcSession } from "capnweb";

import type { Api } from "./worker";

const session = new RpcSession<Api>(myTransport);
const api = session.getRemoteMain();
```

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

Use `@skipRpcValidation()` when one RPC method should not get generated
argument or return validators:

```ts
import { RpcTarget } from "capnweb";
import { skipRpcValidation, validateRpc } from "capnweb-validate";

@validateRpc()
class Api extends RpcTarget {
  @skipRpcValidation()
  unsafe(payload: unknown): unknown {
    return payload;
  }
}
```

The method still goes through capnweb normally. This only disables
capnweb-validate validation for that method.

## Validation Errors

Validation failures throw `TypeError`, so validation errors keep their standard
error type when they cross RPC boundaries. The message includes the failing path,
expected type, and actual type:

```ts
try {
  await api.authenticate(123 as never);
} catch (err) {
  if (err instanceof TypeError) {
    console.log(err.message);
  }
}
```

Where errors surface depends on which boundary failed:

| Boundary | Failure | How it surfaces |
| -------- | ------- | --------------- |
| Client outgoing call | Bad argument before transport | The stub method throws synchronously. |
| Client resolved return | Bad return after transport | The returned promise rejects before user callbacks run. |
| Server target | Bad incoming argument or outgoing return | The server throws and the caller observes an RPC rejection. |

## Current Type Coverage

The supported set matches capnweb's published wire format. Every type capnweb
guarantees can travel over RPC also has a precise build-time validator:

**Pass-by-value:**

- Primitives: `string`, `number`, `boolean`, `null`, `undefined`, `bigint`,
  `any`, `unknown`, plus string / number / boolean literal types. `any` and
  `unknown` use a permissive validator.
- Containers: arrays, tuples (validated by exact length and per-position
  element type), plain object shapes, unions, `Record<K, T>` and index
  signatures (string and numeric keys both validate their value type, since
  object keys cross the wire as strings), and `Promise<T>` return values
  (unwrapped one level). Optional properties (`foo?: T`) widen to
  `T | undefined`, matching how the wire deserializes a missing key.
- Built-ins from capnweb's catalogue: `Date`, `Uint8Array`, `Error` and its
  standard subclasses (`EvalError`, `RangeError`, `ReferenceError`,
  `SyntaxError`, `TypeError`, `URIError`, `AggregateError`), `Blob`,
  `ReadableStream`, `WritableStream`, `Headers`, `Request`, `Response`.

capnweb serializes the built-ins above by exact prototype (except `Error`,
matched by `instanceof`). A subclass instance reaching a base-typed position
therefore validates here but fails to serialize; `File` is the common case and
is rejected at build time for that reason (see below).

**Pass-by-reference:**

- Plain functions (validated as `typeof === "function"`).
- `RpcStub<T>` and `RpcPromise<T>` by symbol name, and any user-defined class
  that extends `RpcTarget` (the resolver walks `getBaseTypes`).
- Workers RPC `Fetcher<T>` values and branded `RpcTarget` /
  `WorkerEntrypoint` capabilities. These are validated as pass-through stubs;
  lifecycle methods such as `fetch`, `queue`, and `tail` remain pass-through.

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
| `File`             | Use a `Blob` or `Uint8Array`; `File` is not a wire type.   |

This list follows capnweb's wire catalogue. A host may accept more: Workers RPC
transports `Map`, `Set`, `RegExp`, `ArrayBuffer`, and typed arrays via structured
clone. To accept those on such a host, pass `onUnsupportedType`, which decides
each otherwise-rejected type. Returning `"passthrough"` validates it as `any`
(the host serializes it); the default is a build error.

```ts
capnwebValidate({
  // Accept the structured-clone types Workers RPC supports but capnweb does not.
  onUnsupportedType: ({ typeName }) =>
    ["Map", "Set", "RegExp", "ArrayBuffer"].includes(typeName) ? "passthrough" : "reject",
});
```

If a method signature contains a leaf the resolver cannot lower, such as a generic
type parameter with no inference source, an unsupported recursive corner, or a rejected
built-in nested inside an object, the transform fails at the call site with a
class-qualified list of every offending field. You fix them in one pass rather
than rebuilding once per field.

Recursive object and union shapes are emitted with lazy back-references. The
resolver also has a guardrail for pathological non-recursive nesting. If the
lowered type graph exceeds the internal resolution depth limit, it fails with
`type exceeds maximum resolution depth (64)`.

An overloaded method exposes several call signatures; validating against one
would reject valid calls to the others. Overloaded methods are passed through
unvalidated with a warning. Collapse the overloads into a single signature with
union parameters to validate the method, or `@skipRpcValidation()` to silence
the warning.

## License

MIT.
