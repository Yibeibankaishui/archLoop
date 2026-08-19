---
"@yibeibankaishui/archloop": patch
---

Persist checkout branch-relation diagnostics (observed host OID, publish-target OID, ahead/behind/diverged/missing) on pending checkout projection outbox items and expose them in run output, JSON, and live events. Branch divergence reports `completed_with_pending_checkout_sync` with explicit no-host-mutation guidance instead of a generic run failure.
