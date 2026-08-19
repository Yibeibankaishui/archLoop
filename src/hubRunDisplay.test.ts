import { describe, expect, it } from "vitest";

import type {
  HubBatchMergeCompletedEvent,
  HubRunEvent,
  HubTaskEvent,
} from "./hubExecution.js";
import {
  createHubRunDisplayState,
  formatPlainHubRunCancellation,
  formatPlainHubRunEvent,
  formatPlainHubRunOutcome,
  projectHubRunOutcome,
  projectHubRunStateOutcome,
  reduceHubRunDisplayState,
} from "./hubRunDisplay.js";
import type { RunHubFlowResult } from "./hubFlowExecution.js";

const makeRunResult = (
  overrides: Partial<RunHubFlowResult> = {},
): RunHubFlowResult => ({
  flowId: "no-review",
  runId: "run-1",
  batchId: "batch-1",
  runDir: "/tmp/runs/run-1",
  mode: "new_batch",
  completedBatchCount: 0,
  completedTaskCount: 0,
  stopReason: "no_ready_tasks",
  batchResults: [],
  selectedTaskIds: [],
  results: [],
  unfinishedBatchIds: [],
  projectDevelopmentContractPath: "/tmp/contract.md",
  projectDevelopmentContractCreatedGenericFallback: false,
  ...overrides,
});

describe("projectHubRunStateOutcome", () => {
  it("retains failed task diagnostics and skipped counts for interrupted runs", () => {
    const runStarted: HubRunEvent = {
      type: "run_started",
      runId: "run-interrupted",
      branch: "flow/with-review",
      startedAt: "2026-07-15T13:00:00.000Z",
      repoRoot: "/tmp/repo",
      hubProjectDir: "/tmp/hub",
      eventId: "run-interrupted:1",
      sequence: 1,
    };
    const reviewFailed: HubRunEvent = {
      type: "task_review_failed",
      runId: "run-interrupted",
      batchId: "batch-interrupted",
      taskId: "task-review-failed",
      branch: "archloop/task-review-failed",
      createdAt: "2026-07-15T13:00:01.000Z",
      status: "failed",
      diagnosticSummary: "review failed\nraw details",
      diagnostics: { path: "/tmp/review.log" },
      eventId: "run-interrupted:2",
      sequence: 2,
    };
    const claimSkipped: HubRunEvent = {
      type: "task_claim_skipped",
      runId: "run-interrupted",
      batchId: "batch-interrupted",
      taskId: "task-skipped",
      branch: "archloop/task-skipped",
      createdAt: "2026-07-15T13:00:02.000Z",
      status: "ready_for_agent",
      eventId: "run-interrupted:3",
      sequence: 3,
    };
    let state = createHubRunDisplayState({
      hubProjectName: "alpha",
      flowId: "with-review",
    });
    state = reduceHubRunDisplayState(state, runStarted);
    state = reduceHubRunDisplayState(state, reviewFailed);
    state = reduceHubRunDisplayState(state, claimSkipped);

    expect(
      projectHubRunStateOutcome(state, {
        outcome: "cancelled",
        summary: "Run cancelled",
        exitCode: 130,
      }),
    ).toMatchObject({
      counts: { failed: 1, skipped: 1 },
      taskDetails: [
        {
          taskId: "task-review-failed",
          stage: "Review failed",
          diagnostic: "review failed",
          logPath: "/tmp/review.log",
          recoveryCommand: "archloop tasks recover task-review-failed",
        },
      ],
    });
  });
});

describe("plain Hub run lifecycle output", () => {
  it("uses the reducer skipped count in cancellation outcomes", () => {
    const claimSkipped: HubRunEvent = {
      type: "task_claim_skipped",
      runId: "run-cancelled",
      batchId: "batch-cancelled",
      taskId: "task-skipped",
      branch: "archloop/task-skipped",
      createdAt: "2026-07-15T13:05:00.000Z",
      status: "ready_for_agent",
      eventId: "run-cancelled:1",
      sequence: 1,
    };
    const state = reduceHubRunDisplayState(
      createHubRunDisplayState({
        hubProjectName: "alpha",
        flowId: "with-review",
      }),
      claimSkipped,
    );

    expect(formatPlainHubRunCancellation(state)).toContain("skipped=1");
  });

  it("treats an initially empty ready queue as successful completion", () => {
    const result: RunHubFlowResult = {
      flowId: "no-review",
      runId: "run-empty",
      batchId: "batch-empty",
      runDir: "/tmp/runs/run-empty",
      mode: "no_ready",
      completedBatchCount: 0,
      completedTaskCount: 0,
      stopReason: "no_ready_tasks",
      batchResults: [],
      selectedTaskIds: [],
      results: [],
      unfinishedBatchIds: [],
      projectDevelopmentContractPath: "/tmp/contract.md",
      projectDevelopmentContractCreatedGenericFallback: false,
    };

    expect(projectHubRunOutcome(result)).toEqual({
      outcome: "completed",
      summary: "Nothing to run",
      counts: {
        completed: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
        readyToMerge: 0,
      },
      taskDetails: [],
      exitCode: 0,
    });
  });

  it("returns completed_with_pending_delivery for required publication timeout", () => {
    const result = makeRunResult({
      stopReason: "no_ready_tasks",
      completedBatchCount: 1,
      completedTaskCount: 0,
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: ["bd-pub"],
        selectionDiagnostics: [],
        batchStatus: "partial_failed",
        results: [
          {
            taskId: "bd-pub",
            title: "Publish me",
            branch: "archloop/bd-pub",
            outcome: "pending_delivery",
            hubStatus: "publishing",
            reason: "completed_with_pending_delivery",
            diagnosticSummary:
              "Required delivery timed out. The task is not semantically failed.",
          },
        ],
      },
    });

    expect(projectHubRunOutcome(result)).toMatchObject({
      outcome: "completed_with_pending_delivery",
      summary: "Run completed with pending required delivery",
      exitCode: 1,
      taskDetails: [
        expect.objectContaining({
          taskId: "bd-pub",
          stage: "Publishing",
        }),
      ],
    });
  });

  it("keeps host-contribution pending distinct from failed and shipped", () => {
    const result = makeRunResult({
      stopReason: "batch_pending",
      completedBatchCount: 0,
      completedTaskCount: 0,
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["bd-host"],
          completedTaskCount: 0,
          batchStatus: "pending",
        },
      ],
      results: [
        {
          taskId: "bd-host",
          title: "Host pending",
          branch: "archloop/bd-host",
          outcome: "reviewed",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
      ],
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: ["bd-host"],
        selectionDiagnostics: [],
        batchStatus: "pending",
        results: [
          {
            taskId: "bd-host",
            title: "Host pending",
            branch: "archloop/bd-host",
            outcome: "pending",
            hubStatus: "waiting_for_merge",
            reason: "host_contribution_conflict",
            diagnosticSummary:
              "Host contribution for main has a deterministic merge conflict. Resolve the conflict, then rerun the same flow. This is not a task failure and does not require a recovery command.",
          },
        ],
      },
    });

    const projection = projectHubRunOutcome(result);
    expect(projection).toMatchObject({
      outcome: "completed_with_pending_merge",
      summary: "Run completed with pending merge",
      exitCode: 1,
      counts: {
        completed: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
        readyToMerge: 1,
      },
    });
    expect(projection.taskDetails).toContainEqual(
      expect.objectContaining({
        taskId: "bd-host",
        stage: "Host contribution pending",
      }),
    );
    expect(JSON.stringify(projection)).not.toMatch(/tasks recover/);
    expect(formatPlainHubRunOutcome(result, projection).join("\n")).toContain(
      'outcome="completed_with_pending_merge"',
    );
  });

  it("treats the configured flow-batch limit as successful completion", () => {
    const result: RunHubFlowResult = {
      flowId: "with-review",
      runId: "run-bounded",
      batchId: "batch-2",
      runDir: "/tmp/runs/run-bounded",
      mode: "new_batch",
      completedBatchCount: 2,
      completedTaskCount: 3,
      stopReason: "max_batches_reached",
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["task-1", "task-2"],
          completedTaskCount: 2,
          batchStatus: "completed",
        },
        {
          batchId: "batch-2",
          selectedTaskIds: ["task-3"],
          completedTaskCount: 1,
          batchStatus: "completed",
        },
      ],
      selectedTaskIds: ["task-1", "task-2", "task-3"],
      results: [],
      unfinishedBatchIds: [],
      projectDevelopmentContractPath: "/tmp/contract.md",
      projectDevelopmentContractCreatedGenericFallback: false,
    };

    expect(projectHubRunOutcome(result)).toMatchObject({
      outcome: "completed",
      summary: "Reached configured flow-batch limit",
      counts: { completed: 3 },
      exitCode: 0,
    });
  });

  it("classifies partial progress when a later flow batch fails", () => {
    const result = makeRunResult({
      completedBatchCount: 1,
      completedTaskCount: 2,
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-complete",
          selectedTaskIds: ["task-complete"],
          completedTaskCount: 1,
          batchStatus: "completed",
        },
        {
          batchId: "batch-failed",
          selectedTaskIds: [
            "task-failed",
            "task-blocked",
            "task-skipped",
            "task-ready",
          ],
          completedTaskCount: 1,
          batchStatus: "failed",
        },
      ],
      selectedTaskIds: [
        "task-complete",
        "task-failed",
        "task-blocked",
        "task-skipped",
        "task-ready",
      ],
      results: [
        {
          taskId: "task-complete",
          title: "Completed task",
          branch: "archloop/task-complete",
          outcome: "implemented",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
        {
          taskId: "task-failed",
          title: "Failed task",
          branch: "archloop/task-failed",
          outcome: "agent_failed",
          hubStatus: "failed",
          failureReason: "agent_failed",
          failureStage: "implementation",
          diagnosticSummary: "agent exited non-zero\nfull stack trace",
          logPath: "/tmp/runs/run-1/logs/task-failed.log",
          commitCount: 0,
        },
        {
          taskId: "task-blocked",
          title: "Blocked task",
          branch: "archloop/task-blocked",
          outcome: "active_execution",
          hubStatus: "implementing",
          commitCount: 0,
        },
        {
          taskId: "task-skipped",
          title: "Skipped task",
          branch: "archloop/task-skipped",
          outcome: "claim_skipped",
          hubStatus: "ready_for_agent",
          commitCount: 0,
        },
        {
          taskId: "task-ready",
          title: "Ready to merge task",
          branch: "archloop/task-ready",
          outcome: "implemented",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
      ],
    });

    expect(projectHubRunOutcome(result)).toMatchObject({
      outcome: "completed_with_failures",
      counts: {
        completed: 1,
        failed: 1,
        blocked: 1,
        skipped: 1,
        readyToMerge: 1,
      },
      exitCode: 1,
    });
  });

  it("keeps an implementation failure visible with its log and recovery command", () => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["task-failed"],
          completedTaskCount: 0,
          batchStatus: "failed",
        },
      ],
      selectedTaskIds: ["task-failed"],
      results: [
        {
          taskId: "task-failed",
          title: "Implement feature",
          branch: "archloop/task-failed",
          outcome: "agent_failed",
          hubStatus: "failed",
          failureReason: "agent_failed",
          failureStage: "implementation",
          diagnosticSummary: "agent exited non-zero\nfull stack trace",
          logPath: "/tmp/runs/run-1/logs/task-failed.log",
          commitCount: 0,
        },
      ],
    });

    const projection = projectHubRunOutcome(result);
    expect(projection.taskDetails).toContainEqual({
      taskId: "task-failed",
      stage: "Implementation failed",
      diagnostic: "agent exited non-zero",
      logPath: "/tmp/runs/run-1/logs/task-failed.log",
      recoveryCommand: "archloop tasks recover task-failed",
    });
    expect(formatPlainHubRunOutcome(result, projection)).toEqual([
      'event=task_attention run_id="run-1" task_id="task-failed" stage="Implementation failed" diagnostic="agent exited non-zero" log="/tmp/runs/run-1/logs/task-failed.log" recovery="archloop tasks recover task-failed"',
      'event=run_completed outcome="failed" summary="Run failed" completed=0 failed=1 blocked=0 skipped=0 ready_to_merge=0 completed_batches=0 run_id="run-1" logs="/tmp/runs/run-1"',
    ]);
  });

  it("directs inconsistent task projection state to repair-state", () => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["task-drifted"],
          completedTaskCount: 0,
          batchStatus: "failed",
        },
      ],
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: [],
        batchStatus: "skipped",
        results: [],
        selectionDiagnostics: [
          {
            taskId: "task-drifted",
            title: "Drifted task",
            hubStatus: "implementing",
            decision: "blocked",
            reason: "state_inconsistent",
            branch: "archloop/task-drifted",
            message: "Claim metadata does not match the merge-ready event.",
            suggestedRecovery: "archloop tasks repair-state task-drifted",
          },
        ],
      },
    });

    expect(projectHubRunOutcome(result)).toMatchObject({
      outcome: "failed",
      counts: { blocked: 1 },
      taskDetails: [
        {
          taskId: "task-drifted",
          stage: "Merge blocked",
          diagnostic: "Claim metadata does not match the merge-ready event.",
          recoveryCommand: "archloop tasks repair-state task-drifted",
        },
      ],
      exitCode: 1,
    });
  });

  it("lists dirty-worktree overlap paths with commit, stash, or discard guidance", () => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["task-dirty"],
          completedTaskCount: 0,
          batchStatus: "failed",
        },
      ],
      results: [
        {
          taskId: "task-dirty",
          title: "Dirty overlap",
          branch: "archloop/task-dirty",
          outcome: "implemented",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
      ],
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: [],
        batchStatus: "skipped",
        results: [],
        selectionDiagnostics: [
          {
            taskId: "task-dirty",
            title: "Dirty overlap",
            hubStatus: "waiting_for_merge",
            decision: "blocked",
            reason: "dirty_worktree",
            branch: "archloop/task-dirty",
            blockingPaths: ["src/app.ts", "README.md"],
            message:
              "Dirty source files overlap this branch. commit, stash, or discard the listed files, then rerun the same flow.",
          },
        ],
      },
    });

    expect(projectHubRunOutcome(result).taskDetails).toContainEqual({
      taskId: "task-dirty",
      stage: "Merge blocked",
      diagnostic:
        "Dirty source files overlap this branch. commit, stash, or discard the listed files, then rerun the same flow.",
      blockingPaths: ["src/app.ts", "README.md"],
    });
    expect(projectHubRunOutcome(result).taskDetails).not.toContainEqual(
      expect.objectContaining({
        taskId: "task-dirty",
        stage: "Waiting for merge",
      }),
    );
  });

  it("tells waiting merge work to rerun the same flow without a resume flag", () => {
    const result = makeRunResult({
      flowId: "with-review",
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["task-ready", "task-failed"],
          completedTaskCount: 1,
          batchStatus: "failed",
        },
      ],
      selectedTaskIds: ["task-ready", "task-failed"],
      results: [
        {
          taskId: "task-ready",
          title: "Ready task",
          branch: "archloop/task-ready",
          outcome: "reviewed",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
        {
          taskId: "task-failed",
          title: "Failed task",
          branch: "archloop/task-failed",
          outcome: "agent_failed",
          hubStatus: "failed",
          failureReason: "agent_failed",
          failureStage: "review",
          commitCount: 0,
        },
      ],
    });

    const projection = projectHubRunOutcome(result);
    expect(projection.taskDetails).toContainEqual({
      taskId: "task-ready",
      stage: "Waiting for merge",
      diagnostic:
        "Work is ready to merge. Rerun the same flow to resume this batch.",
      recoveryCommand: "archloop run --flow with-review",
    });
    expect(JSON.stringify(projection)).not.toContain("--resume");
  });

  it("does not tell an already merged task to rerun the flow", () => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      results: [
        {
          taskId: "task-merged",
          title: "Merged task",
          branch: "archloop/task-merged",
          outcome: "implemented",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
      ],
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: ["task-merged"],
        batchStatus: "partial_failed",
        selectionDiagnostics: [],
        results: [
          {
            taskId: "task-merged",
            title: "Merged task",
            branch: "archloop/task-merged",
            outcome: "merged",
            hubStatus: "done",
          },
        ],
      },
    });

    expect(projectHubRunOutcome(result).taskDetails).not.toContainEqual(
      expect.objectContaining({
        taskId: "task-merged",
        stage: "Waiting for merge",
      }),
    );
  });

  it("does not give same-flow rerun guidance to a selection-skipped task", () => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      results: [
        {
          taskId: "task-skipped",
          title: "Skipped task",
          branch: "archloop/task-skipped",
          outcome: "implemented",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
      ],
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: [],
        batchStatus: "skipped",
        results: [],
        selectionDiagnostics: [
          {
            taskId: "task-skipped",
            title: "Skipped task",
            hubStatus: "waiting_for_merge",
            decision: "skipped",
            reason: "no_unmerged_work",
          },
        ],
      },
    });

    expect(projectHubRunOutcome(result).taskDetails).not.toContainEqual(
      expect.objectContaining({
        taskId: "task-skipped",
        stage: "Waiting for merge",
      }),
    );
  });

  it("surfaces repository integrity merge blockers with git diagnostics", () => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: [],
        batchStatus: "skipped",
        results: [],
        selectionDiagnostics: [
          {
            taskId: "task-corrupt",
            title: "Corrupt branch",
            hubStatus: "waiting_for_merge",
            decision: "blocked",
            reason: "repository_integrity",
            branch: "archloop/task-corrupt",
            message:
              "Repository integrity failure for branch archloop/task-corrupt: fatal: loose object abc is corrupt",
            suggestedRecovery:
              "Run `git fsck --full`, inspect `git reflog show <branch>`, or restore the branch from a trusted remote. Hub does not reset or rewrite refs automatically.",
            gitDiagnostic: {
              command: "git rev-parse --verify archloop/task-corrupt^{commit}",
              exitCode: 128,
              stderr: "fatal: loose object abc is corrupt",
              repositoryPath: "/repo",
              ref: "refs/heads/archloop/task-corrupt",
              object: "abc",
            },
          },
        ],
      },
    });

    expect(projectHubRunOutcome(result).taskDetails).toContainEqual(
      expect.objectContaining({
        taskId: "task-corrupt",
        stage: "Repository integrity",
        diagnostic: expect.stringContaining("Repository integrity failure"),
        recoveryCommand: expect.stringContaining("git fsck --full"),
        gitDiagnostic: expect.objectContaining({
          command: "git rev-parse --verify archloop/task-corrupt^{commit}",
          exitCode: 128,
        }),
      }),
    );
  });

  it("does not recommend task recovery for a malformed lease before claim", () => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      results: [
        {
          taskId: "task-lease",
          title: "Malformed lease",
          branch: "archloop/task-lease",
          outcome: "sandbox_failed",
          hubStatus: "ready_for_agent",
          diagnosticSummary: "Worktree lease metadata is invalid.",
          commitCount: 0,
        },
      ],
    });

    expect(projectHubRunOutcome(result).taskDetails).toContainEqual({
      taskId: "task-lease",
      stage: "Execution blocked",
      diagnostic: "Worktree lease metadata is invalid.",
      logPath: "/tmp/runs/run-1",
    });
  });

  it("maps user cancellation to the cancelled outcome and exit code 130", () => {
    const projection = projectHubRunOutcome(makeRunResult(), {
      cancelled: true,
    });

    expect(projection).toMatchObject({
      outcome: "cancelled",
      summary: "Run cancelled",
      exitCode: 130,
    });
  });

  it("exposes checkout-sync-pending blocking paths without failing a shipped task", () => {
    const result = makeRunResult({
      flowId: "with-review",
      stopReason: "no_ready_tasks",
      completedBatchCount: 1,
      completedTaskCount: 1,
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["bd-land"],
          completedTaskCount: 1,
          batchStatus: "completed",
        },
      ],
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: ["bd-land"],
        batchStatus: "done",
        results: [
          {
            taskId: "bd-land",
            title: "Landed task",
            branch: "archloop/bd-land",
            outcome: "merged",
            hubStatus: "done",
            candidateOid: "c".repeat(40),
            transactionId: "ltx-bd-land-abc123",
          },
        ],
        selectionDiagnostics: [],
      },
      checkoutSync: {
        items: [
          {
            version: 1,
            id: "cpo-1",
            transactionId: "ltx-bd-land-abc123",
            taskId: "bd-land",
            hostTargetBranch: "main",
            branchRef: "refs/heads/main",
            candidateOid: "c".repeat(40),
            expectedBranchOid: "b".repeat(40),
            publishTargetRef: "refs/archloop/publish/main",
            status: "pending",
            createdAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:00:00.000Z",
            pendingReason: "untracked_paths",
            blockingPaths: ["notes.txt"],
            message:
              "Checkout sync pending for bd-land (untracked_paths): host branch main was not updated. Blocking host paths: notes.txt. Landed candidate remains shipped.",
          },
        ],
        pendingCount: 1,
        succeededCount: 0,
        message:
          "Checkout sync pending for bd-land (untracked_paths): host branch main was not updated. Blocking host paths: notes.txt.",
        nextAction:
          "Commit or stash the listed host paths, then retry the same run. Hub will fast-forward the host branch when Git can prove the checkout safe.",
      },
    });

    const projection = projectHubRunOutcome(result);
    expect(projection.outcome).toBe("completed");
    expect(projection.taskDetails).toContainEqual({
      taskId: "bd-land",
      stage: "Checkout sync pending",
      diagnostic: result.checkoutSync!.items[0]!.message,
      blockingPaths: ["notes.txt"],
      recoveryCommand: "archloop run --flow with-review",
    });
    expect(projection.taskDetails).not.toContainEqual(
      expect.objectContaining({
        taskId: "bd-land",
        recoveryCommand: expect.stringMatching(/tasks recover/),
      }),
    );
    expect(
      formatPlainHubRunOutcome(result, projection).some((line) =>
        line.includes('blocking_paths=["notes.txt"]'),
      ),
    ).toBe(true);
  });

  it("keeps a verification failure visible instead of showing waiting merge", () => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["task-verify", "task-later"],
          completedTaskCount: 0,
          batchStatus: "failed",
        },
      ],
      selectedTaskIds: ["task-verify", "task-later"],
      results: [
        {
          taskId: "task-verify",
          title: "Verify task",
          branch: "archloop/task-verify",
          outcome: "implemented",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
        {
          taskId: "task-later",
          title: "Later task",
          branch: "archloop/task-later",
          outcome: "implemented",
          hubStatus: "waiting_for_merge",
          commitCount: 1,
        },
      ],
      mergeResult: {
        runId: "run-1",
        batchId: "batch-1",
        selectedTaskIds: ["task-verify", "task-later"],
        batchStatus: "partial_failed",
        selectionDiagnostics: [],
        results: [
          {
            taskId: "task-verify",
            title: "Verify task",
            branch: "archloop/task-verify",
            outcome: "verification_failed",
            hubStatus: "failed",
            failureReason: "verification_failure",
            diagnosticSummary: "npm test failed",
          },
          {
            taskId: "task-later",
            title: "Later task",
            branch: "archloop/task-later",
            outcome: "skipped",
            hubStatus: "waiting_for_merge",
          },
        ],
      },
    });

    const projection = projectHubRunOutcome(result);
    expect(projection.taskDetails).toContainEqual({
      taskId: "task-verify",
      stage: "Verification failed",
      diagnostic: "npm test failed",
      logPath: "/tmp/runs/run-1",
      recoveryCommand: "archloop tasks recover task-verify",
    });
    expect(projection.taskDetails).not.toContainEqual(
      expect.objectContaining({
        taskId: "task-verify",
        stage: "Waiting for merge",
      }),
    );
    expect(projection).toMatchObject({
      counts: { failed: 1, skipped: 0, readyToMerge: 1 },
      taskDetails: expect.arrayContaining([
        expect.objectContaining({
          taskId: "task-later",
          stage: "Waiting for merge",
        }),
      ]),
    });
  });

  it.each([
    {
      name: "sandbox implementation",
      outcome: "sandbox_failed" as const,
      failureStage: "implementation" as const,
      expectedStage: "Implementation failed",
      expectedLog: "/tmp/runs/run-1/logs/task-failed.log",
    },
    {
      name: "agent review",
      outcome: "agent_failed" as const,
      failureStage: "review" as const,
      expectedStage: "Review failed",
      expectedLog: "/tmp/runs/run-1/logs/task-failed-review.log",
    },
    {
      name: "sandbox review",
      outcome: "sandbox_failed" as const,
      failureStage: "review" as const,
      expectedStage: "Review failed",
      expectedLog: "/tmp/runs/run-1/logs/task-failed-review.log",
    },
  ])("shows recover guidance for $name failures", (testCase) => {
    const result = makeRunResult({
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["task-failed"],
          completedTaskCount: 0,
          batchStatus: "failed",
        },
      ],
      results: [
        {
          taskId: "task-failed",
          title: "Failed task",
          branch: "archloop/task-failed",
          outcome: testCase.outcome,
          hubStatus: "failed",
          failureReason: testCase.outcome,
          failureStage: testCase.failureStage,
          commitCount: 0,
        },
      ],
    });

    expect(projectHubRunOutcome(result).taskDetails).toContainEqual(
      expect.objectContaining({
        taskId: "task-failed",
        stage: testCase.expectedStage,
        logPath: testCase.expectedLog,
        recoveryCommand: "archloop tasks recover task-failed",
      }),
    );
  });

  it.each([
    {
      name: "completed",
      result: makeRunResult(),
      options: {},
      expected: "completed",
    },
    {
      name: "completed with failures",
      result: makeRunResult({
        stopReason: "batch_failed",
        batchResults: [
          {
            batchId: "batch-1",
            selectedTaskIds: ["task-ready"],
            completedTaskCount: 1,
            batchStatus: "failed",
          },
        ],
        results: [
          {
            taskId: "task-ready",
            title: "Ready task",
            branch: "archloop/task-ready",
            outcome: "implemented",
            hubStatus: "waiting_for_merge",
            commitCount: 1,
          },
        ],
      }),
      options: {},
      expected: "completed_with_failures",
    },
    {
      name: "failed",
      result: makeRunResult({ stopReason: "batch_failed" }),
      options: {},
      expected: "failed",
    },
    {
      name: "cancelled",
      result: makeRunResult(),
      options: { cancelled: true },
      expected: "cancelled",
    },
  ])("formats the $name run outcome", (testCase) => {
    const projection = projectHubRunOutcome(testCase.result, testCase.options);
    const finalLine = formatPlainHubRunOutcome(testCase.result, projection).at(
      -1,
    );

    expect(finalLine).toContain(`outcome=${JSON.stringify(testCase.expected)}`);
  });

  it("converges on the newest task stage when events arrive out of order", () => {
    const waitingForMerge: HubTaskEvent & {
      readonly eventId: string;
      readonly sequence: number;
    } = {
      type: "task_status_advanced",
      runId: "run-1",
      batchId: "batch-1",
      taskId: "task-1",
      branch: "archloop/task-1",
      createdAt: "2026-07-15T10:00:00.000Z",
      status: "waiting_for_merge",
      eventId: "run-1:9",
      sequence: 9,
    };
    const completed: typeof waitingForMerge = {
      ...waitingForMerge,
      status: "done",
      eventId: "run-1:10",
      sequence: 10,
    };
    const initialState = createHubRunDisplayState({
      hubProjectName: "Demo",
      flowId: "with-review",
    });

    const chronological = reduceHubRunDisplayState(
      reduceHubRunDisplayState(initialState, waitingForMerge),
      completed,
    );
    const outOfOrder = reduceHubRunDisplayState(
      reduceHubRunDisplayState(initialState, completed),
      waitingForMerge,
    );

    expect(outOfOrder).toEqual(chronological);
    expect(outOfOrder.tasks["task-1"]).toMatchObject({
      status: "done",
      stage: "Completed",
    });
    expect(outOfOrder.seenEventIds).toEqual(
      new Set([waitingForMerge.eventId, completed.eventId]),
    );
    expect(formatPlainHubRunEvent(waitingForMerge, outOfOrder)).toContain(
      'stage="Waiting for merge"',
    );
    expect(reduceHubRunDisplayState(outOfOrder, completed)).toBe(outOfOrder);
  });

  it("formats a completed batch in stable field order with escaped values", () => {
    const event: HubBatchMergeCompletedEvent & {
      readonly eventId: string;
      readonly sequence: number;
    } = {
      type: "batch_merge_completed",
      runId: 'run-"quoted"\nline',
      batchId: "batch\r1",
      createdAt: "2026-07-15T10:00:00.000Z",
      taskIds: ["task 1", "task\n2"],
      batchStatus: "done",
      eventId: "run-quoted:4",
      sequence: 4,
    };
    const initialState = createHubRunDisplayState({
      hubProjectName: "Escaped project",
      flowId: "with-review",
    });
    const state = reduceHubRunDisplayState(initialState, event);

    const line = formatPlainHubRunEvent(event, state);

    expect(line).toBe(
      'event=batch_merge_completed run_id="run-\\"quoted\\"\\nline" batch_id="batch\\r1" outcome="completed" completed_tasks=2 stage="Completed"',
    );
    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
  });

  it("formats landing reconciliation as pending work, not semantic failure", () => {
    const event: HubRunEvent = {
      type: "landing_reconciliation",
      eventId: "run-1:9",
      sequence: 9,
      runId: "run-1",
      createdAt: "2026-08-14T12:00:00.000Z",
      kind: "pending",
      pendingCount: 1,
      message:
        "Hub landing transaction ltx-1 is pending reconciliation at candidate_created. Automatic retry will resume from durable evidence. This is not a task failure and does not require a recovery command.",
    };
    const line = formatPlainHubRunEvent(
      event,
      createHubRunDisplayState({
        hubProjectName: "alpha",
        flowId: "no-review",
      }),
    );
    expect(line).toContain("event=landing_reconciliation");
    expect(line).toContain('kind="pending"');
    expect(line).not.toMatch(/tasks recover/);
  });

  it("formats landing rebuild, contention, and stale-owner events with target and fence OIDs", () => {
    const state = createHubRunDisplayState({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const base = {
      eventId: "run-1:20",
      sequence: 20,
      runId: "run-1",
      batchId: "batch-1",
      taskId: "bd-land",
      branch: "archloop/bd-land",
      createdAt: "2026-08-14T16:00:00.000Z",
      status: "merging",
      expectedTargetOid: "a".repeat(40),
      observedTargetOid: "b".repeat(40),
      expectedFenceOid: "c".repeat(40),
      observedFenceOid: "d".repeat(40),
    } as const;

    const rebuild = formatPlainHubRunEvent(
      { ...base, type: "target_landing_rebuild", reason: "target_drift" },
      state,
    );
    expect(rebuild).toContain("event=target_landing_rebuild");
    expect(rebuild).toContain("Rebuilding landing candidate");
    expect(rebuild).toContain(`expected_target_oid="${"a".repeat(40)}"`);
    expect(rebuild).toContain(`observed_target_oid="${"b".repeat(40)}"`);
    expect(rebuild).not.toMatch(/tasks recover/);

    const pending = formatPlainHubRunEvent(
      {
        ...base,
        type: "target_landing_pending",
        reason: "pending_contention",
      },
      state,
    );
    expect(pending).toContain("event=target_landing_pending");
    expect(pending).toContain("Landing pending");
    expect(pending).toContain(`expected_fence_oid="${"c".repeat(40)}"`);

    const stale = formatPlainHubRunEvent(
      {
        ...base,
        type: "target_landing_stale_owner_rejected",
        reason: "stale_owner_rejected",
      },
      state,
    );
    expect(stale).toContain("event=target_landing_stale_owner_rejected");
    expect(stale).toContain("Stale landing owner rejected");
    expect(stale).toContain(`observed_fence_oid="${"d".repeat(40)}"`);
  });

  it("formats checkout sync pending and success without recover or shipped failure", () => {
    const state = createHubRunDisplayState({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const base = {
      eventId: "run-1:30",
      sequence: 30,
      runId: "run-1",
      batchId: "batch-1",
      taskId: "bd-land",
      branch: "main",
      createdAt: "2026-08-14T18:00:00.000Z",
      status: "done",
      transactionId: "ltx-bd-land-abc123",
      candidateOid: "c".repeat(40),
    } as const;

    const pending = formatPlainHubRunEvent(
      {
        ...base,
        type: "checkout_sync_pending",
        reason: "unstaged_changes",
        message: "Checkout sync pending for bd-land (unstaged_changes).",
        blockingPaths: ["hello.txt"],
      },
      state,
    );
    expect(pending).toContain("event=checkout_sync_pending");
    expect(pending).toContain("Checkout sync pending");
    expect(pending).toContain('reason="unstaged_changes"');
    expect(pending).toContain(`transaction_id="${base.transactionId}"`);
    expect(pending).toContain(`candidate_oid="${base.candidateOid}"`);
    expect(pending).toContain('blocking_paths=["hello.txt"]');
    expect(pending).not.toMatch(/tasks recover/);

    const synced = formatPlainHubRunEvent(
      { ...base, type: "checkout_sync_succeeded" },
      state,
    );
    expect(synced).toContain("event=checkout_sync_succeeded");
    expect(synced).toContain("Checkout synced");
    expect(synced).not.toMatch(/tasks recover/);
  });

  it("formats code publication pending and success separately from task sync", () => {
    const state = createHubRunDisplayState({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const base = {
      eventId: "run-1:50",
      sequence: 50,
      runId: "run-1",
      batchId: "batch-1",
      taskId: "bd-land",
      branch: "origin/main",
      createdAt: "2026-08-14T19:00:00.000Z",
      status: "done",
      transactionId: "ltx-bd-land-abc123",
      candidateOid: "c".repeat(40),
      remoteRef: "refs/heads/main",
      expectedRemoteOid: "b".repeat(40),
    } as const;

    const pending = formatPlainHubRunEvent(
      {
        ...base,
        type: "target_publish_pending",
        reason: "network_error",
        message: "Code publication pending for bd-land (network_error).",
      },
      state,
    );
    expect(pending).toContain("event=target_publish_pending");
    expect(pending).toContain("Code publication pending");
    expect(pending).toContain('reason="network_error"');
    expect(pending).toContain(`transaction_id="${base.transactionId}"`);
    expect(pending).toContain(`candidate_oid="${base.candidateOid}"`);
    expect(pending).toContain(`remote_ref="${base.remoteRef}"`);
    expect(pending).toContain(`expected_remote_oid="${base.expectedRemoteOid}"`);
    expect(pending).not.toMatch(/tasks recover/);

    const published = formatPlainHubRunEvent(
      { ...base, type: "target_publish_succeeded" },
      state,
    );
    expect(published).toContain("event=target_publish_succeeded");
    expect(published).toContain("Code published");
    expect(published).not.toMatch(/tasks recover/);
  });
});
