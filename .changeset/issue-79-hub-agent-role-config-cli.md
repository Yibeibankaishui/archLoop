---
"@ai-hero/sandcastle": patch
---

Add Hub-wide agent role configuration CLI: `sandcastle agent-config path`, `show`, and `set-role <role> --provider <provider> --model <model>`. Role config lives in the Sandcastle user data directory, stores provider/model/options only, reports missing roles clearly, and fails non-interactive flows with actionable setup guidance.
