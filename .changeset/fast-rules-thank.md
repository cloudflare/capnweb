---
"capnweb": minor
---

Fixed incompatibility with bundlers that don't support top-level await. The top-level await was used for a conditional import; it has been replaced with an approach based on "exports" in package.json instead.
