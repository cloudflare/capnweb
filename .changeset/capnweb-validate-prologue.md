---
"capnweb-validate": patch
---

Insert the runtime import after a module's hashbang and directive prologue, not at the top of the
file, so a `"use client"` module keeps its directive and an executable module keeps its hashbang.
