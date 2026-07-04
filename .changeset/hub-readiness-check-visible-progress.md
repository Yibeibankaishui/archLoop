---
"@yibeibankaishui/archloop": patch
---

Add `archloop check --hub` as a visible Hub readiness slice. The command now renders progress for Hub validation, checks agent role completeness, shared credential/auth presence, configured provider references, provider CLI availability, and grouped provider/model smoke checks through the real provider path. It deduplicates smoke checks by provider, model, and options, lists the roles covered by each check, and still returns a non-zero exit code for blocking errors.
