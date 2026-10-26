---
"capnweb": patch
---

Fix `MessagePort` sessions leaking a byte view's entire backing buffer instead of only the view's bytes.
