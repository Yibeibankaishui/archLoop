---
"@yibeibankaishui/archloop": patch
---

Add `archloop check --hub` as a visible Hub readiness slice. The new command renders progress for static Hub validation, checks agent role completeness, shared credential/auth presence, configured provider references, and provider CLI availability, and returns a non-zero exit code for blocking errors while warning that provider/model smoke checks are deferred until a later slice.
