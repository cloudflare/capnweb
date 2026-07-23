---
"capnweb": patch
---

Remove the ~1ms per-batch latency floor in the HTTP batch client on Node and Bun by flushing via `setImmediate` instead of the clamped `setTimeout(0)`.
