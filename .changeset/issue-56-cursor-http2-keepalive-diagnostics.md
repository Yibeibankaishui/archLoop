---
"@ai-hero/sandcastle": patch
---

Improve Cursor agent failure diagnostics for HTTP/2 keepalive and other transport teardown errors, with actionable recovery guidance. Treat keepalive teardown as recoverable when a valid stream result was already captured.
