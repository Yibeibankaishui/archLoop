---
"@yibeibankaishui/archloop": patch
---

Retry Hub provider CLI invocations on well-known transient errors (`API Error: 400 Invalid request parameters`, `RetriableError:` markers) with bounded exponential backoff before treating the run as failed. Override with `ARCHLOOP_PROVIDER_RETRY_ATTEMPTS` and `ARCHLOOP_PROVIDER_RETRY_BASE_MS`; skip retry when `<promise>COMPLETE</promise>` is already in the agent log.
