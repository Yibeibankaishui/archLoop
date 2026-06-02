---
"@ai-hero/sandcastle": patch
---

Add Mini Program platform validation via the project-local `miniprogram-ci` Node API in the native fallback verifier, including AppID/upload-key resolution, conditional `packNpm`, preview QR artifacts, and `platform_validation_status` reporting in `debug/wx-check.log`.
