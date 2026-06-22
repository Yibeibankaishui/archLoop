# PRD: Worktree Lease

## Problem Statement

archLoop uses **worktrees** to let agents work through non-**head** **branch strategies**. Today, a **worktree** can be reused when the same named branch is targeted again, including when that **worktree** is dirty. That makes retry and continuation convenient, but it does not distinguish a preserved **worktree** from a **worktree** that is actively being used by another run, interactive session, sandbox handle, or Hub **flow**.

Users need archLoop to prevent two agents from silently editing the same task branch and **worktree** at the same time. They also need failed Hub **tasks** to remain retryable without losing partially completed code. The product should make active execution, retry, stale execution, and recovery states clear to both humans and agents.

## Solution

Introduce a **worktree lease** as the internal resource lifecycle model for **worktrees**. A **worktree lease** is a time-bounded claim that one archLoop run session, interactive session, handle, or Hub **flow** owns a **worktree**. The lease is implemented with a file-based lock in the **config directory**, but users do not manage lease files directly.

Every non-**head** **branch strategy** must acquire a **worktree lease** before an **agent** can use the **worktree**. Active leases are exclusive: if another caller targets the same active **worktree**, archLoop fails fast with an already-running or in-use diagnostic rather than waiting, retrying, or choosing a different **worktree**.

Hub **flows** include task-first owner context in the lease. When a Hub retry sees an active lease, it reports that the **task** already has active execution. When the previous execution failed and released its lease, retry starts a new agent execution attempt from the preserved task branch and **worktree**. Retry does not discard partially completed code.

Stale leases can be cleared when their owner process is gone, but clearing a stale lease never deletes or resets the **worktree**. Hub status and doctor workflows should use lease diagnostics to guide users toward wait, retry, repair, or recovery actions.

## User Stories

1. As an agent operator, I want two agents to be prevented from using the same task **worktree** at the same time, so that concurrent execution does not corrupt or overwrite work.
2. As an agent operator, I want duplicate starts for the same named branch to fail clearly, so that I can understand that the **worktree** is already active.
3. As a Hub user, I want a retry attempt to detect when a **task** is still running, so that I do not accidentally start the same **task** twice.
4. As a Hub user, I want retry of a failed **task** to continue from the preserved task branch and **worktree**, so that partially completed code is not lost.
5. As a Hub user, I want retry to tell the **agent** that preserved code may already exist, so that the agent continues the previous attempt instead of starting from scratch.
6. As a Hub user, I want an active retry conflict to be reported as active execution rather than retry failure, so that I understand the task is still running.
7. As a Hub user, I want stale execution to be recoverable, so that crashed processes do not permanently block a **task**.
8. As a Hub user, I want stale lease cleanup to preserve the **worktree**, so that recovery does not discard useful code.
9. As a maintainer, I want Hub **task** claim state and **worktree lease** state to remain separate, so that task ownership and host resource occupancy do not become confused.
10. As a maintainer, I want Hub **task** claim state and **worktree lease** state to be cross-checked, so that inconsistent execution states can enter diagnosis or recovery.
11. As a maintainer, I want **worktree lease** diagnostics to include **task**, **flow**, **flow batch**, branch, process, and acquisition time when available, so that I can identify the active owner quickly.
12. As a maintainer, I want direct `run`, `interactive`, `createWorktree`, and `createSandbox` callers to use the same lease model, so that safety does not depend on whether Hub is involved.
13. As a maintainer, I want direct callers without Hub context to still get useful owner diagnostics, so that raw branch-based workflows remain understandable.
14. As a maintainer, I want handle-producing entry points to hold a lease for the handle lifetime, so that a long-lived handle cannot be raced by another process.
15. As a maintainer, I want one-shot entry points to hold a lease for the single call lifetime, so that normal runs release the resource automatically.
16. As a maintainer, I want active lease force takeover to be unsupported in the first version, so that archLoop never silently allows two live contexts to edit the same **worktree**.
17. As a maintainer, I want dirty **worktree** reuse to remain allowed when there is no active lease, so that ADR 0003 retry and continuation behavior remains intact.
18. As a maintainer, I want active lease conflicts to block reuse regardless of dirty state, so that the safety rule is about concurrent use rather than file cleanliness.
19. As a maintainer, I want lease metadata to avoid prompts, environment variables, full command lines, agent output, and user-provided task content, so that diagnostics do not leak sensitive data.
20. As a maintainer, I want detailed execution content to remain in Hub run logs and events, so that lease metadata stays small and safe.
21. As a project operator, I want status and doctor workflows to show active, stale, and mismatched lease states, so that I can choose wait, retry, repair, or recovery without inspecting lock files.
22. As a project operator, I do not want a standalone unlock command in the first version, so that users are not encouraged to bypass the active-lease safety model.
23. As an agent working on archLoop itself, I want lease conflict diagnostics to include the right next action, so that I can stop guessing whether to wait, retry, repair, or choose another branch.
24. As an agent working on archLoop itself, I want the rules for **worktree lease**, Hub **task** claim, retry, and recovery to be documented in project language, so that future code changes are more accurate.
25. As a future GUI user, I want active execution and retry states to be represented in stable Hub concepts, so that the GUI can reuse the same diagnostics as the CLI.

## Implementation Decisions

- Build a deep **Worktree lease** module that owns acquisition, release, stale detection, owner metadata validation, conflict errors, and lease diagnostics behind a small interface.
- Treat the file-based lock as the implementation mechanism for the **worktree lease**, not as the domain concept users interact with.
- Require every non-**head** **branch strategy** to acquire a **worktree lease** before the **agent** can use the **worktree**.
- Keep **head** outside the lease model because it operates on the **host** working directory and does not use a managed **worktree**.
- Use atomic lock creation so two processes cannot both observe an unlocked **worktree** and acquire it.
- Store locks in the **config directory** outside the **worktree**, so agents cannot accidentally edit, delete, or commit lease files.
- Include owner metadata for all leases. Direct callers use a direct owner shape. Hub **flows** use a task-first owner shape.
- For Hub owners, record **task** as the primary owner and **flow** plus **flow batch** as coordination context.
- Do not record full command lines, prompts, environment variables, agent output, or user task content in lease metadata.
- Fail fast on active lease conflict. Do not wait, retry, or automatically select an alternate **worktree**.
- Do not support active lease force takeover in the first version.
- If the owner process is dead, treat the lease as stale and allow cleanup of the lease file.
- Stale lease cleanup must never delete, reset, or clean the corresponding **worktree**.
- Preserve ADR 0003 dirty **worktree** reuse. Dirty work without an active lease may still be reused with a warning.
- Make active lease conflicts independent of dirty state. A clean **worktree** with an active lease is still unavailable.
- Keep Hub **task** claim metadata and **worktree lease** metadata separate. The claim owns task and retry context; the lease owns live resource occupancy.
- Cross-check Hub claim and lease state in status and doctor workflows. Inconsistent states should enter diagnosis or recovery instead of being silently resolved.
- For one-shot run and interactive entry points, scope the lease to the call.
- For handle-producing entry points, scope the lease to the returned handle lifetime and release on close or scope finalization.
- Hub retry requires no active **worktree lease** for the task **worktree**.
- Hub retry after failure starts a new agent execution attempt on the preserved task branch and **worktree**.
- Hub retry context must tell the **agent** that preserved code may already exist and should be inspected before editing.
- Hub retry encountering an active lease should report active execution, not retry failure.
- Hub status and doctor workflows should expose lease diagnostics through existing task/status/recovery language, not through standalone lease management commands.
- The design includes Hub task execution from the start, even if implementation is delivered incrementally.

## Testing Decisions

- Tests should focus on externally visible behavior: whether leases prevent concurrent use, release correctly, preserve **worktrees**, guide retry/recovery, and surface useful diagnostics.
- The **Worktree lease** module should have focused tests for atomic acquisition, active conflict, stale cleanup, malformed metadata, release, and owner diagnostics.
- Worktree lifecycle tests should cover one-shot entry points and handle-producing entry points with different lease lifetimes.
- Branch strategy tests should verify that **merge-to-head** and **branch** acquire leases while **head** does not.
- Dirty reuse tests should verify that an unlocked dirty **worktree** remains reusable with a warning.
- Active conflict tests should verify that both clean and dirty **worktrees** are unavailable when an active lease exists.
- Stale cleanup tests should verify that stale lease files can be removed without deleting or resetting the **worktree**.
- Hub retry tests should verify that failed tasks retry from preserved task branch/worktree state.
- Hub retry tests should verify that active execution is reported as already running rather than retry failure.
- Hub status and doctor tests should cover claim active plus lease active, claim active plus no lease, failed claim plus active lease, failed claim plus stale lease, and lease active without Hub claim.
- Error message tests should assert stable semantic fields and next-action guidance, not exact formatting beyond the public contract.
- Metadata tests should verify that prompts, environment variables, full command lines, agent output, and user task content are not written into lease metadata.
- Prior art includes existing worktree reuse tests, Windows mount tests around sandbox creation, Hub task lifecycle tests, Hub task state doctor tests, and task board claim tests.

## Out of Scope

- Standalone user-facing lease management commands.
- Active lease force takeover.
- Automatically deleting, resetting, or cleaning dirty **worktrees** during retry or stale cleanup.
- Changing the existing ADR 0003 dirty **worktree** reuse behavior.
- Making **worktree leases** a remote task source concept.
- Syncing lease state to GitHub Issues or other remote task sources.
- Storing prompts, environment variables, full command lines, or agent output in lease metadata.
- Provider-native agent session resume behavior.
- A GUI for lease management.

## Further Notes

This PRD refines ADR 0007 from a file-locking decision into a **worktree lease** product and architecture decision. The goal is not merely to add a lock file. The goal is to improve archLoop's long-term ability to run and develop with agents by making concurrent execution, retry, stale recovery, and task ownership explicit.

Implementation can be staged, but the design should remain complete: direct callers and Hub **flows** must share the same resource model, and Hub retry/recovery semantics must be represented from the first schema shape.
