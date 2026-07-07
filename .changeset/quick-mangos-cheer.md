---
---

Internal cleanup (no behavior change): derive the WebSocket close-reason byte limit from the RFC 6455 Close-frame size (`125 - 2`) instead of a bare `123`, use a null-prototype object literal for the error-type map, and extend the close-reason test to split a multi-byte character at the limit.
