---
title: Installation
description: Install Cap'n Web from npm, and the TypeScript settings you need for `using` declarations.
---

Cap'n Web is [a single npm package](https://www.npmjs.com/package/capnweb) with no dependencies.

```sh
npm i capnweb
```

There is no build step, no schema compiler, and no code generation. Import it and go:

```ts
import { RpcTarget, RpcStub, newWebSocketRpcSession } from 'capnweb';
```

## Runtime support

Cap'n Web works in all major browsers, Cloudflare Workers, Node.js, Bun, Deno, and other modern
JavaScript runtimes. The package ships runtime-specific entry points and your bundler or runtime
will pick the right one automatically:

| Runtime            | Notes                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Browsers           | `fetch` and `WebSocket` are used directly.                          |
| Cloudflare Workers | Uses the `workerd` export condition; `RpcTarget` aliases the built-in. |
| Node.js            | Use the [`ws`](https://www.npmjs.com/package/ws) package for server-side WebSockets. |
| Deno               | Import as `npm:capnweb`.                                            |
| Bun                | Uses the `bun` export condition.                                    |

Beyond `fetch` or `WebSocket`, Cap'n Web's serializer inspects a handful of WHATWG globals to decide
how to encode a value, and expects them to exist: `ReadableStream`, `WritableStream`, `Blob`, `URL`,
`Headers`, `Request` and `Response`. All five runtimes above provide them.

Other JavaScript environments may need help. [React Native](https://reactnative.dev/) is the usual
example: it has `fetch`, `WebSocket`, `Blob` and `URL`, but no `ReadableStream` or
`WritableStream`, so you will need a WHATWG streams polyfill loaded before `capnweb`. React Native
is not covered by CI, so treat it as untested rather than unsupported; a CI contribution would be
very welcome.

If a runtime has no suitable network API at all, you can still use Cap'n Web by supplying a
[custom transport](/transports/custom/) over any bidirectional message stream.

## TypeScript setup

Cap'n Web is written in TypeScript and ships its own types; you do not need a `@types` package.

Stubs integrate with JavaScript's
[explicit resource management](https://v8.dev/features/explicit-resource-management), so many
examples in these docs use `using` declarations. To compile `using`, your `tsconfig.json` needs a
recent target and the matching libs:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "lib": ["esnext", "dom"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true
  }
}
```

`using` became widely available in JavaScript engines in mid-2025, and has been supported via
transpilers and polyfills for a few years before that. If you cannot use it, every disposable value
also has an explicit `[Symbol.dispose]()` method you can call yourself. See
[Disposal](/concepts/disposal/).

## Optional: build-time validation

Cap'n Web does not perform runtime type checking by default. The companion package
[`capnweb-validate`](/guides/validation/) generates runtime validators from your TypeScript types
at build time.

```sh
npm i -D capnweb-validate
```
