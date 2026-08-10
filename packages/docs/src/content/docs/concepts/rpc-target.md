---
title: RpcTarget & Functions
description: Export an interface over RPC by extending RpcTarget, and understand exactly which members become reachable.
---

## `RpcTarget`

To export an interface over RPC, write a class that extends `RpcTarget`. Extending `RpcTarget` tells
the RPC system: instances of this class are **pass-by-reference**. When an instance is passed over
RPC, the object is NOT serialized. Instead, the message contains a stub that points back to the
original target object, and invoking the stub calls back over RPC.

```ts
import { RpcTarget } from 'capnweb';

class Counter extends RpcTarget {
  #count = 0;

  increment(by: number) {
    this.#count += by;
    return this.#count;
  }

  get value() {
    return this.#count;
  }
}
```

## What is reachable

When you send someone an `RpcTarget` reference, they can call **any class method, including
getters**. They cannot access "own" properties.

In precise JavaScript terms: they can access **prototype properties but not instance properties**.
This policy is intended to do the right thing for typical JavaScript code, where private members are
usually stored as instance properties.

**Instance properties are treated as private.** Anything assigned in the constructor, or with a
class field, is an instance property and is unreachable over RPC. Reading one does not return
`undefined`; it throws, so a peer cannot probe for its existence:

```text
Attempted to access property 'apiKey', which is an instance property of the RpcTarget. To avoid
leaking private internals, instance properties cannot be accessed over RPC.
```

That default is the safe one, and it means exposing a value is a deliberate act.

### Exposing a property with a getter

A getter lives on the prototype, so it is reachable. This is the sanctioned way to publish a value
that is stored privately:

```ts
class Document extends RpcTarget {
  #title = 'Untitled';
  wordCount = 0; // instance property: NOT reachable over RPC

  // Reachable: the peer reads `doc.title` and this getter runs.
  get title() {
    return this.#title;
  }

  // Reachable: writes have to be a method call. See below.
  setTitle(title: string) {
    this.#title = title;
  }
}
```

:::caution
A **setter can never fire over RPC**. Assigning to a stub throws
`Can't assign properties on RPC stubs`, because the protocol has no message for assignment. Pairing
a setter with your getter is harmless but dead code as far as a peer is concerned.

Expose writes as a method instead, as `setTitle` does above. A method is also the honest shape for
a write that crosses a network: it returns a promise you can await, and it can fail.
:::

:::danger
If you are using TypeScript, note that declaring a method `private` does **not** hide it from RPC.
TypeScript annotations are erased at runtime, so they cannot be enforced.

To actually make a member private, prefix its name with `#`, which makes it private to JavaScript
itself. Names prefixed with `#` are never available over RPC.
:::

```ts
class Api extends RpcTarget {
  #secret = 'not reachable';        // ✅ truly private
  private alsoSecret = 'reachable'; // ❌ TypeScript-only; erased at runtime

  #internalHelper() {}              // ✅ truly private
  private helper() {}               // ❌ callable over RPC
}
```

## Functions

When a plain function is passed over RPC, it is treated similarly to an `RpcTarget`. The function is
replaced by a stub which, when invoked, calls back over RPC to the original function object.

```ts
// The client passes a callback...
await api.subscribe((event) => console.log('got', event));

// ...and the server can invoke it, calling back into the client.
```

If the function has any own properties, those *will* be available over RPC. Note this is the
opposite of `RpcTarget`: with `RpcTarget`, own properties are not exposed; with functions, *only*
own properties are exposed. Generally functions don't have properties anyway.

:::caution
A callback stub received in a call's parameters is disposed when that call returns. If the server
wants to invoke it later, it must call `.dup()`. See
[holding a callback past the call](/concepts/disposal/#holding-on-to-a-callback-past-the-call-that-delivered-it).
:::

## Listening for disposal

An `RpcTarget` may declare a `Symbol.dispose` method. If it does, the RPC system automatically
invokes it when a stub pointing at it, and all its duplicates, has been disposed.

```ts
class Session extends RpcTarget {
  [Symbol.dispose]() {
    // release resources held by this session
  }
}
```

If you pass the same `RpcTarget` instance over RPC multiple times, creating multiple stubs, you will
eventually get a separate dispose call for each one. To avoid that, use `new RpcStub(target)` to
create a single stub upfront and pass that across multiple RPCs; you will then receive only one call
to the target's disposer, when all stubs are disposed.
