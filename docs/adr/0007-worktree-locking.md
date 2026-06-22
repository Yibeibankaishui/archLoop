# Worktree lease for concurrent access prevention

## Context

ADR 0003 introduced dirty-**worktree** reuse for the **branch** strategy: when a **worktree** already exists for a named branch, `WorktreeManager.create()` reuses it — logging for clean, warning for dirty. This removed the `throwOnDuplicateWorktree` guard, which had been incidentally preventing some concurrent access scenarios.

The consequence is that two `run()` or `interactive()` calls targeting the same named branch can both be handed the same **worktree** directory simultaneously. There is no mechanism to detect or prevent this — the collision detection in `WorktreeManager.create()` checks whether a **worktree** exists, not whether another process is currently using it.

The **merge-to-head** strategy has the same **worktree** lifecycle, but timestamped branch names make lock contention unlikely.

## Decision

Add a **worktree lease** to prevent concurrent access to a **worktree**. A file-based lock is the lease mechanism: acquired when `WorktreeManager.create()` hands out a **worktree**, released when the scope finalizer runs (via `close()`, abort, or process exit).

The design includes both direct callers and Hub task flows from the start. It may be implemented incrementally, but the lock schema, owner context, retry semantics, and diagnostics must remain compatible with Hub task execution rather than treating Hub as a later add-on.

### Lock location and naming

Lock files live in the **config directory** at `.archloop/locks/<name>.lock`, where `<name>` matches the **worktree** directory name under `.archloop/worktrees/<name>/`. This keeps locks separate from **worktree** contents (invisible to the **agent**) and provides a 1:1 mapping between **worktrees** and locks.

### Lock content

```json
{
  "pid": 12345,
  "branch": "feature/auth",
  "acquiredAt": "2026-04-22T10:30:00Z",
  "owner": {
    "kind": "hub-task",
    "taskId": "bd-42",
    "flowId": "implement",
    "flowBatchId": "batch-20260422-103000"
  }
}
```

PID enables stale detection. Branch and timestamp aid debugging. The owner context is always present: direct `run()`, `interactive()`, `createWorktree()`, and `createSandbox()` callers use a direct owner shape, while Hub **flows** use a task-first owner shape. When a **worktree lease** is acquired from a Hub **flow**, **task** identifies the primary owner, while **flow** and **flow batch** identify the coordination context. This lets users and agents identify the active Hub work instead of seeing only a process id.

The lock content records identity and recovery context only. It must not include the full command line, **prompt**, environment variables, agent output, or user-provided task content. Detailed execution diagnostics belong in Hub run logs and events, not in **worktree lease** metadata.

### Lock acquisition

Lock creation must be atomic (e.g. `fs.open` with `O_EXCL` flag or equivalent) to prevent the meta-race where two processes both observe "no lock" and both write. If the lock file already exists:

1. Read the PID from the lock file.
2. Check if the owning process is alive (`process.kill(pid, 0)`).
3. If alive — fail fast with a clear error: "Worktree is in use by process &lt;PID&gt;".
4. If dead — remove the stale lock and reacquire.

There is no wait/retry behavior and no automatic alternate **worktree** selection. Contention means two callers targeted the same active **worktree lease**, which is a caller error. This is consistent with the project's fail-fast philosophy (see `.out-of-scope/provider-error-retry.md`).

The first version does not support force takeover of an active **worktree lease**. If the owner process is alive, the lease remains active; callers must close the owning handle, stop the process, wait for release, or choose a different branch.

For Hub task retry, an active **worktree lease** means the previous execution attempt is still running and the retry must not start. If the previous attempt failed and released its lease, retry starts a new agent execution attempt on the preserved task branch and **worktree**; retry does not discard partially completed code. Discarding preserved work is an explicit recovery action, not the default retry path.

When a Hub retry encounters an active **worktree lease**, archLoop reports the task as already having an active execution rather than reporting the retry itself as failed. The message includes the owning **task**, **flow batch**, branch, owner process, and acquisition time, then directs the user to wait or recover stale execution state.

Hub task claim metadata and **worktree leases** remain separate concepts. A Hub task claim says a **task** is owned by a **flow batch** and records the target branch for retry/recovery. A **worktree lease** says a host **worktree** is currently occupied by a live execution. They reference overlapping owner context for diagnostics, but one is not a substitute for the other.

When Hub task claim metadata and a **worktree lease** disagree, each is authoritative only for its own concern: the **worktree lease** is authoritative for whether a **worktree** is currently occupied by a live execution, while the Hub task claim is authoritative for task ownership, branch, and retry/recovery context. Inconsistent states enter diagnosis or recovery instead of being silently resolved.

### Lock release

The lock is released when the Effect scope closes — whether via `close()`, abort, error, or process exit. Release is independent of **worktree** state: a dirty **worktree** is preserved on disk for future reuse, but the lock is always released. The lock protects concurrent access to a **worktree**, not the **worktree**'s existence on disk.

For one-shot `run()` and `interactive()` entry points, the **worktree lease** lasts for that single call. For handle-producing entry points such as `createWorktree()` and `createSandbox()`, the **worktree lease** lasts for the returned handle's lifetime and is released by `close()` or scope finalization.

### Stale lock cleanup

`pruneStale()` cleans up stale locks alongside orphaned **worktree** directories:

- Lock files whose corresponding **worktree** directory no longer exists — remove.
- Lock files whose owning PID is dead — remove.

Removing a stale lock never deletes or resets the corresponding **worktree**. If Hub task state still shows an active execution after the owner process is gone, archLoop should guide the user through recovery or repair before retrying; the preserved code remains available for that retry.

### Scope

The **worktree lease** applies to every non-**head** **branch strategy**, because both **merge-to-head** and **branch** hand a **worktree** to an **agent**. Lock contention is expected primarily for the **branch** strategy, where callers can target the same named branch. The **head** strategy operates on the **host** working directory, which is outside `WorktreeManager`'s purview.

This decision does not change ADR 0003's dirty **worktree** reuse rule. A dirty **worktree** without an active **worktree lease** may still be reused with a warning. An active **worktree lease** blocks reuse whether the **worktree** is clean or dirty, because the risk is concurrent use rather than uncommitted changes.

### Rejected alternatives

- **Wait/retry on contention.** Adds complexity (backoff, timeout, cancellation) for a scenario that indicates a caller error. Consistent with the project's fail-fast philosophy.
- **Lock inside the worktree** (e.g. `<worktree-path>/.archloop.lock`). Visible to the **agent**, which could delete or commit it. Would require `.gitignore` management.
- **In-memory mutex/semaphore.** Only protects within a single Node process. The threat model is two separate processes — e.g. two `run()` calls from different terminals or CI jobs.
- **User-facing lease management commands in the first version.** **Worktree leases** are internal resource lifecycle state. Users should interact through task, status, retry, and recovery workflows rather than manually listing or unlocking lease files. A user-facing unlock command would encourage bypassing the active-lease safety model.

## Consequences

- Two concurrent `run()` or `interactive()` calls targeting the same named **worktree** get a clear error on the second call, rather than silently sharing a **worktree**.
- The `.archloop/locks/` directory becomes a new managed directory in the **config directory**.
- A crashed process does not permanently lock a **worktree** — stale detection via PID liveness check ensures recovery.
- This closes the open thread from ADR 0003: "Worktree locking (#401) is a future mitigation for the concurrent-access risk this opens up."
- Users see product-level improvements, not just a lock file: concurrent agents cannot silently edit the same task branch, Hub task retry continues from preserved code, duplicate starts report an active execution, stale leases recover without deleting work, and diagnostics give agents enough task/flow/branch/process context to choose the right next action.
- Hub status and doctor workflows should expose **worktree lease** state as diagnostics, such as active execution, stale execution, or claim/lease mismatch. They should guide users toward wait, retry, repair, or recovery actions without adding a standalone lease management surface.
