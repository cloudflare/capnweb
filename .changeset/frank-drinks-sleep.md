---
"capnweb": patch
---

Attempting to remotely access an instance property of an RpcTarget will now throw an exception rather than returning `undefined`, in order to help people understand what went wrong.
