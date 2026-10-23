---
"capnweb": patch
---

Disposing a remote stub other than the session's main stub, along with all its duplicates, now
unregisters the `onRpcBroken()` callbacks registered on it. Previously the session kept them alive
and called them when the connection was later lost. Stubs received as call parameters are disposed
when the call returns, so `.dup()` one to keep listening on it.
