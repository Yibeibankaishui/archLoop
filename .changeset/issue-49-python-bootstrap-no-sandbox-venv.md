---
"@ai-hero/sandcastle": patch
---

Harden the Python project profile bootstrap for no-sandbox hosts.

- Treat `.venv` as valid only when `.venv/bin/activate` exists; remove incomplete directories and fail with actionable host guidance when venv creation fails.
- Document no-sandbox + Python host prerequisites in init next steps and README.
