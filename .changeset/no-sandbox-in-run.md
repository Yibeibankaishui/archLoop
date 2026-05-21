---
"@ai-hero/sandcastle": patch
---

Allow `noSandbox()` in `run()` and `createSandbox()`. Previously it was only accepted by `interactive()`. Use this when running Sandcastle from inside an already-isolated environment (containerized CI, VM, sandbox host) and you want the agent to operate directly on the host without a nested container.
