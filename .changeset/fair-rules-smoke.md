---
"capnweb": patch
---

Fix memory leak that kept all messages received in a session pinned in memory until the session ended, due to surprising implementation details of JavaScript Promises.
