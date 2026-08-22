---
title: RpcStub
description: How stubs work, what TypeScript knows about them, and how to forward them between peers.
sidebar:
  order: 3
---

When a type `T` which extends [`RpcTarget`](/concepts/rpc-target/) (or is a function) is sent as
part of an RPC message (in the arguments to a call, or in a return value), it is replaced with a
stub of type `RpcStub<T>`.

## Stubs are proxies

Stubs are implemented using JavaScript `Proxy`s. A stub appears to have every possible method and
property name. The stub does **not** know at runtime which properties actually exist on the other
side. If you use a property that doesn't exist, no error is produced until you await the result.

TypeScript, however, knows which properties exist from the type parameter `T`. So if you are using
TypeScript, you get full compile-time type checking, autocomplete, and refactoring. Hooray!

## Reading properties

To read a property from the remote object, as opposed to calling a method, `await` the property:

```ts
let foo = await stub.foo;
```

Property access itself is lazy and free: it produces an [`RpcPromise`](/concepts/promises/) you can
also pipeline through without awaiting.

## Forwarding stubs to third parties

A stub can be passed across RPC again, **including over independent connections**. If Alice is
connected to Bob and Carol, and Alice receives a stub from Bob, Alice can pass that stub in an RPC
to Carol, thus allowing Carol to call Bob.

```text
Carol ──call──▶ Alice ──proxied──▶ Bob
```

As of this writing, any such calls are proxied through Alice. In the future we may support
"three-party handoff" so that Carol can make a direct connection to Bob.

In the object-capability model, possession of the stub *is* the authority to use it, and that
authority is delegated by passing it along.

## Constructing a stub locally

You may construct a stub explicitly, without an RPC connection:

```ts
let stub = new RpcStub(target);
```

This is useful to perform local calls as if they were remote, and to manage disposal; passing one
explicitly-created stub across several RPCs means the underlying target's disposer runs only once,
when all copies are gone. See [Disposal](/concepts/disposal/).

## Duplicating

`stub.dup()` returns an independent duplicate. The target is disposed only when *all* duplicates
have been disposed. You need this whenever you want to keep a stub that the RPC system would
otherwise dispose out from under you, most commonly a callback received in a call's parameters.

## Detecting breakage

Monitor any stub for "brokenness" with `onRpcBroken()`:

```ts
stub.onRpcBroken((error: any) => {
  console.error(error);
});
```

The callback fires if anything happens to the stub that would cause all further method calls and
property accesses to throw. In particular:

- The stub's underlying connection is lost.
- The stub is a promise, and the promise rejects.
