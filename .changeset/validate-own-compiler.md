---
"capnweb-validate": patch
---

Ship `typescript` as a dependency (`>=5.7.0 <7`) instead of an uncapped peer, so the build-time transform keeps a JS-based compiler API in TypeScript 7 (tsgo) workspaces.
