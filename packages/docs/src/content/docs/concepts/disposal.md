---
title: Disposal
description: Why garbage collection can't manage remote references, and the ownership rules Cap'n Web uses instead.
---

## Why you have to think about this

Unfortunately, garbage collection does not work well when remote resources are involved, for two
reasons:

1. Many JavaScript runtimes only run the garbage collector when they sense **memory pressure**. If
   memory is not running low, they figure there's no need to reclaim any. But a runtime has no way
   to know if the *other* side of an RPC connection is suffering memory pressure.

2. Garbage collectors need to **trace the full object graph** to detect which objects are
   unreachable, especially when those objects contain cyclic references. But a collector can only
   see local objects; it cannot trace through the remote graph to discover cycles that cross RPC
   connections.

Both problems might be solvable with sufficient work, but the problem seems exceedingly difficult.
This library makes no attempt to solve it.

:::note
We might extend Cap'n Web to use `FinalizationRegistry` to automatically dispose abandoned stubs in
the future, but even if we do, it should not be relied upon, for the reasons above.
:::

## Two strategies

**1. Explicitly dispose stubs when you are done with them.** This notifies the remote end that it
can release the associated resources.

**2. Use short-lived sessions.** When a session ends, all stubs are implicitly disposed. With
[HTTP batch](/transports/http-batch/) requests there's generally no need to dispose stubs at all.
With long-lived [WebSocket](/transports/websocket/) sessions, disposal may be important.

## How to dispose

Stubs integrate with JavaScript's
[explicit resource management](https://v8.dev/features/explicit-resource-management), which became
widely available in mid-2025 (and has been supported via transpilers and polyfills for a few years
before that). In short:

- Disposable objects, including stubs, have a `[Symbol.dispose]` method. You can call it directly:
  `stub[Symbol.dispose]()`.
- You can arrange for a stub to be disposed automatically at the end of a function scope by
  assigning it to a `using` variable, like `using stub = api.getStub();`. The disposer is invoked
  automatically when the variable goes out of scope.

## Automatic disposal rules

This library implements several rules to make resource management more manageable. They may appear
a bit complicated, but they are intended to implement the behaviour you would naturally expect.

The basic principle is: **the caller is responsible for disposing all stubs.** That is:

- Stubs passed in the params of a call remain property of the caller, and must be disposed by the
  caller, not the callee.
- Stubs returned in the result of a call have their ownership transferred from the callee to the
  caller, and must be disposed by the caller.

In practice, the callee and caller do not actually share the same stubs. When stubs are passed over
RPC they are **duplicated**, and the target object is only disposed when all duplicates are
disposed. So, to achieve the rule that only the caller needs to dispose, the RPC system implicitly
disposes the callee's duplicates when the call completes:

- Any stubs the callee receives in the parameters are implicitly disposed when the call completes.
- Any stubs returned in the results are implicitly disposed some time after the call completes,
  specifically once the RPC system knows there will be no more pipelined calls.

### Wonky details

- Disposing an `RpcPromise` automatically disposes the future result. It may also cause the promise
  to be cancelled and rejected, though this is not guaranteed. If you don't intend to await an RPC
  promise, dispose it.
- Passing an `RpcPromise` in params or the return value of a call has the same ownership and
  disposal rules as passing an `RpcStub`.
- When you access a property of an `RpcStub` or `RpcPromise`, the result is itself an `RpcPromise`,
  but it does not have its own disposer. You must dispose the stub or promise it came from. You can
  pass such properties in params or return values, but doing so never leads to anything being
  implicitly disposed.
- The caller of an RPC may dispose stubs used in the parameters immediately after initiating the
  RPC, without waiting for it to complete. All stubs are duplicated at the moment of the call, so
  the callee is not responsible for keeping them alive.
- If the final result of an RPC is an object, it will always have a disposer. Disposing it disposes
  all stubs found in that response. It's a good idea to always dispose return values even if you
  don't expect them to contain stubs, in case the API adds stubs to the result in the future.

:::caution
The ownership behaviour of calls differs from the original behaviour of the native RPC
implementation built into the Cloudflare Workers Runtime. In the original Workers behaviour, the
callee loses ownership of stubs passed in a call's parameters. We plan to change the Workers Runtime
to match Cap'n Web's behaviour, as the original has proven more problematic than helpful.
:::

## Duplicating stubs

Sometimes you need to pass a stub somewhere it will be disposed, but also keep it for later use. To
prevent the disposer from disabling your copy, duplicate it with `stub.dup()`. The stub's target is
only disposed when all duplicates have been disposed.

:::tip
You can call `.dup()` on a *property* of a stub or promise, to create a stub backed by that
property. This is particularly useful when you know in advance that the property will resolve to a
stub: `.dup()` gives you a stub you can start using immediately, that otherwise behaves exactly like
the eventual stub would if you awaited it.
:::

### Holding on to a callback past the call that delivered it

A common bidirectional-calling pattern is for the client to pass a callback to the server, which the
server then invokes later (from a timer, an event handler, or a subsequent RPC). Because the
callback parameter is a stub, and stubs in params are implicitly disposed when the call returns, the
server must duplicate the stub with `.dup()` if it wants to invoke the callback after the call
completes:

```ts
import { type RpcStub, RpcTarget } from 'capnweb';

// A callback the client passes in: a stub wrapping a function.
type Listener = RpcStub<(msg: string) => void>;

class Api extends RpcTarget {
  #listener?: Listener;

  // Stubs passed as params are disposed when the call returns, so `.dup()`
  // to keep a reference that outlives registerListener().
  registerListener(listener: Listener) {
    this.#listener?.[Symbol.dispose](); // release any previous listener
    this.#listener = listener.dup();
  }

  // A *later* call can invoke the retained callback -- still valid thanks to .dup().
  notify(msg: string) {
    this.#listener?.(msg);
  }

  // Dispose our duplicate when done so the client-side stub can be freed.
  [Symbol.dispose]() {
    this.#listener?.[Symbol.dispose]();
  }
}
```

The same rule applies in the other direction: if the server returns a stub to the client and the
client wants to keep using it after disposing the result, the client should `.dup()` the stub before
the result is disposed.

## Listening for disposal

An `RpcTarget` may declare a `Symbol.dispose` method. If it does, the RPC system automatically
invokes it when a stub pointing at it, and all its duplicates, have been disposed.

If you pass the same `RpcTarget` instance to RPC multiple times (creating multiple stubs), you will
eventually get a separate dispose call for each one. To avoid this, use `new RpcStub(target)` to
create a single stub upfront, then pass that stub across multiple RPCs. You will then receive only
one call to the target's disposer, when all stubs are disposed.

## Listening for disconnect

Monitor any stub for "brokenness" with `onRpcBroken()`:

```ts
stub.onRpcBroken((error: any) => {
  console.error(error);
});
```

If anything happens to the stub that would cause all further method calls and property accesses to
throw exceptions, the callback is called. In particular, this happens if:

- The stub's underlying connection is lost.
- The stub is a promise, and the promise rejects.
