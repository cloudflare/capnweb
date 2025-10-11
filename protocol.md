# RPC Protocol

## Serialization

The protocol uses JSON as its basic serialization, with a preprocessing step to support non-JSON types.

Why not a binary format? While the author is a big fan of optimized binary protocols in other contexts, it cannot be denied that in a browser, JSON has big advantages. Being built-in to the browser gives it a leg up in performance, code size, and developer tooling.

Non-JSON types are encoded using arrays. The first element of the array contains a string type code, and the remaining elements contain the parameters needed to construct that type. For example, a `Date` might be encoded as:

```
["date", 1749342170815]
```

To encode an array, the array must be wrapped in a second layer of array to create an array expression:

```
[["just", "an", "array"]]
```

## Client vs. Server

The protocol does not have a "client" or a "server"; it is fully bidirectional. Either side can call interfaces exported by the other.

With that said, for documentation purposes, we often use the words "client" and "server" when describing specific interactions, in order to make the language easier to understand. The word "client" generally refers to the caller of an RPC, or the importer of a stub. The word "server" refers to the callee, or the exporter. This is merely a convention to make explanations more natural.

## Imports and Exports

Each side of an RPC session maintains two tables: imports and exports. One side's exports correspond to the other side's imports. Imports and exports are assigned sequential numeric IDs. However, in some cases an ID needs to be chosen by the importing side, and in some cases by the exporting side. In order to avoid conflicts:

* When the importing side chooses the ID, it chooses the next positive ID (starting from 1 and going up).
* When the exporting side chooses the ID, it chooses the next negative ID (starting from -1 and going down).
* ID zero is automatically assigned to the "main" interface.

To be more specific:

* The importing side chooses the ID when it initiates a call: the ID represents the result of the call.
* The exporting side chooses the ID when it sends a message containing a stub: the ID represents the target of the stub.

For comparison, in CapTP and Cap'n Proto, there are four tables instead of two: imports, exports, questions, and answers. In this library, we have unified questions with imports, and answers with exports.

By convention, when describing the meaning of any RPC message, we always take the perspective of the sender. So, if a message contains an "import ID", it is an import from the perspective of the sender, and an export from the perspective of the recipient.

Note that IDs are never reused. This differs from Cap'n Proto, which always tries to choose the smallest available ID. We assume no session will ever exceed 2^53 IDs, so simply assigning sequentially should be fine.

## Push and pull

An RPC call follows this sequence:

* The client sends the server a "push" message, containing an expression to evaluate.
    * The "push" message is implicitly assigned the next positive ID in the client's import table.
    * The expression expresses the call to make.
    * Upon receipt, the server evaluates the expression and delivers the call to the application.
* The client subsequently sends the server a "pull" message, specifying the import ID just created by the "push". This expresses that the client is interested in receiving the result of the call as a "resolve" message.
* The client may subsequently refer to the import ID in pipelined requests.
* When the server is done executing the call, it sends a "resolve" message, specifying the export ID of the "push" and an expression for its result.
* Upon receiving the resolution, the client no longer needs the import table entry, so sends a "release" message.
    * Upon receipt, the server disposes its copy of the return value, if necessary.

Some notes:

* The client does not need to send a "pull" message if it doesn't care to receive the results. In practice, if the application never awaits the promise, then it is never pulled. The promise can still be used in pipelining without pulling.
* Technically, the pushed expression can contain any number of calls, including none. A client could, for example, push a large data structure containing no calls, and then subsequently make multiple calls that use this data structure via "pipelining", to avoid having to send the same data multiple times.
* If the call throws an exception, the server will send a "reject" message instead of "resolve".
* "resolve" and "reject" are the same messages used to resolve exported promises, that is, a promise that was introduced when it was sent as part of some other RPC message. Thus, calls and exported promises work the same. This differs from Cap'n Proto, where returning from a call and resolving an exported promise were entirely different messages (with a lot of duplicated semantics).

## Top-level RPC Messages

The following are the top-level messages that can be sent over the RPC transport.

`["push", expression]`

Asks the recipient to evaluate the given expression. The expression is implicitly assigned the next sequential import ID (in the positive direction). The recipient will evaluate the expression, delivering any calls therein to the application. The final result can be pulled, or used in promise pipelining.

`["pull", importId]`

Signals that the sender would like to receive a "resolve" message for the resolution of the given import, which must refer to a promise. This is normally only used for imports created by a "push", as exported promises are pulled automatically.

`["resolve", exportId, expression]`

Instructs the recipient to evaluate the given expression and then use it as the resolution of the given promise export.

`["reject", exportId, expression]`

Instructs the recipient to evaluate the given expression and then use it to reject the given promise export. The expression is not permitted to contain stubs. It typically evaluates to an `Error`, although technically JavaScript does not require that thrown values are `Error`s.

`["release", importId, refcount]`

Instructs the recipient to release the given entry in the import table, disposing whatever it is connected to. If the import is a promise, the recipient is no longer obliged to send a "resolve" message for it, though it is still permitted to do so.

`refcount` is the total number of times this import ID has been "introduced", i.e. the number of times it has been the subject of an "export" or "promise" expression, plus 1 if it was created by a "push". The refcount must be sent to avoid a race condition if the receiving side has recently exported the same ID again. The exporter remembers how many times they have exported this ID, decrementing it by the refcount of any release messages received, and only actually releases the ID when this count reaches zero.

`["abort", expression]`

Indicates that the sender has experienced an error causing it to terminate the session. The expression evaluates to the error which caused the abort. No further messages will be sent nor received.

## Expressions

Expressions are JSON-serializable object trees. All JSON types except arrays are interpreted literally. Arrays are further evaluated into a final value as follows.

`[[...]]`

An array expression. The inner array contains expressions (one for each array element), which are individually evaluated to produce the final array value.

For example, this expression represents an object containing an array:

```
{
  "key": [[
    "abc",
    ["date", 1757214689123],
    [[0]]
  ]]
}
```

This is an expression which will evaluate to an object. The expression representing the value of the "key" field is an array expression.
- The 1st item in the array expression is an expression for the string "abc"
- The 2nd item is an expression for a date object
- The 3rd item is another array expression containing an integer expression representing zero.

This expression will evaluate to the following object:
```
{
  "key": [
    "abc",
    Date(1757214689123),
    [0]
  ]
}
```

`["date", number]`

A JavaScript `Date` value. The number represents milliseconds since the Unix epoch.

`["error", type, message, stack?]`

A JavaScript `Error` value. `type` is the name of the specific well-known `Error` subclass, e.g. "TypeError". `message` is a string containing the error message. `stack` may optionally contain the stack trace, though by default stacks will be redacted for security reasons.

_TODO: We should extend this to encode own properties that have been added to the error._

`["import", importId, propertyPath, callArguments]`
`["pipeline", importId, propertyPath, callArguments]`

References an entry on the import table (from the perspective of the sender), possibly performing actions on it.

If the type is "import", the expression evaluates to a stub. If it is "pipeline", the expression evaluates to a promise. The difference is important because promises must be replaced with their resolution before delivering the message to the application, whereas stubs will be delivered as stubs without waiting for any resolution.

`propertyPath` is optional. If specified, it is an array of property names (strings or numbers) leading to a specific property of the import's target. The expression evaluates to that property (unless `callArguments` is also specified).

`callArguments` is also optional. If specified, then the given property should be called as a function. `callArguments` is an array of expressions; these expressions are evaluated to produce the arguments to the call.

`["remap", importId, propertyPath, captures, instructions]`

Implements the `.map()` operation. (We call this "remap" so as not to confuse with the serialization of a `Map` object.)

`importId` and `propertyPath` are the same as for the `"import"` operation. These identify the particular property which is to be mapped.

`captures` and `instructions` define the mapper function which is to apply to the target value.

`captures` defines the set of stubs which the mapper function has captured, in the sense of a lambda capture. The body of the function may call these stubs. The format of `captures` is an array, where each member of the array is either `["import", importId]` or `["export", exportId]`, which refer to an entry on the (sender's) import or export table, respectively.

`instructions` contains a list of expressions which should be evaluated to execute the mapper function on a particular input value. Each instruction is an expression in the same format described in this doc, but with special handling of imports and exports. For the purpose of the instructions in a mapper, there is no export table. The import table, meanwhile, is defined as follows:
* Negative values refer to the `captures` list, starting from -1. So, -1 is `captures[0]`, -2 is `captures[1]`, and so on.
* Zero refers to the input value of the map function.
* Positive values refer to the results of previous instructions, starting from 1. So, 1 is the result of evaluating `instructions[0]`, 2 is the result of evaluating `instructions[1]`, and so on.

The instructions are always evaluated in order. Each instruction may only import results of instructions that came before it. The last instruction evaluates to the return value of the map function.

`["export", exportId]`

The sender is exporting a new stub (or re-exporting a stub that was exported before). The expression evaluates to a stub.

`["promise", exportId]`

Like "export", but the expression evaluates to a promise. Promises must be replaced with their resolution before the message is finally delivered to the application.

The `exportId` in this case is always a newly-allocated ID. The sender will proactively send a "resolve" (or "reject") message for this ID when the promise resolves (unless it is released first). The recipient does not need to "pull" the promise explicitly; it is assumed that the recipient always wants the resolution.
