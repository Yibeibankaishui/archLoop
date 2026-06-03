---
"@ai-hero/sandcastle": patch
---

Address WSL2/root + Docker init field report (#29): scaffold `containerUid`/`containerGid` in `main.mts` when init runs as root, print Docker root guidance in init next steps, improve UID-mismatch errors for host UID 0, and surface git-remote setup hints for GitHub Issues backlog (missing or duplicated `https://github.com/` URLs).
