---
"capnweb": patch
---

Propagate pipe setup failures, including locked ReadableStreams, to the receiving stream instead of leaving its reads pending indefinitely.
