---
"@yibeibankaishui/archloop": patch
---

Accept `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` as auth fallbacks for the `claude-code` and `pi` providers in the credential preflight, so users with a long-lived Claude Code OAuth token (from `claude setup-token`) or a Claude-compatible gateway (`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`) no longer need `ANTHROPIC_API_KEY` to pass the archloop env guard. Missing-credential and auth-failure messages now mention both alternatives.
