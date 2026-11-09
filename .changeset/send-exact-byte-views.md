---
"capnweb": minor
---

Fix `MessagePort` sessions leaking a byte view's entire backing buffer, avoid copying aligned byte views at `jsonCompatibleWithBytes`, and add `transferArrayBuffer()` for zero-copy `MessagePort` transfers.
