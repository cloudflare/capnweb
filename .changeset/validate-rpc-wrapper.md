---
"capnweb-validate": minor
---

`validateRpc()` is also a higher-order function that takes a class and returns it, for builds that can't enable decorators. `export default validateRpc(Api)` is equivalent to `@validateRpc()`, and `validateRpc<Surface>()(Api)` is equivalent to `@validateRpc<Surface>()`. The method decorator `@skipRpcValidation()` has no wrapper equivalent, so the wrapper form takes the method names instead: `validateRpc(Api, { skip: ["raw"] })`.
