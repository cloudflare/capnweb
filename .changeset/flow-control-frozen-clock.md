---
"capnweb": patch
---

Fix the flow-control window of a `WritableStream` sent over RPC becoming `NaN` when the clock does not advance between a write and its acknowledgement (e.g. on Cloudflare Workers, where the clock is coarse). A writer waiting on backpressure was never released, or backpressure stopped being applied.
