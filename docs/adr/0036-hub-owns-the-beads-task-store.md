# Hub owns the Beads task store outside the code repository

**archLoop Hub** stores each registered project's live Beads database and runtime/export files in the stable **Hub project directory**, outside the code repository. A Git-ignored `.beads/redirect` preserves direct host `bd` discovery. Hub execution Agents consume immutable task snapshots and do not write the live task store.

## Decision

All Hub task-store operations resolve one of three explicit states: legacy repository-local store, Hub-managed store, or repository redirect to the managed store. Once the managed store is verified, archLoop invokes Beads with the explicit managed location rather than relying on worktree discovery. Every archLoop-created worktree or sandbox receives the correct read-only or orchestrator-owned task-store context.

New registered projects initialize the store under their stable Hub project directory. Existing projects migrate automatically on first mutating use through an independent journal and migration lease:

`legacy_active -> snapshot_prepared -> legacy_quarantined -> managed_copied -> redirect_installed -> verified`.

Migration confirms there is no active writer and records a source fingerprint before switching. The legacy embedded Dolt data is atomically quarantined in its original filesystem, then cold-copied and fsynced to the managed location when necessary. The destination is verified through Beads location/health, database identity, prefix/schema, task ids and counts, dependency/comment summaries, and working state before the official redirect is installed and accepted. The first release retains the original data as a recoverable backup.

If an external Beads writer, source-generation change, unsafe snapshot, or migration contention is detected before quarantine, archLoop continues the run against the verified legacy store, records migration pending, and retries later. A crash resumes from physical paths, fingerprints, redirect resolution, database health, and the journal. If both stores are modified after redirect, archLoop reports a task-store split-brain integrity incident and stops automatic task-store writes rather than silently merging databases.

The repository redirect is local and Git-ignored. Existing intentionally tracked Beads configuration, documentation, or hooks are preserved; archLoop does not manufacture code-branch deletions. Direct host `bd` commands and archLoop-managed sandboxes remain compatible. Arbitrary third-party containers that cannot access host paths are outside this compatibility guarantee.

Execution Agents receive an immutable, task-scoped snapshot containing the selected task, parent PRD, dependencies, comments, acceptance criteria, and required remote references. Snapshot storage uses restrictive permissions, exclusive creation, and symlink rejection. Agents return structured task notes for Hub orchestration to apply. They do not receive credentials, unrelated tasks, or write access to the live database.

Legacy task branches may already contain Beads runtime/export changes. A narrow allowlist of known runtime/export paths is removed deterministically from merge candidates and recorded in transaction diagnostics, so the code portion can continue. archLoop must not treat every `.beads/` path as disposable: intentional configuration, documentation, and hook changes remain ordinary source changes.

## Consequences

- Beads database, Dolt, JSONL, and interaction writes no longer dirty the user's code checkout or participate in Hub landing.
- Registered-project task commands keep their normal CLI surface, and direct host `bd` remains discoverable through the redirect.
- Automatic migration is resumable and non-blocking before quarantine; task-store split brain is an integrity condition rather than an auto-recovery guess.
- Hub orchestration becomes the only writer of Hub task lifecycle state during flows; Agents operate on immutable task context.
- Proposal mutation detection and project readiness must resolve the actual managed/legacy store rather than assume `<repo>/.beads`.

## Considered Options

1. **Keep the live database in the code repository and ignore dirty files in preflight** -- rejected because the real Git operation can still encounter staged or modified Beads files and future code paths can repeat the same coupling.
2. **Copy the live Dolt directory while Beads may be writing** -- rejected because file copying does not provide a consistent database snapshot and can create two writable histories.
3. **Remove direct `bd` compatibility** -- rejected because an official redirect provides compatibility without returning runtime data to code branches.
4. **Give execution Agents read/write access to the managed store** -- rejected because task lifecycle writes belong to Hub orchestration and broad database access expands both race and data-exposure boundaries.
5. **Discard all `.beads/` changes from legacy task branches** -- rejected because some configuration, documentation, or hook changes can be intentional source work.

## Supersedes

This decision supersedes ADR-0027. Classifying repository-local Beads dirtiness is retained only as a migration compatibility measure; the steady-state architecture removes live runtime/export data from the code repository.
