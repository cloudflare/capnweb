---
"capnweb-validate": minor
---

Export `isValidationError(error)`, which tells an error the validator threw from any other error by
the tag it already set on it, for a server to read in Cap'n Web's `onSendError`. The tag is now a
`Symbol.for` symbol, so a second bundled copy of the package recognizes it too.
