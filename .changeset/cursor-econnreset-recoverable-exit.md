---
"@ai-hero/sandcastle": patch
---

Treat Cursor agent runs as successful when the CLI exits non-zero with ECONNRESET during connection teardown but a valid result was already captured from the stream.
