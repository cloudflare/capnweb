---
"capnweb": patch
---

Fix an unhandled rejection when a call that was passed a promise fails, or is forwarded, before the promise is pulled.
