---
"@yibeibankaishui/archloop": patch
---

Add an `ARCHLOOP_HUB_MAX_ITERATIONS` env var (read from the Hub agent input env, then `process.env`) to cap iterations for Hub flow agent runs, defaulting to 20 instead of the `run()` default of 1. This lets Hub implementation/review agents iterate through their full task loop rather than stopping after a single iteration.
