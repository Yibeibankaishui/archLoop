# archLoop Worktree Lease Manual QA

本文档补充 [Hub task board QA](./archloop-hub-task-board.md)，专门验收 **worktree lease** 的可观察行为。Lease 是 archLoop 内部的 worktree 资源生命周期模型，用户不直接管理 `.archloop/locks/` 文件。

## Scope

覆盖范围：

- 非 `head` branch strategy 的 one-shot lease（`run()` / `interactive()`）
- handle-owned lease（`createWorktree()` / `createSandbox()`）
- duplicate start 冲突诊断
- stale lease 恢复（不删除 preserved worktree）
- Hub retry 从 preserved branch/worktree 继续
- `archloop project status` 与 `archloop tasks doctor` 的 claim/lease mismatch 诊断

不覆盖范围：

- 独立 unlock / lease 管理 CLI（第一版 intentionally unsupported）
- active lease force takeover
- 远程 task source 上的 lease 同步

## Prerequisites

- `ARCHLOOP_REPO` 与 `TARGET_REPO` 已按 Hub QA 文档准备。
- 本地 CLI 已 build：`npm run build && npm run typecheck`。
- 至少一个可运行的 agent runtime（no-sandbox 路径即可）。
- Hub agent roles 已配置（用于 retry 场景）。

## QA Evidence

每轮记录：

- archLoop commit SHA
- 测试 OS 与 Node 版本
- branch / worktree / lock 文件路径（仅作证据，不要求用户日常操作 lock 文件）
- 冲突或诊断的完整 CLI 输出
- `archloop project status` 与 `archloop tasks doctor` 相关片段
- pass/fail 与备注

建议验收表：

| Scenario | Result | Evidence | Notes |
| -------- | ------ | -------- | ----- |
| 01 one-shot duplicate start | | | |
| 02 handle-owned conflict | | | |
| 03 stale lease recovery | | | |
| 04 Hub retry preserved work | | | |
| 05 Hub retry active execution | | | |
| 06 claim/lease mismatch doctor | | | |
| 07 project status lease section | | | |

## Scenario 01: One-Shot Duplicate Start

Purpose: 验证两个独立 `run()` 不能同时使用同一 named branch worktree。

Steps:

```bash
cd "$TARGET_REPO"
# Terminal A — start a long-running interactive or run that holds the lease
npx archloop interactive . --branch foo --sandbox no-sandbox
# Terminal B — while A is still active:
npx archloop run . --branch foo --sandbox no-sandbox --prompt "second attempt"
```

Expected:

- Terminal B exits non-zero quickly.
- Error states the worktree/branch is already in use.
- Direct-caller diagnostic includes branch, process id, and acquisition time.
- Terminal B does not silently share the worktree with Terminal A.
- No wait/retry/backoff behavior.

Fail signals:

- Both sessions edit the same worktree concurrently.
- Second caller blocks indefinitely.
- Error message suggests manually deleting `.archloop/locks/` as the primary fix.

## Scenario 02: Handle-Owned Conflict

Purpose: 验证 `createWorktree()` handle 在 `close()` 之前持有 lease。

Steps:

```bash
cd "$TARGET_REPO"
node -e "
const { createWorktree, noSandbox } = require('@yibeibankaishui/archloop');
(async () => {
  const wt = await createWorktree({ repoDir: '.', branch: 'handle-lease-qa', sandbox: noSandbox() });
  console.log('worktree', wt.worktreePath);
  await new Promise((r) => setTimeout(r, 60000));
  await wt.close();
})().catch((e) => { console.error(e); process.exit(1); });
" &
sleep 2
npx archloop run . --branch handle-lease-qa --sandbox no-sandbox --prompt "race attempt"
```

Expected:

- Race attempt fails fast while the handle is open.
- After `wt.close()`, a new run on the same branch can acquire the lease.
- Dirty preserved worktree remains on disk after failed/aborted handle use.

Fail signals:

- Second caller succeeds while handle is still open.
- `close()` leaves an active lease behind when the process is still alive.

## Scenario 03: Stale Lease Recovery Without Deleting Work

Purpose: 验证 owner 进程死亡后 stale lease 可清除，且 worktree 内容保留。

Steps:

```bash
cd "$TARGET_REPO"
# Start a branch run, kill -9 the owning node process before it finishes cleanly
npx archloop run . --branch stale-lease-qa --sandbox no-sandbox --prompt "make a local change" || true
# Confirm worktree exists with uncommitted or committed work
ls .archloop/worktrees/
ls .archloop/locks/
# Retry on same branch
npx archloop run . --branch stale-lease-qa --sandbox no-sandbox --prompt "continue work"
```

Expected:

- Retry clears stale lease metadata as part of normal acquisition / Hub retry preparation.
- Preserved worktree directory and branch work remain available.
- Stale cleanup does not delete, reset, or clean the worktree tree.

Fail signals:

- Retry permanently blocks because of dead PID.
- Stale cleanup deletes preserved code.

## Scenario 04: Hub Retry From Preserved Worktree

Purpose: 验证 failed Hub task 在无 active lease 时从 preserved branch/worktree 继续。

Steps:

```bash
cd "$TARGET_REPO"
archloop tasks init
archloop tasks create "Lease retry QA" --description "Implement a small change and fail once."
# Move task to ready_for_agent through triage or manual Beads edit as needed
archloop run . --flow no-review
# Simulate or observe a failed task with branch work still present
archloop tasks show <TASK_SELECTOR>
ls .archloop/worktrees/
archloop tasks recover <TASK_SELECTOR>   # if claim/execution metadata is stale
archloop run . --flow no-review          # retry
```

Expected:

- Retry detects preserved worktree for the task branch.
- Implementer prompt includes retry context that preserved code may already exist.
- Retry does not discard partially completed code by default.
- New execution attempt starts only when no active lease remains.

Fail signals:

- Retry wipes the task worktree before implementation.
- Retry reports generic failure instead of active execution when a live lease exists.

## Scenario 05: Hub Retry Active Execution

Purpose: 验证 active lease 时 retry 报告 active execution，而非 retry failure。

Steps:

```bash
cd "$TARGET_REPO"
# With a Hub flow still implementing on task branch in Terminal A:
archloop run . --flow no-review
# Terminal B while implementation is active:
archloop run . --flow no-review
```

Expected:

- Second flow reports the task already has active execution.
- Diagnostic includes task id, flow/batch context when available, branch, process id, and acquisition time.
- Next action guides wait or stale recovery — not "retry failed".

Fail signals:

- Second flow starts a second implementer on the same worktree.
- Message blames retry mechanics instead of active execution.

## Scenario 06: Claim/Lease Mismatch Doctor

Purpose: 验证 doctor 交叉检查 Hub claim 与 worktree lease。

Prepare at least one mismatch shape manually or via controlled failure:

- active claim + missing lease
- failed task + stale claim + active lease
- failed task + stale claim + stale lease
- active lease + missing/stale Hub claim

Steps:

```bash
cd "$TARGET_REPO"
archloop tasks doctor
archloop project status
```

Expected:

- Doctor reports worktree lease diagnostics with stable reason codes.
- Each finding includes message + next action (wait, rerun, recover, repair).
- Doctor remains read-only.
- No instruction to use a standalone unlock command.

Fail signals:

- Mismatches are silently ignored.
- Doctor mutates lease files or worktrees.
- Diagnostics expose prompts, env vars, or full command lines from lease metadata.

## Scenario 07: Project Status Lease Section

Purpose: 验证 `archloop project status` 汇总 lease 诊断。

Steps:

```bash
cd "$TARGET_REPO"
archloop project status
```

Expected:

- Output includes a "Worktree lease diagnostics" section.
- Shows active/inconsistent leases or states none are present.
- Paths and next actions are concise; full logs remain in Hub run directories.

Fail signals:

- Active lease exists but status shows no diagnostics.
- Status tells users to manually edit lock files.

## Release Readiness Checklist

- [ ] Scenario 01–07 pass on a clean target repo.
- [ ] README worktree lease section matches observed CLI behavior.
- [ ] Bundled `skills/archloop-usage/SKILL.md` mentions retry, recovery, and doctor/status lease diagnostics.
- [ ] Documentation states leases are internal — no standalone lease management command.
- [ ] No old Sandcastle identity terms introduced in new docs.
