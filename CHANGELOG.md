# capnweb

## 0.2.0

### Minor Changes

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Fixed incompatibility with bundlers that don't support top-level await. The top-level await was used for a conditional import; it has been replaced with an approach based on "exports" in package.json instead.

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Support serializing Infinity, -Infinity, and NaN.

### Patch Changes

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Attempting to remotely access an instance property of an RpcTarget will now throw an exception rather than returning `undefined`, in order to help people understand what went wrong.

- [#107](https://github.com/cloudflare/capnweb/pull/107) [`aa4fe30`](https://github.com/cloudflare/capnweb/commit/aa4fe305f8037219bce822f9e9095303ff374c4f) Thanks [@threepointone](https://github.com/threepointone)! - chore: generate commonjs build

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Polyfilled Promise.withResolvers() to improve compatibility with old Safari versions and Hermes (React Native).
