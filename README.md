# Cap'n Web: A JavaScript-native RPC system

Cap'n Web is a spiritual sibling to [Cap'n Proto](https://capnproto.org) (and is created by the same author), but designed to play nice in the web stack. That means:
* Like Cap'n Proto, it is an object-capability protocol. ("Cap'n" is short for "capabilities and".) We'll get into this more below, but it's incredibly powerful.
* Unlike Cap'n Proto, Cap'n Web has no schemas. In fact, it has almost no boilerplate whatsoever. This means it works more like the [JavaScript-native RPC system in Cloudflare Workers](https://blog.cloudflare.com/javascript-native-rpc/).
* That said, it integrates nicely with TypeScript.
* Also unlike Cap'n Proto, Cap'n Web's underlying serialization is human-readable. In fact, it's just JSON, with a little pre-/post-processing.
* It works over HTTP, WebSocket, and postMessage() out-of-the-box, with the ability to extend it to other transports easily.
* It works in all major browsers, Cloudflare Workers, Node.js, and other modern JavaScript runtimes.
The whole thing compresses (minify+gzip) to under 10kB with no dependencies.

Cap'n Web is more expressive than almost every other RPC system, because it implements an object-capability RPC model. That means it:
* Supports bidirectional calling. The client can call the server, and the server can also call the client.
* Supports passing functions by reference: If you pass a function over RPC, the recipient receives a "stub". When they call the stub, they actually make an RPC back to you, invoking the function where it was created. This is how bidirectional calling happens: the client passes a callback to the server, and then the server can call it later.
* Similarly, supports passing objects by reference: If a class extends the special marker type `RpcTarget`, then instances of that class are passed by reference, with method calls calling back to the location where the object was created.
* Supports promise pipelining. When you start an RPC, you get back a promise. Instead of awaiting it, you can immediately use the promise in dependent RPCs, thus performing a chain of calls in a single network round trip.
* Supports capability-based security patterns.

## Installation

[Cap'n Web is an npm package.](https://www.npmjs.com/package/capnweb)

```
npm i capnweb
```

## Example

A client looks like this:

```js
import { newWebSocketRpcSession } from "capnweb";

// One-line setup.
let api = newWebSocketRpcSession("wss://example.com/api");

// Call a method on the server!
let result = await api.hello("World");

console.log(result);
```

Here's the server:

```js
import { RpcTarget, newWorkersRpcResponse } from "capnweb";

// This is the server implementation.
class MyApiServer extends RpcTarget {
  hello(name) {
    return `Hello, ${name}!`
  }
}

// Standard Cloudflare Workers HTTP handler.
//
// (Node and other runtimes are supported too; see below.)
export default {
  fetch(request, env, ctx) {
    // Parse URL for routing.
    let url = new URL(request.url);

    // Serve API at `/api`.
    if (url.pathname === "/api") {
      return newWorkersRpcResponse(request, new MyApiServer());
    }

    // You could serve other endpoints here...
    return new Response("Not found", {status: 404});
  }
}
```

### More complicated example

Here's an example that:
* Uses TypeScript
* Sends multiple calls, where the second call depends on the result of the first, in one round trip.

We declare our interface in a shared types file:

```ts
interface PublicApi {
  // Authenticate the API token, and returned the authenticated API.
  authenticate(apiToken: string): AuthedApi;

  // Get a given user's public profile info. (Doesn't require authentication.)
  getUserProfile(userId: string): Promise<UserProfile>;
}

interface AuthedApi {
  getUserId(): number;

  // Get the user IDs of all the user's friends.
  getFriendIds(): number[];
}

type UserProfile = {
  name: string;
  photoUrl: string;
}
```

(Note: you don't _have to_ declare your interface separately. The client could just use `import("./server").ApiServer` as the type.)

On the server, we implement the interface as an RpcTarget:

```ts
import { newWorkersRpcResponse, RpcTarget } from "capnweb";

class ApiServer extends RpcTarget implements PublicApi {
  // ... implement PublicApi ...
}

export default {
  async fetch(req, env, ctx) {
    // ... same as previous example ...
  }
}
```

On the client, we can use it in a batch request:

```ts
import { newHttpBatchRpcSession } from "capnweb";

let api = newHttpBatchRpcSession<PublicApi>("https://example.com/api");

// Call authenticate(), but don't await it. We can use the returned promise
// to make "pipelined" calls without waiting.
let authedApi: RpcPromise<AuthedApi> = api.authenticate(apiToken);

// Make a pipelined call to get the user's ID. Again, don't await it.
let userIdPromise: RpcPromise<number> = authedApi.getUserId();

// Make another pipelined call to fetch the user's public profile, based on
// the user ID. Notice how we can use `RpcPromise<T>` in the parameters of a
// call anywhere where T is expected. The promise will be replaced with its
// resolution before delivering the call.
let profilePromise = api.getUserProfile(userIdPromise);

// Make another call to get the user's friends.
let friendsPromise = authedApi.getFriendIds();

// That only returns an array of user IDs, but we want all the profile info
// too, so use the magic .map() function to get them, too! Still one round
// trip.
let friendProfilesPromise = friendsPromise.map((id: RpcPromise<number>) => {
  return { id, profile: api.getUserProfile(id) };
});

// Now await the promises. The batch is sent at this point. It's important
// to simultaneously await all promises for which you actually want the
// result. If you don't actually await a promise before the batch is sent,
// the system detects this and doesn't actually ask the server to send the
// return value back!
let [profile, friendProfiles] =
    await Promise.all([profilePromise, friendProfilesPromise]);

console.log(`Hello, ${profile.name}!`);

// Note that at this point, the `api` and `authedApi` stubs no longer work,
// because the batch is done. You must start a new batch.
```

Alternatively, for a long-running interactive application, we can set up a persistent WebSocket connection:

```ts
import { newWebSocketRpcSession } from "capnweb";

// We declare `api` with `using` so that it'll be disposed at the end of the
// scope, which closes the connection. `using` is a fairly new JavaScript
// feature, part of the "explicit resource management" spec. Alternatively,
// we could declare `api` with `let` or `const` and make sure to call
// `api[Symbol.dispose]()` to dispose it and close the connection later.
using api = newWebSocketRpcSession<PublicApi>("wss://example.com/api");

// Usage is exactly the same, except we don't have to await all the promises
// at once.

// Authenticate and get the user ID in one round trip. Note we use `using`
// again so that `authedApi` will be disposed when we're done with it. In
// this case, it won't close the connection (since it's not the main stub),
// but disposing it does release the `AuthedApi` object on the server side.
using authedApi: RpcPromise<AuthedApi> = api.authenticate(apiToken);
let userId: number = await authedApi.getUserId();

// ... continue calling other methods, now or in the future ...
```

## RPC Basics

### Pass-by-value types

The following types can be passed over RPC (in arguments or return values), and will be passed "by value", meaning the content is serialized, producing a copy at the receiving end:

* Primitive values: strings, numbers, booleans, null, undefined
* Plain objects (e.g., from object literals)
* Arrays
* `bigint`
* `Date`
* `Uint8Array`
* `Error` and its well-known subclasses

The following types are not supported as of this writing, but may be added in the future:
* `Map` and `Set`
* `ArrayBuffer` and typed arrays other than `Uint8Array`
* `RegExp`
* `ReadableStream` and `WritableStream`, with automatic flow control.
* `Headers`, `Request`, and `Response`

The following are intentionally NOT supported:
* Application-defined classes that do not extend `RpcTarget`.
* Cyclic values. Messages are serialized strictly as trees (like JSON).

### `RpcTarget`

To export an interface over RPC, you must write a class that `extends RpcTarget`. Extending `RpcTarget` tells the RPC system: instances of this class are _pass-by-reference_. When an instance is passed over RPC, the object should NOT be serialized. Instead, the RPC message will contain a "stub" that points back to the original target object. Invoking this stub calls back over RPC.

When you send someone an `RpcTarget` reference, they will be able to call any class method over RPC, including getters. They will not, however, be able to access "own" properties. In precise JavaScript terms, they can access prototype properties but not instance properties. This policy is intended to "do the right thing" for typical JavaScript code, where private members are typically stored as instance properties.

WARNING: If you are using TypeScript, note that declaring a method `private` does not hide it from RPC, because TypeScript annotations are "erased" at runtime, so cannot be enforced. To actually make methods private, you must prefix their names with `#`, which makes them private for JavaScript (not just TypeScript). Names prefixed with `#` are never available over RPC.

### Functions

When a plain function is passed over RPC, it will be treated similarly to an `RpcTarget`. The function will be replaced by a stub which, when invoked, calls back over RPC to the original function object.

If the function has any own properties, those will be available over RPC. Note that this differs from `RpcTarget`: With `RpcTarget`, own properties are not exposed, but with functions, _only_ own properties are exposed. Generally functions don't have properties anyway, making the point moot.

### `RpcStub<T>`

When a type `T` which extends `RpcTarget` (or is a function) is sent as part of an RPC message (in the arguments to a call, or in the return value), it is replaced with a stub of type `RpcStub<T>`.

Stubs are implemented using JavaScript `Proxy`s. A stub appears to have every possible method and property name. The stub does not know at runtime which properties actually exist on the server side. If you use a property that doesn't exist, an error will not be produced until you await the results.

TypeScript, however, will know which properties exist from type parameter `T`. Thus, if you are using TypeScript, you will get full compile-time type checking, auto-complete, etc. Hooray!

To read a property from the remote object (as opposed to calling a method), simply `await` the property, like `let foo = await stub.foo;`.

A stub can be passed across RPC again, including over independent connections. If Alice is connected to Bob and Carol, and Alice receives a stub from Bob, Alice can pass the stub in an RPC to Carol, thus allowing Carol to call Bob. (As of this writing, any such calls will be proxied through Alice, but in the future we may support "three-party handoff" such that Carol can make a direct connection to Bob.)

You may construct a stub explicitly without an RPC connection, using `new RpcStub(target)`. This is sometimes useful to be able to perform local calls as if they were remote, or to help manage disposal (see below).

### `RpcPromise<T>`

Calling an RPC method returns an `RpcPromise` rather than a regular `Promise`. You can use an `RpcPromise` in all the ways a regular `Promise` can be used, that is, you can `await` it, call `.then()`, pass it to `Promise.resolve()`, etc. (This is all possible because `RpcPromise` is a ["thenable"](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise#thenables).)

However, you can do more with `RpcPromise`. `RpcPromise` supports _Promise Pipelining_:

1. An `RpcPromise` also acts as a _stub_ for the eventual result of the promise. That means, you can access properties and invoke methods on it, without awaiting the promise first.

```ts
// In a single round trip, authenticate the user, and fetch their notifications.
let user = api.authenticate(cookie);
let notifications = await user.getNotifications();
```

2. An `RpcPromise` (or its properties) can be passed as parameters to other RPC calls.

```ts
// In a single round trip, authenticate the user, and fetch their public profile
// given their ID.
let user = api.authenticate(cookie);
let profile = await api.getUserProfile(user.id);
```

Whenever an `RpcPromise` is passed in the parameters to an RPC, or returned as part of the result, the promise will be replaced with its resolution before delivery to the receiving application. So, you can use an `RpcPromise<T>` anywhere where a `T` is required!

### The magic `map()` method

Every RPC promise has a special method `.map()` which can be used to remotely transform a value, without pulling it back locally. Here's an example:

```ts
// Get a list of user IDs.
let idsPromise = api.listUserIds();

// Look up the username for each one.
let names = await idsPromise.map(id => [id, api.getUserName(id)]);
```

This example calls one API method to get a list of user IDs, then, for each user ID in the list, makes another RPC call to look up the user's name, producing a list of id/name pairs.

**All this happens in a single network round trip!**

`promise.map(func)` transfers a representation of `func` to the server, where it is executed on the promise's result. Specifically:

* If the promise resolves to an array, the mapper function executes on each element of the array. The overall `.map()` operation returns a promise for an array of the results.
* If the promise resolves to `null` or `undefined`, the map function is not executed at all. The result is the same value.
* If the promise resolves to any other value, the map function executes once on that value, returning the result.

Thus, `map()` can be used both for handling arrays, and for handling nullable values.

There are some restrictions:

* The callback must have no side effects other than calling RPCs.
* The callback must be synchronous. It cannot await anything.
* The input to the callback is an `RpcPromise`, hence the callback cannot actually operate on it, other than to invoke its RPC methods, or to use it in the params of other RPC methods.
* Any stubs which you use in the callback -- and any parameters you pass to them -- will be sent to the peer. Be warned, a malicious peer can use these stubs for anything, not just calling your callback. Typically, it only makes sense to invoke stubs that came from the same peer originally, since this is what saves round-trips.

**How the heck does that work?**

Cap'n Web does NOT send arbitrary code over the wire!

The trick here is record-replay: On the calling side, Cap'n Web will invoke your callback once, in a special "recording" mode, passing in a special placeholder stub which records what you do with it. During the invocation, any RPCs invoked by the callback (on *any* stub) will not actually be executed, but will be recorded as an action the callback performs. Any stubs you use during the recording are "captured" as well. Once the callback returns, the recording and the capture list can then be sent to the peer, where the recording can then be replayed as needed to process individual results.

Since all of the not-yet-determined values seen by the callback are represented as `RpcPromise`s, the callback's behavior is deterministic. Any actual computation (arithmetic, branching, etc.) can't possibly use these promises as (meaningful) inputs, so would logically produce the same results for every invocation of the callback. Any such computation will actually end up being performed on the sending side, just once, with the results being imbued into the recording.

### Cloudflare Workers RPC interoperability

Cap'n Web works on any JavaScript platform. But, on Cloudflare Workers specifically, it's designed to play nicely with the [the built-in RPC system](https://blog.cloudflare.com/javascript-native-rpc/). The two have basically the same semantics, the only difference being that Workers RPC is a built-in API provided by the Workers Runtime, whereas Cap'n Web is implemented in pure JavaScript.

To facilitate interoperability:
* On Workers, the `RpcTarget` class exported by "capnweb" is just an alias of the built-in one, so you can use them interchangeably.
* RPC stubs and promises originating from one RPC system can be passed over the other. This will automatically set up proxying.
* You can also send Workers Service Bindings and Durable Object stubs over Cap'n Web -- again, this sets up proxying.

So basically, it "just works".

With that said, as of this writing, the feature set is not exactly the same between the two. We aim to fix this over time, by adding missing features to both sides until they match. In particular, as of this writing:
* Workers RPC supports some types that Cap'n Web does not yet, like `Map`, streams, etc.
* Workers RPC supports sending values that contain aliases and cycles. This can actually cause problems, so we actually plan to *remove* this feature from Workers RPC (with a compatibility flag, of course).
* Workers RPC does not yet support placing an `RpcPromise` into the parameters of a request, to be replaced by its resolution.
* Workers RPC does not yet support the magic `.map()` method.

## Resource Management and Disposal

Unfortunately, garbage collection does not work well when remote resources are involved, for two reasons:

1. Many JavaScript runtimes only run the garbage collector when they sense "memory pressure" -- if memory is not running low, then they figure there's no need to try to reclaim any. However, the runtime has no way to know if the other side of an RPC connection is suffering memory pressure.

2. Garbage collectors need to trace the full object graph in order to detect which objects are unreachable, especially when those objects contain cyclic references. However, the garbage collector can only see local objects; it has no ability to trace through the remote graph to discover cycles that may cross RPC connections.

Both of these problems might be solvable with sufficient work, but the problem seems exceedingly difficult. We make no attempt to solve it in this library.

Instead, you may choose one of two strategies:

1. Explicitly dispose stubs when you are done with them. This notifies the remote end that it can release the associated resources.

2. Use short-lived sessions. When the session ends, all stubs are implicitly disposed. In particular, when using HTTP batch request, there's generally no need to dispose stubs. When using long-lived WebSocket sessions, however, disposal may be important.

Note: We might extend Cap'n Web to use `FinalizationRegistry` to automatically dispose abandoned stubs in the future, but even if we do, it should not be relied upon, due to problems discussed above.

### How to dispose

Stubs integrate with JavaScript's [explicit resource management](https://v8.dev/features/explicit-resource-management), which became widely available in mid-2025 (and has been supported via transpilers and polyfills going back a few years earlier). In short:

* Disposable objects (including stubs) have a method `[Symbol.dispose]`. You can call this like `stub[Symbol.dispose]()`.
* You can arrange for a stub to be disposed automatically at the end of a function scope by assigning it to a `using` variable, like `using stub = api.getStub();`. The disposer will automatically be invoked when the variable goes out-of-scope.

### Automatic disposal

This library implements several rules to help make resource management more manageable. These rules may appear a bit complicated, but are intended to implement the behavior you would naturally expect.

The basic principle is: **The caller is responsible for disposing all stubs.** That is:
* Stubs passed in the params of a call remain property of the caller, and must be disposed by the caller, not by the callee.
* Stubs returned in the result of a call have their ownership transferred from the callee to the caller, and must be disposed by the caller.

In practice, though, the callee and caller do not actually share the same stubs. When stubs are passed over RPC, they are _duplicated_, and the target object is only disposed when all duplicates of the stub are disposed. Thus, to achieve the rule that only the caller needs to dispose stubs, the RPC system implicitly disposes the callee's duplicates of all stubs when the call completes. That is:
* Any stubs the callee receives in the parameters are implicitly disposed when the call completes.
* Any stubs returned in the results are implicitly disposed some time after the call completes. (Specifically, the RPC system will dispose them once it knows there will be no more pipelined calls.)

Some additional wonky details:
* Disposing an `RpcPromise` will automatically dispose the future result. (It may also cause the promise to be canceled and rejected, though this is not guaranteed.) If you don't intend to await an RPC promise, you should dispose it.
* Passing an `RpcPromise` in params or the return value of a call has the same ownership / disposal rules as passing an `RpcStub`.
* When you access a property of an `RpcStub` or `RpcPromise`, the result is itself an `RpcPromise`. However, this `RpcPromise` does not have its own disposer; you must dispose the stub or promise it came from. You can pass such properties in params or return values, but doing so will never lead to anything being implicitly disposed.
* The caller of an RPC may dispose any stubs used in the parameters immediately after initiating the RPC, without waiting for the RPC to complete. All stubs are duplicated at the moment of the call, so the callee is not responsible for keeping them alive.
* If the final result of an RPC returned to the caller is an object, it will always have a disposer. Disposing it will dispose all stubs found in that response. It's a good idea to always dispose return values even if you don't expect they contain any stubs, just in case the server changes the API in the future to add stubs to the result.

WARNING: The ownership behavior of calls differs from the original behavior in the native RPC implementation built into the Cloudflare Workers Runtime. In the original Workers behavior, the callee loses ownership of stubs passed in a call's parameters. We plan to change the Workers Runtime to match Cap'n Web's behavior, as the original behavior has proven more problematic than helpful.

### Duplicating stubs

Sometimes you need to pass a stub somewhere where it will be disposed, but also keep the stub for later use. To prevent the disposer from disabling your copy of the stub, you can duplicate the stub by calling `stub.dup()`. The stub's target will only be disposed when all duplicates of the stub have been disposed.

Hint: You can call `.dup()` on a property of a stub or promise, in order to create a stub backed by that property. This is particularly useful when you know in advance that the property is going to resolve to a stub: calling `.dup()` on it gives you a stub you can start using immediately, that otherwise behaves exactly the same as the eventual stub would if you awaited it.

### Listening for disposal

An `RpcTarget` may declare a `Symbol.dispose` method. If it does, the RPC system will automatically invoke it when a stub pointing at it (and all its duplicates) has been disposed.

Note that if you pass the same `RpcTarget` instance to RPC multiple times -- thus creating multiple stubs -- you will eventually get a separate dispose call for each one. To avoid this, you could use `new RpcStub(target)` to create a single stub upfront, and then pass that stub across multiple RPCs. In this case, you will receive only one call to the target's disposer when all stubs are disposed.

### Listening for disconnect

You can monitor any stub for "brokenness" with its `onRpcBroken()` method:

```ts
stub.onRpcBroken((error: any) => {
  console.error(error);
});
```

If anything happens to the stub that would cause all further method calls and property accesses to throw exceptions, then the callback will be called. In particular, this happens if:
* The stub's underlying connection is lost.
* The stub is a promise, and the promise rejects.

## Security Considerations

* The WebSocket API in browsers always permits cross-site connections, and does not permit setting headers. Because of this, you generally cannot use cookies nor other headers for authentication. Instead, we highly recommend the pattern shown in the second example above, in which authentication happens in-band via an RPC method that returns the authenticated API.

* Cap'n Web's pipelining can make it easy for a malicious client to enqueue a large amount of work to occur on a server. To mitigate this, we recommend implementing rate limits on expensive operations. If using Cloudflare Workers, you may also consider configuring [per-request CPU limits](https://developers.cloudflare.com/workers/wrangler/configuration/#limits) to be lower than the default 30s. Note that in stateless Workers (i.e. not Durable Objects), the system considers an entire WebSocket session to be one "request" for CPU limits purposes.

* Cap'n Web currently does not provide any runtime type checking. When using TypeScript, keep in mind that types are checked only at compile time. A malicious client can send types you did not expect, and this could cause you application to behave in unexpected ways. For example, MongoDB uses special property names to express queries; placing attacker-provided values directly into queries can result in query injection vulnerabilities (similar to SQL injection). Of course, JSON has always had the same problem, and there exists tooling to solve it. You might consider using a runtime type-checking framework like Zod to check your inputs. In the future, we hope to explore auto-generating type-checking code based on TypeScript types.

## Setting up a session

### HTTP batch client

In HTTP batch mode, a batch of RPC calls can be made in a single HTTP request, with the server returning a batch of results.

**Cap'n Web has a magic trick:** The results of one call in the batch can be used in the parameters to later calls in the same batch, even though the entire batch is sent at once. If you simply take the Promise returned by one call and use it in the parameters to another call, the Promise will be replaced with its resolution before delivering it to the callee. **This is called Promise Pipelining.**

```ts
import { RpcTarget, RpcStub, newHttpBatchRpcSession } from "capnweb";

// Declare our RPC interface.
interface MyApi extends RpcTarget {
  // Returns information about the logged-in user.
  getUserInfo(): UserInfo;

  // Returns a friendly greeting for a user with the given name.
  greet(name: string): string;
};

// Start a batch request using this interface.
using stub: RpcStub<MyApi> = newHttpBatchRpcSession<MyApi>("https://example.com/api");

// The batch will be sent on the next I/O tick (i.e. using setTimeout(sendBatch, 0)). You have
// until then to add calls to the batch.
//
// We can make any number of calls as part of the batch, as long as we store the promises without
// awaiting them yet.
let promise1 = stub.greet("Alice");
let promise2 = stub.greet("Bob");

// Note that a promise returned by one call can be used in the input to another call. The first
// call's result will be substituted into the second call's parameters on the server side. If the
// first call returns an object, you can even specify a property of the object to pass to the
// second call, as shown here.
let userInfoPromise = stub.getUserInfo();
let promise3 = stub.greet(userInfoPromise.name);

// Use Promise.all() to wait on all the promises at once. NOTE: You don't necessarily have to
// use Promise.all(), but you must make sure you have explicitly awaited (or called `.then()` on)
// all promises before the batch is sent. The system will only ask the server to send back
// results for the promises you explicitly await. In this example, we have not awaited
// `userInfoPromise` -- we only used it as a parameter to another call -- so the result will
// not actually be returned.
let [greeting1, greeting2, greeting3] = await Promise.all([promise1, promise2, promise3]);

// Now we can do stuff with the results.
console.log(greeting1);
console.log(greeting2);
console.log(greeting3);
```

### WebSocket client

In WebSocket mode, the client forms a long-lived connection to the server, allowing us to make many calls over a long period of time. In this mode, the server can even make asynchronous calls back to the client.

```ts
import { RpcTarget, RpcStub, newWebSocketRpcSession } from "capnweb";

// Declare our RPC interface.
interface MyApi extends RpcTarget {
  // Returns information about the logged-in user.
  getUserInfo(): UserInfo;

  // Returns a friendly greeting for a user with the given name.
  greet(name: string): string;
};

// Start a WebSocket session.
//
// (Note that disposing the root stub will close the connection. Here we declare it with `using` so
// that the connection will be closed when the stub goes out of scope, but you can also call
// `stub[Symbol.dispose]()` directly.)
using stub: RpcStub<MyApi> = newWebSocketRpcSession<MyApi>("wss://example.com/api");

// With a WebSocket, we can freely make calls over time.
console.log(await stub.greet("Alice"));
console.log(await stub.greet("Bob"));

// But we can still use Promise Pipelining to reduce round trips. Note that we should use `using`
// with promises we don't intend to await so that the system knows when we don't need them anymore.
{
  using userInfoPromise = stub.getUserInfo();
  console.log(await stub.greet(userInfoPromise.name));
}

// Note that since we never awaited `userInfoPromise`, the server won't even bother sending the
// response back over the wire.
```

### HTTP server on Cloudflare Workers

The helper function `newWorkersRpcResponse()` makes it easy to implement an HTTP server that accepts both the HTTP batch and WebSocket APIs at once:

```ts
import { RpcTarget, newWorkersRpcResponse } from "capnweb";

// Define our server implementation.
class MyApiImpl extends RpcTarget implements MyApi {
  constructor(private userInfo: UserInfo) {}

  getUserInfo(): UserInfo {
    return this.userInfo;
  }

  greet(name: string): string {
    return `Hello, ${name}!`;
  }
};

// Define our Worker HTTP handler.
export default {
  fetch(request: Request, env, ctx) {
    let userInfo: UserInfo = authenticateFromCookie(request);
    let url = new URL(request.url);

    // Serve API at `/api`.
    if (url.pathname === "/api") {
      return newWorkersRpcResponse(request, new MyApiImpl(userInfo));
    }

    return new Response("Not found", {status: 404});
  }
}
```

#### Compatibility with Workers' built-in RPC

Cloudflare Workers has long featured [a built-in RPC system with semantics similar to Cap'n Web](https://developers.cloudflare.com/workers/runtime-apis/rpc/).

Cap'n Web is designed to be compatible with Workers RPC, meaning you can pass Cap'n Web RPC stubs over Workers RPC and vice versa. The system will automatically wrap one stub type in the other and arrange to proxy calls.

For best compatibility, make sure to set your [Workers compatibilty date](https://developers.cloudflare.com/workers/configuration/compatibility-dates/) to at least `2026-01-20`, or enable the [compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) `rpc_params_dup_stubs`. (As of this writing, `2026-01-20` is in the future, so you will need to use the flag for now.)

### HTTP server on Node.js

A server on Node.js is a bit more involved, due to the awkward handling of WebSockets in Node's HTTP library.

```ts
import http from "node:http";
import { WebSocketServer } from 'ws';  // npm package
import { RpcTarget, newWebSocketRpcSession, nodeHttpBatchRpcResponse } from "capnweb";

class MyApiImpl extends RpcTarget implements MyApi {
  // ... define API, same as above ...
}

// Run standard HTTP server on a port.
httpServer = http.createServer(async (request, response) => {
  if (request.headers.upgrade?.toLowerCase() === 'websocket') {
    // Ignore, should be handled by WebSocketServer instead.
    return;
  }

  // Accept Cap'n Web requests at `/api`.
  if (request.url === "/api") {
    try {
      await nodeHttpBatchRpcResponse(request, response, new MyApiImpl(), {
        // If you are accepting WebSockets, then you might as well accept cross-origin HTTP, since
        // WebSockets always permit cross-origin request anyway. But, see security considerations
        // for further discussion.
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    } catch (err) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(err?.stack || err));
    }
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end("Not Found");
});

// Arrange to handle WebSockets as well, using the `ws` package. You can skip this if you only
// want to handle HTTP batch requests.
wsServer = new WebSocketServer({ server: httpServer })
wsServer.on('connection', (ws) => {
  // The `as any` here is because the `ws` module seems to have its own `WebSocket` type
  // declaration that's incompatible with the standard one. In practice, though, they are
  // compatible enough for Cap'n Web!
  newWebSocketRpcSession(ws as any, new MyApiImpl());
})

// Accept requests on port 8080.
httpServer.listen(8080);
```

### HTTP server on Deno
```ts
import {
  newHttpBatchRpcResponse,
  newWebSocketRpcSession,
  RpcTarget,
} from "npm:capnweb";

// This is the server implementation.
class MyApiImpl extends RpcTarget implements MyApi {
  // ... define API, same as above ...
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/api") {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.addEventListener("open", () => {
        newWebSocketRpcSession(socket, new MyApiImpl());
      });
      return response;
    } else {
      const response = await newHttpBatchRpcResponse(req, new MyApiImpl());
      // If you are accepting WebSockets, then you might as well accept cross-origin HTTP, since
      // WebSockets always permit cross-origin request anyway. But, see security considerations
      // for further discussion.
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }
  }

  return new Response("Not Found", { status: 404 });
});
```

### HTTP server on other runtimes

Every runtime does HTTP handling and WebSockets a little differently, although most modern runtimes use the standard `Request` and `Response` types from the Fetch API, as well as the standard `WebSocket` API. You should be able to use these two functions (exported by `capnweb`) to implement both HTTP batch and WebSocket handling on all platforms:

```ts
// Run a single HTTP batch.
function newHttpBatchRpcResponse(
    request: Request, yourApi: RpcTarget, options?: RpcSessionOptions)
    : Promise<Response>;

// Run a WebSocket session.
//
// This is actually the same function as is used on the client side! But on the
// server, you should pass in a `WebSocket` object representing the already-open
// connection, instead of a URL string, and you pass your API implementation as
// the second parameter.
//
// You can dispose the returned `Disposable` to close the connection, or just
// let it run until the client closes it.
function newWebSocketRpcSession(
    webSocket: WebSocket, yourApi: RpcTarget, options?: RpcSessionOptions)
    : Disposable;
```

### HTTP server using Hono

If your app is built on [Hono](https://hono.dev/) (on any runtime it supports), check out [`@hono/capnweb`](https://github.com/honojs/middleware/tree/main/packages/capnweb).

### MessagePort

Cap'n Web can also talk over MessagePorts. This can be used in a browser to talk to Web Workers, iframes, etc.

```ts
import { RpcTarget, RpcStub, newMessagePortRpcSession } from "capnweb";

// Declare our RPC interface.
class Greeter extends RpcTarget {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
};

// Create a MessageChannel (pair of MessagePorts).
let channel = new MessageChannel()

// Initialize the server on port1.
newMessagePortRpcSession(channel.port1, new Greeter());

// Initialize the client on port2.
using stub: RpcStub<Greeter> = newMessagePortRpcSession<Greeter>(channel.port2);

// Now you can make calls.
console.log(await stub.greet("Alice"));
console.log(await stub.greet("Bob"));
```

Of course, in a real-world scenario, you'd probably want to send one of the two ports to another context. A `MessagePort` can itself be transferred to another context using `postMessage()`, e.g. `window.postMessage()`, `worker.postMessage()`, or even `port.postMessage()` on some other existing `MessagePort`.

Note that you should not use a `Window` object itself as a port for RPC -- you should always create a new `MessageChannel` and send one of the ports over. This is because anyone can `postMessage()` to a window, and the RPC system does not authenticate that messages came from the expected sender. You need to verify that you received the port itself from the expected sender first, then let the RPC system take over.

### Custom transports

You can implement a custom RPC transport across any bidirectional stream. To do so, implement the interface `RpcTransport`, which is defined as follows:

```ts
// Interface for an RPC transport, which is a simple bidirectional message stream.
export interface RpcTransport {
  // Sends a message to the other end.
  send(message: string): Promise<void>;

  // Receives a message sent by the other end.
  //
  // If and when the transport becomes disconnected, this will reject. The thrown error will be
  // propagated to all outstanding calls and future calls on any stubs associated with the session.
  // If there are no outstanding calls (and none are made in the future), then the error does not
  // propagate anywhere -- this is considered a "clean" shutdown.
  receive(): Promise<string>;

  // Indicates that the RPC system has suffered an error that prevents the session from continuing.
  // The transport should ideally try to send any queued messages if it can, and then close the
  // connection. (It's not strictly necessary to deliver queued messages, but the last message sent
  // before abort() is called is often an "abort" message, which communicates the error to the
  // peer, so if that is dropped, the peer may have less information about what happened.)
  abort?(reason: any): void;
}
```

You can then set up a connection over it:

```ts
// Create the transport.
let transport: RpcTransport = new MyTransport();

// Create the main interface we will expose to the other end.
let localMain: RpcTarget = new MyMainInterface();

// Start the session.
let session = new RpcSession<RemoteMainInterface>(transport, localMain);

// Get a stub for the other end's main interface.
let stub: RemoteMainInterface = session.getRemoteMain();

// Now we can call methods on the stub.
```

Note that sessions are entirely symmetric: neither side is defined as the "client" nor the "server". Each side can optionally expose a "main interface" to the other. In typical scenarios with a logical client and server, the server exposes a main interface but the client does not.
