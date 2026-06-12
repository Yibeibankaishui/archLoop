---
"@ai-hero/sandcastle": patch
---

Project profiles now substitute stack-specific verification guidance into scaffolded workflow prompts during `sandcastle init`. Templates use `{{PROJECT_PROFILE_VERIFY_GUIDANCE}}` so `python` and `cpp` no longer default to npm checks, while `node` keeps npm-oriented guidance and `generic` stays user-editable. Capability pack prompt assembly remains unchanged and composes after profile substitution.
