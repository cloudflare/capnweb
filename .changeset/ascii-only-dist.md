---
"capnweb": patch
---

Keep the published runtime bundles ASCII-only. A doc comment introduced by #209 (first published in 0.11.0) carried a U+2212 into every dist bundle, which breaks consumers that inline the bundle through Latin-1-only APIs like `btoa()`. The comment is fixed and the build now fails if any non-ASCII character reaches a runtime bundle in `dist/`.
