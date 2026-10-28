---
"capnweb": patch
---

Preserve the name of error types that can't be reconstructed on the receiving side.

Errors whose type isn't a built-in (for example a custom `ArtifactsError`) are still delivered as plain `Error`, but now keep the sender's `name`. Names that resolve to `Object.prototype` members still fall back to `Error`. This matches how workerd delivers these errors between Workers.
