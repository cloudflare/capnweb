# capnweb

## 0.4.0

### Minor Changes

- [#121](https://github.com/cloudflare/capnweb/pull/121) [`32e362f`](https://github.com/cloudflare/capnweb/commit/32e362fd1ee465d3adfe810ba135bbea224ce32b) Thanks [@kentonv](https://github.com/kentonv)! - Improved compatibility with Cloudflare Workers' built-in RPC, particularly when proxying from one to the other.

## 0.3.0

### Minor Changes

- [#78](https://github.com/cloudflare/capnweb/pull/78) [`8a47045`](https://github.com/cloudflare/capnweb/commit/8a470458dd152a66d473be638626f668f8be47d9) Thanks [@itaylor](https://github.com/itaylor)! - The package now exports the type `RpcCompatible<T>` (previously called `Serializable<T>`, but not exported), which is needed when writing generic functions on `RpcStub` / `RpcPromise`.

### Patch Changes

- [#120](https://github.com/cloudflare/capnweb/pull/120) [`1c87560`](https://github.com/cloudflare/capnweb/commit/1c87560efe1b042f133e978f7a60ecd52f69a549) Thanks [@kentonv](https://github.com/kentonv)! - Fixed serialization of async functions.

- [#117](https://github.com/cloudflare/capnweb/pull/117) [`d21e4ca`](https://github.com/cloudflare/capnweb/commit/d21e4cacfa1305e271e89657f8167bc688ade438) Thanks [@codehz](https://github.com/codehz)! - Enhance Stubify and Unstubify for tuple types

## 0.2.0

### Minor Changes

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Fixed incompatibility with bundlers that don't support top-level await. The top-level await was used for a conditional import; it has been replaced with an approach based on "exports" in package.json instead.

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Support serializing Infinity, -Infinity, and NaN.

### Patch Changes

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Attempting to remotely access an instance property of an RpcTarget will now throw an exception rather than returning `undefined`, in order to help people understand what went wrong.

- [#107](https://github.com/cloudflare/capnweb/pull/107) [`aa4fe30`](https://github.com/cloudflare/capnweb/commit/aa4fe305f8037219bce822f9e9095303ff374c4f) Thanks [@threepointone](https://github.com/threepointone)! - chore: generate commonjs build

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Polyfilled Promise.withResolvers() to improve compatibility with old Safari versions and Hermes (React Native).
