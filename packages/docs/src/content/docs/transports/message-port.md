---
title: MessagePort
description: Use Cap'n Web to talk to Web Workers, iframes, and other same-process contexts.
---

Cap'n Web can talk over `MessagePort`s. In a browser, this lets you use the same RPC model to talk
to Web Workers, iframes, and other contexts — no serialization boilerplate, no ad-hoc message
protocols with `type` fields and switch statements.

```ts
import { RpcTarget, RpcStub, newMessagePortRpcSession } from 'capnweb';

// Declare our RPC interface.
class Greeter extends RpcTarget {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

// Create a MessageChannel (pair of MessagePorts).
let channel = new MessageChannel();

// Initialize the server on port1.
newMessagePortRpcSession(channel.port1, new Greeter());

// Initialize the client on port2.
using stub: RpcStub<Greeter> = newMessagePortRpcSession<Greeter>(channel.port2);

// Now you can make calls.
console.log(await stub.greet('Alice'));
console.log(await stub.greet('Bob'));
```

## Sending a port somewhere else

In a real-world scenario you'd send one of the two ports to another context. A `MessagePort` can
itself be transferred using `postMessage()` — `window.postMessage()`, `worker.postMessage()`, or
even `port.postMessage()` on some other existing `MessagePort`.

```ts
// Main thread
let worker = new Worker('./worker.js', { type: 'module' });
let channel = new MessageChannel();

// Hand one end to the worker.
worker.postMessage({ rpcPort: channel.port2 }, [channel.port2]);

// Keep the other end and start talking.
using api = newMessagePortRpcSession<WorkerApi>(channel.port1);
console.log(await api.crunchNumbers([1, 2, 3]));
```

```ts
// worker.js
import { RpcTarget, newMessagePortRpcSession } from 'capnweb';

class WorkerApi extends RpcTarget {
  crunchNumbers(values: number[]) {
    return values.reduce((a, b) => a + b, 0);
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.rpcPort) {
    newMessagePortRpcSession(event.data.rpcPort, new WorkerApi());
  }
});
```

:::danger
Do not use a `Window` object itself as a port for RPC. Always create a new `MessageChannel` and send
one of the ports over.

Anyone can `postMessage()` to a window, and the RPC system does not authenticate that messages came
from the expected sender. Verify that you received the *port itself* from the expected sender first,
then let the RPC system take over.
:::

## Structured clone

A `MessagePort` transport can avoid JSON entirely. Custom transports may declare
`encodingLevel: "structuredClonable"` so that messages stay as structured-clonable values, passing
through native types where possible while still handling RPC-specific values such as stubs. See
[Custom transports](/transports/custom/#encoding-levels).
