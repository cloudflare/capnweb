# capnweb-validate

## 0.2.3

### Patch Changes

- [#227](https://github.com/cloudflare/capnweb/pull/227) [`2b292e4`](https://github.com/cloudflare/capnweb/commit/2b292e41adb4d2856f63118a13e1c70d01b5a0d9) Thanks [@teamchong](https://github.com/teamchong)! - Ignore extra arguments past a method's declared parameters instead of refusing the call, and drop them before invoking the implementation.

## 0.2.2

### Patch Changes

- [#197](https://github.com/cloudflare/capnweb/pull/197) [`0409821`](https://github.com/cloudflare/capnweb/commit/040982108c4c35820f61292819a276a495aa982d) Thanks [@teamchong](https://github.com/teamchong)! - Treat Workers `fetch` and `connect` lifecycle methods as passthrough methods on `WorkerEntrypoint` and `DurableObject` targets.

## 0.2.1

### Patch Changes

- [#194](https://github.com/cloudflare/capnweb/pull/194) [`4093556`](https://github.com/cloudflare/capnweb/commit/4093556c84ab7193a289c62bce6fd75996840cda) Thanks [@teamchong](https://github.com/teamchong)! - Fix `@validateRpc()` breaking decorated classes that extend other decorated classes: prototype methods are now wrapped in place instead of returning a Proxy from the constructor, so subclass-only methods validate correctly, instances stay real branded `RpcTarget`s, and incoming callback stubs pass through as native stubs (opt in to validating them with `validateStub<T>(stub)`).

## 0.2.0

### Minor Changes

- [#169](https://github.com/cloudflare/capnweb/pull/169) [`2cb51eb`](https://github.com/cloudflare/capnweb/commit/2cb51eb4c6424ef38132daa0e473f48ec7e14271) Thanks [@teamchong](https://github.com/teamchong)! - Introduced capnweb-validate, a separate package that allows you to wrap your RPC interfaces in runtime type-checking based on your TypeScript interfaces.
