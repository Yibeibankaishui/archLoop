# Provider Error Retry Logic

**Decision:** archLoop does not broadly retry on provider errors (rate limits, auth failures, quota errors, generic network timeouts, etc.).

**Exception (Hub flows, #224):** `runHubAgent` retries a narrow set of well-known transient markers when the agent has not yet emitted `<promise>COMPLETE</promise>`:

- `API Error: 400 Invalid request parameters` (claude-code)
- Any `RetriableError:` line (e.g. Cursor `Connection stalled`, `PING timed out`)

Defaults: 3 attempts with 5s / 20s / 60s backoff (`ARCHLOOP_PROVIDER_RETRY_ATTEMPTS`, `ARCHLOOP_PROVIDER_RETRY_BASE_MS`). If completion was already logged, observation-based outcome (#221) wins and no retry runs.

**Why the general rule remains:**

- archLoop shells out to provider CLIs — it doesn't own the API connection or error interface.
- Blindly retrying on any non-zero exit code would mask real errors (bad prompts, auth failures, config issues) and waste time/money.
- Failing fast gives users immediate feedback they can act on — upgrade a plan, wait, or switch providers.

**Principle:** Prefer provider/harness-layer retry. Hub only acts on markers the provider itself already labels as retriable (or the well-known claude-code 400 shape above).

**Rejected (broad retry) in:** #246  
**Narrow Hub transient retry in:** #224
