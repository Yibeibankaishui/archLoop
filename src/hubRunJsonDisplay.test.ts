import { describe, expect, it } from "vitest";

import type { HubRunEvent } from "./hubExecution.js";
import { createHubRunJsonRenderer } from "./hubRunJsonDisplay.js";
import {
  createHubRunDisplayState,
  projectHubRunOutcome,
  reduceHubRunDisplayState,
} from "./hubRunDisplay.js";
import type { RunHubFlowResult } from "./hubFlowExecution.js";

const parseRecord = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

const makeRunResult = (
  overrides: Partial<RunHubFlowResult>,
): RunHubFlowResult => ({
  flowId: "no-review",
  runId: "run-matrix",
  batchId: "batch-matrix",
  runDir: "/tmp/runs/run-matrix",
  mode: "new_batch",
  completedBatchCount: 0,
  completedTaskCount: 0,
  stopReason: "no_ready_tasks",
  batchResults: [],
  selectedTaskIds: [],
  results: [],
  unfinishedBatchIds: [],
  projectDevelopmentContractPath: "/tmp/contract.json",
  projectDevelopmentContractCreatedGenericFallback: false,
  ...overrides,
});

describe("JSONL Hub run lifecycle output", () => {
  it("emits a versioned and ordered run-start record", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: 'project "alpha"\nnext',
      flowId: "no-review",
    });
    const event: HubRunEvent = {
      type: "run_started",
      eventId: "run-1:1",
      sequence: 1,
      runId: "run-1",
      branch: "feature/json output",
      startedAt: "2026-07-15T10:00:00.000Z",
      repoRoot: "/tmp/repo with spaces",
      hubProjectDir: "/tmp/hub\nproject",
    };

    const line = renderer.event(event);

    expect(line).toBeDefined();
    expect(line?.split("\n")).toHaveLength(1);
    expect(parseRecord(line!)).toEqual({
      schemaVersion: 1,
      eventId: "run-1:output:1",
      sequence: 1,
      timestamp: "2026-07-15T10:00:00.000Z",
      type: "run_started",
      runId: "run-1",
      flowId: "no-review",
      sourceEventId: "run-1:1",
      sourceSequence: 1,
      hubProject: 'project "alpha"\nnext',
      data: {
        branch: "feature/json output",
        repoRoot: "/tmp/repo with spaces",
        hubProjectDir: "/tmp/hub\nproject",
      },
    });
  });

  it("preserves task lifecycle identity, stage, and diagnostics", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "with-review",
    });
    const event: HubRunEvent = {
      type: "task_implementation_failed",
      eventId: "run-2:7",
      sequence: 7,
      runId: "run-2",
      batchId: "batch-2",
      taskId: "task-2",
      branch: "archloop/task-2",
      createdAt: "2026-07-15T10:01:00.000Z",
      status: "failed",
      failureReason: "agent_failed",
      diagnosticSummary: 'Agent said "no"\nsee full log',
      diagnostics: { exitCode: 2, path: "/tmp/a b/task.log" },
    };

    const record = parseRecord(renderer.event(event)!);

    expect(record).toMatchObject({
      type: "task_implementation_failed",
      runId: "run-2",
      flowId: "with-review",
      batchId: "batch-2",
      taskId: "task-2",
      stage: "Implementation failed",
      status: "failed",
      data: {
        branch: "archloop/task-2",
        failureReason: "agent_failed",
        diagnosticSummary: 'Agent said "no"\nsee full log',
        diagnostics: { exitCode: 2, path: "/tmp/a b/task.log" },
      },
    });
  });

  it("carries landing transaction and commit identities in JSON output", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const event: HubRunEvent = {
      type: "target_landing_succeeded",
      eventId: "run-land:12",
      sequence: 12,
      runId: "run-land",
      batchId: "batch-land",
      taskId: "bd-land",
      branch: "archloop/bd-land",
      createdAt: "2026-08-13T10:00:00.000Z",
      status: "merging",
      transactionId: "ltx-bd-land-abc123",
      sourceOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      candidateOid: "cccccccccccccccccccccccccccccccccccccccc",
      publishTargetOid: "cccccccccccccccccccccccccccccccccccccccc",
      verifierFingerprint: "deadbeef",
    };

    expect(parseRecord(renderer.event(event)!)).toMatchObject({
      type: "target_landing_succeeded",
      taskId: "bd-land",
      stage: "Target landing succeeded",
      status: "merging",
      data: {
        transactionId: "ltx-bd-land-abc123",
        candidateOid: "cccccccccccccccccccccccccccccccccccccccc",
        publishTargetOid: "cccccccccccccccccccccccccccccccccccccccc",
        verifierFingerprint: "deadbeef",
      },
    });
  });

  it("emits distinct checkout sync pending and success JSON events", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const pending: HubRunEvent = {
      type: "checkout_sync_pending",
      eventId: "run-land:40",
      sequence: 40,
      runId: "run-land",
      batchId: "batch-land",
      taskId: "bd-land",
      branch: "main",
      createdAt: "2026-08-14T18:00:00.000Z",
      status: "done",
      transactionId: "ltx-bd-land-abc123",
      candidateOid: "cccccccccccccccccccccccccccccccccccccccc",
      reason: "unstaged_changes",
      message: "Checkout sync pending for bd-land (unstaged_changes).",
      blockingPaths: ["hello.txt"],
    };
    expect(parseRecord(renderer.event(pending)!)).toMatchObject({
      type: "checkout_sync_pending",
      taskId: "bd-land",
      stage: "Checkout sync pending",
      status: "done",
      data: {
        transactionId: "ltx-bd-land-abc123",
        candidateOid: "cccccccccccccccccccccccccccccccccccccccc",
        reason: "unstaged_changes",
        blockingPaths: ["hello.txt"],
      },
    });

    const succeeded: HubRunEvent = {
      ...pending,
      type: "checkout_sync_succeeded",
      eventId: "run-land:41",
      sequence: 41,
      reason: undefined,
      message: "Checkout synced main to cccccccccccccccccccccccccccccccccccccccc.",
    };
    expect(parseRecord(renderer.event(succeeded)!)).toMatchObject({
      type: "checkout_sync_succeeded",
      stage: "Checkout sync succeeded",
    });
  });

  it("emits distinct code publication pending and success JSON events", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const pending: HubRunEvent = {
      type: "target_publish_pending",
      eventId: "run-land:50",
      sequence: 50,
      runId: "run-land",
      batchId: "batch-land",
      taskId: "bd-land",
      branch: "origin/main",
      createdAt: "2026-08-14T18:30:00.000Z",
      status: "done",
      transactionId: "ltx-bd-land-abc123",
      candidateOid: "cccccccccccccccccccccccccccccccccccccccc",
      remoteRef: "refs/heads/main",
      expectedRemoteOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reason: "network_error",
      message: "Code publication pending for bd-land (network_error).",
    };
    expect(parseRecord(renderer.event(pending)!)).toMatchObject({
      type: "target_publish_pending",
      taskId: "bd-land",
      stage: "Target publish pending",
      status: "done",
      data: {
        transactionId: "ltx-bd-land-abc123",
        candidateOid: "cccccccccccccccccccccccccccccccccccccccc",
        remoteRef: "refs/heads/main",
        expectedRemoteOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        reason: "network_error",
      },
    });

    const succeeded: HubRunEvent = {
      ...pending,
      type: "target_publish_succeeded",
      eventId: "run-land:51",
      sequence: 51,
      reason: undefined,
      message: "Code published origin/main to cccccccccccccccccccccccccccccccccccccccc.",
    };
    expect(parseRecord(renderer.event(succeeded)!)).toMatchObject({
      type: "target_publish_succeeded",
      stage: "Target publish succeeded",
    });
  });

  it("carries expected and observed target/fence OIDs for rebuild and contention", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const event: HubRunEvent = {
      type: "target_landing_rebuild",
      eventId: "run-land:13",
      sequence: 13,
      runId: "run-land",
      batchId: "batch-land",
      taskId: "bd-land",
      branch: "archloop/bd-land",
      createdAt: "2026-08-14T16:00:00.000Z",
      status: "merging",
      reason: "target_drift",
      expectedTargetOid: "a".repeat(40),
      observedTargetOid: "b".repeat(40),
      expectedFenceOid: "c".repeat(40),
      observedFenceOid: "d".repeat(40),
    };

    expect(parseRecord(renderer.event(event)!)).toMatchObject({
      type: "target_landing_rebuild",
      stage: "Target landing rebuild",
      data: {
        reason: "target_drift",
        expectedTargetOid: "a".repeat(40),
        observedTargetOid: "b".repeat(40),
        expectedFenceOid: "c".repeat(40),
        observedFenceOid: "d".repeat(40),
      },
    });
  });

  it("suppresses duplicate and stale source events before assigning output order", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "with-review",
    });
    const latest: HubRunEvent = {
      type: "task_status_advanced",
      eventId: "run-ordered:10",
      sequence: 10,
      runId: "run-ordered",
      batchId: "batch-ordered",
      taskId: "task-ordered",
      branch: "archloop/task-ordered",
      createdAt: "2026-07-15T10:01:00.000Z",
      status: "done",
    };
    const stale: HubRunEvent = {
      ...latest,
      eventId: "run-ordered:9",
      sequence: 9,
      status: "waiting_for_merge",
    };

    expect(parseRecord(renderer.event(latest)!)).toMatchObject({
      eventId: "run-ordered:output:1",
      sequence: 1,
      sourceEventId: "run-ordered:10",
      sourceSequence: 10,
      status: "done",
    });
    expect(renderer.event(latest)).toBeUndefined();
    expect(renderer.event(stale)).toBeUndefined();
  });

  it("emits actionable task failures before one structured final outcome", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const completedEvent: HubRunEvent = {
      type: "run_completed",
      eventId: "run-3:8",
      sequence: 8,
      runId: "run-3",
      flowId: "no-review",
      createdAt: "2026-07-15T10:02:00.000Z",
      completedBatchCount: 0,
      completedTaskCount: 0,
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-3",
          selectedTaskIds: ["task-3"],
          completedTaskCount: 0,
          batchStatus: "failed",
        },
      ],
    };
    const result: RunHubFlowResult = {
      flowId: "no-review",
      runId: "run-3",
      batchId: "batch-3",
      runDir: "/tmp/run with spaces/run-3",
      mode: "new_batch",
      completedBatchCount: 0,
      completedTaskCount: 0,
      stopReason: "batch_failed",
      batchResults: completedEvent.batchResults,
      selectedTaskIds: ["task-3"],
      results: [
        {
          taskId: "task-3",
          title: "Fails safely",
          branch: "archloop/task-3",
          outcome: "agent_failed",
          hubStatus: "failed",
          failureReason: "agent_failed",
          failureStage: "implementation",
          diagnosticSummary: 'bad "quote"\nfull details',
          logPath: "/tmp/logs/task 3.log",
          commitCount: 0,
        },
      ],
      unfinishedBatchIds: ["batch-3"],
      projectDevelopmentContractPath: "/tmp/contract.json",
      projectDevelopmentContractCreatedGenericFallback: false,
    };

    expect(renderer.event(completedEvent)).toBeUndefined();
    const lines = renderer.outcome(result, projectHubRunOutcome(result));
    const records = lines.map(parseRecord);

    expect(lines.every((line) => line.split("\n").length === 1)).toBe(true);
    expect(records).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        eventId: "run-3:output:1",
        sequence: 1,
        timestamp: "2026-07-15T10:02:00.000Z",
        type: "task_attention",
        runId: "run-3",
        flowId: "no-review",
        taskId: "task-3",
        stage: "Implementation failed",
        diagnostic: 'bad "quote"',
        logPath: "/tmp/logs/task 3.log",
        recoveryCommand: "archloop tasks recover task-3",
      }),
      expect.objectContaining({
        schemaVersion: 1,
        eventId: "run-3:output:2",
        sequence: 2,
        timestamp: "2026-07-15T10:02:00.000Z",
        type: "run_completed",
        runId: "run-3",
        flowId: "no-review",
        batchId: "batch-3",
        sourceEventId: "run-3:8",
        sourceSequence: 8,
        outcome: "failed",
        summary: "Run failed",
        counts: {
          completed: 0,
          failed: 1,
          blocked: 0,
          skipped: 0,
          readyToMerge: 0,
        },
        completedBatchCount: 0,
        completedTaskCount: 0,
        stopReason: "batch_failed",
        exitCode: 1,
        logs: "/tmp/run with spaces/run-3",
      }),
    ]);
  });

  it("emits cancellation as a final outcome with exit code 130", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "with-review",
      now: () => new Date("2026-07-15T10:05:00.000Z"),
    });
    const runStarted: HubRunEvent = {
      type: "run_started",
      eventId: "run-cancelled:1",
      sequence: 1,
      runId: "run-cancelled",
      branch: "feature/cancel",
      startedAt: "2026-07-15T10:03:00.000Z",
      repoRoot: "/tmp/repo",
      hubProjectDir: "/tmp/hub",
    };
    const taskReady: HubRunEvent = {
      type: "task_status_advanced",
      eventId: "run-cancelled:2",
      sequence: 2,
      runId: "run-cancelled",
      batchId: "batch-cancelled",
      taskId: "task-ready",
      branch: "archloop/task-ready",
      createdAt: "2026-07-15T10:04:00.000Z",
      status: "waiting_for_merge",
    };
    let state = createHubRunDisplayState({
      hubProjectName: "alpha",
      flowId: "with-review",
    });
    state = reduceHubRunDisplayState(state, runStarted);
    state = reduceHubRunDisplayState(state, taskReady);
    renderer.event(runStarted);
    renderer.event(taskReady);

    const lines = renderer.cancellation(state);
    const record = parseRecord(lines.at(-1)!);

    expect(lines).toHaveLength(1);
    expect(record).toMatchObject({
      schemaVersion: 1,
      eventId: "run-cancelled:output:3",
      sequence: 3,
      timestamp: "2026-07-15T10:05:00.000Z",
      type: "run_completed",
      runId: "run-cancelled",
      flowId: "with-review",
      outcome: "cancelled",
      summary: "Run cancelled",
      cancelled: true,
      counts: {
        completed: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
        readyToMerge: 1,
      },
      completedBatchCount: 0,
      completedTaskCount: 0,
      stopReason: "cancelled",
      exitCode: 130,
      logs: "/tmp/hub/runs/run-cancelled",
    });
  });

  it("preserves SIGTERM exit code in cancellation JSONL", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
    });
    const state = createHubRunDisplayState({
      hubProjectName: "alpha",
      flowId: "no-review",
    });

    const record = parseRecord(renderer.cancellation(state, 143).at(-1)!);

    expect(record).toMatchObject({
      type: "run_completed",
      outcome: "cancelled",
      exitCode: 143,
    });
  });

  it("uses the reducer skipped count in cancellation records", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "with-review",
    });
    const runStarted: HubRunEvent = {
      type: "run_started",
      eventId: "run-cancel-skipped:1",
      sequence: 1,
      runId: "run-cancel-skipped",
      branch: "feature/cancel",
      startedAt: "2026-07-15T10:05:00.000Z",
      repoRoot: "/tmp/repo",
      hubProjectDir: "/tmp/hub",
    };
    const claimSkipped: HubRunEvent = {
      type: "task_claim_skipped",
      eventId: "run-cancel-skipped:2",
      sequence: 2,
      runId: "run-cancel-skipped",
      batchId: "batch-cancel-skipped",
      taskId: "task-skipped",
      branch: "archloop/task-skipped",
      createdAt: "2026-07-15T10:05:01.000Z",
      status: "ready_for_agent",
    };
    let state = createHubRunDisplayState({
      hubProjectName: "alpha",
      flowId: "with-review",
    });
    state = reduceHubRunDisplayState(state, runStarted);
    state = reduceHubRunDisplayState(state, claimSkipped);
    renderer.event(runStarted);
    renderer.event(claimSkipped);

    const record = parseRecord(renderer.cancellation(state).at(-1)!);

    expect(record.counts).toMatchObject({ skipped: 1 });
  });

  it("retains actionable failed-task details when cancellation follows a failure", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "with-review",
      now: () => new Date("2026-07-15T10:09:00.000Z"),
    });
    const runStarted: HubRunEvent = {
      type: "run_started",
      eventId: "run-cancel-with-failure:1",
      sequence: 1,
      runId: "run-cancel-with-failure",
      branch: "feature/cancel",
      startedAt: "2026-07-15T10:07:00.000Z",
      repoRoot: "/tmp/repo",
      hubProjectDir: "/tmp/hub",
    };
    const failed: HubRunEvent = {
      type: "task_review_failed",
      eventId: "run-cancel-with-failure:2",
      sequence: 2,
      runId: "run-cancel-with-failure",
      batchId: "batch-cancel-with-failure",
      taskId: "task-failed-before-cancel",
      branch: "archloop/task-failed-before-cancel",
      createdAt: "2026-07-15T10:08:00.000Z",
      status: "failed",
      diagnosticSummary: "review failed\nraw details",
      diagnostics: { path: "/tmp/review failure.log" },
    };
    let state = createHubRunDisplayState({
      hubProjectName: "alpha",
      flowId: "with-review",
    });
    state = reduceHubRunDisplayState(state, runStarted);
    state = reduceHubRunDisplayState(state, failed);
    renderer.event(runStarted);
    renderer.event(failed);

    const records = renderer.cancellation(state).map(parseRecord);

    expect(records).toEqual([
      expect.objectContaining({
        type: "task_attention",
        taskId: "task-failed-before-cancel",
        stage: "Review failed",
        diagnostic: "review failed",
        logPath: "/tmp/review failure.log",
        recoveryCommand: "archloop tasks recover task-failed-before-cancel",
      }),
      expect.objectContaining({
        type: "run_completed",
        outcome: "cancelled",
        stopReason: "cancelled",
        exitCode: 130,
      }),
    ]);
  });

  it.each([
    {
      name: "maximum-batch completion",
      result: makeRunResult({
        completedBatchCount: 1,
        completedTaskCount: 1,
        stopReason: "max_batches_reached",
        batchResults: [
          {
            batchId: "batch-complete",
            selectedTaskIds: ["task-complete"],
            completedTaskCount: 1,
            batchStatus: "completed",
          },
        ],
        selectedTaskIds: ["task-complete"],
      }),
      outcome: "completed",
      exitCode: 0,
      counts: { completed: 1, failed: 0, blocked: 0 },
    },
    {
      name: "partial failure",
      result: makeRunResult({
        completedBatchCount: 1,
        completedTaskCount: 1,
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
            selectedTaskIds: ["task-failed"],
            completedTaskCount: 0,
            batchStatus: "failed",
          },
        ],
        selectedTaskIds: ["task-complete", "task-failed"],
        results: [
          {
            taskId: "task-failed",
            title: "Failed",
            branch: "archloop/task-failed",
            outcome: "agent_failed",
            hubStatus: "failed",
            failureStage: "implementation",
            diagnosticSummary: "failed",
            commitCount: 0,
          },
        ],
      }),
      outcome: "completed_with_failures",
      exitCode: 1,
      counts: { completed: 1, failed: 1, blocked: 0 },
    },
    {
      name: "blocking failure",
      result: makeRunResult({
        stopReason: "batch_failed",
        batchResults: [
          {
            batchId: "batch-blocked",
            selectedTaskIds: ["task-blocked"],
            completedTaskCount: 0,
            batchStatus: "failed",
          },
        ],
        selectedTaskIds: ["task-blocked"],
        results: [
          {
            taskId: "task-blocked",
            title: "Blocked",
            branch: "archloop/task-blocked",
            outcome: "active_execution",
            hubStatus: "implementing",
            commitCount: 0,
          },
        ],
      }),
      outcome: "failed",
      exitCode: 1,
      counts: { completed: 0, failed: 0, blocked: 1 },
    },
  ])("keeps $name consistent with the shared outcome contract", (testCase) => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: testCase.result.flowId,
    });
    renderer.event({
      type: "run_completed",
      eventId: `${testCase.result.runId}:20`,
      sequence: 20,
      runId: testCase.result.runId,
      flowId: testCase.result.flowId,
      createdAt: "2026-07-15T10:06:00.000Z",
      completedBatchCount: testCase.result.completedBatchCount,
      completedTaskCount: testCase.result.completedTaskCount,
      stopReason: testCase.result.stopReason,
      batchResults: testCase.result.batchResults,
    });

    const projection = projectHubRunOutcome(testCase.result);
    const record = parseRecord(
      renderer.outcome(testCase.result, projection).at(-1)!,
    );

    expect(record).toMatchObject({
      outcome: testCase.outcome,
      exitCode: testCase.exitCode,
      counts: testCase.counts,
    });
  });

  it("distinguishes deferred migration from split-brain in the run outcome", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    const deferred = parseRecord(
      renderer
        .outcome(
          makeRunResult({
            taskStoreMigration: {
              kind: "deferred",
              reason: "active_writer",
              phase: "legacy_active",
              beadsDir: "/tmp/repo/.beads",
              pendingUntil: "2026-08-13T12:00:02.000Z",
              journalPath: "/tmp/hub/journal.jsonl",
            },
          }),
          projectHubRunOutcome(makeRunResult({})),
        )
        .at(-1)!,
    );
    expect(deferred.taskStoreMigration).toMatchObject({
      kind: "deferred",
      reason: "active_writer",
      pendingUntil: "2026-08-13T12:00:02.000Z",
    });

    const splitBrain = parseRecord(
      renderer
        .outcome(
          makeRunResult({
            taskStoreMigration: {
              kind: "split_brain",
              beadsDir: "/tmp/hub/.beads",
              legacyBeadsDir: "/tmp/repo/.beads",
              managedBeadsDir: "/tmp/hub/.beads",
              integrityError: "Hub Beads task-store split brain detected.",
              journalPath: "/tmp/hub/journal.jsonl",
            },
          }),
          projectHubRunOutcome(makeRunResult({})),
        )
        .at(-1)!,
    );
    expect(splitBrain.taskStoreMigration).toMatchObject({
      kind: "split_brain",
      reason: "task_store_split_brain",
    });
  });

  it("distinguishes pending landing reconciliation from an integrity incident", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });

    const pending = parseRecord(
      renderer
        .outcome(
          makeRunResult({
            landingReconciliation: {
              kind: "pending",
              transactions: [],
              pendingCount: 1,
              reconstructedCount: 0,
              message:
                "Hub landing transaction ltx-1 is pending reconciliation at candidate_created. Automatic retry will resume from durable evidence. This is not a task failure and does not require a recovery command.",
              nextAction:
                "Wait for the automatic retry; Hub will resume from durable landing evidence.",
            },
          }),
          projectHubRunOutcome(makeRunResult({})),
        )
        .at(-1)!,
    );
    expect(pending.landingReconciliation).toMatchObject({
      kind: "pending",
      pendingCount: 1,
    });
    expect(JSON.stringify(pending)).not.toMatch(/tasks recover/);

    const checkoutPending = parseRecord(
      renderer
        .outcome(
          makeRunResult({
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
                  createdAt: "2026-08-14T18:00:00.000Z",
                  updatedAt: "2026-08-14T18:00:00.000Z",
                  pendingReason: "unstaged_changes",
                  blockingPaths: ["hello.txt"],
                  message:
                    "Checkout sync pending for bd-land (unstaged_changes): host branch main was not updated. Blocking host paths: hello.txt. Landed candidate cccccccccccccccccccccccccccccccccccccccc remains on the Hub publish target and the task can stay shipped. Next steps: commit or stash the listed paths, then retry the run. This is not a task failure and does not require a recovery command.",
                },
              ],
              pendingCount: 1,
              succeededCount: 0,
              message:
                "Checkout sync pending for bd-land (unstaged_changes): host branch main was not updated. Blocking host paths: hello.txt. Landed candidate cccccccccccccccccccccccccccccccccccccccc remains on the Hub publish target and the task can stay shipped. Next steps: commit or stash the listed paths, then retry the run. This is not a task failure and does not require a recovery command.",
              nextAction:
                "Commit or stash the listed host paths, then retry the same run. Hub will fast-forward the host branch when Git can prove the checkout safe.",
            },
          }),
          projectHubRunOutcome(makeRunResult({})),
        )
        .at(-1)!,
    );
    expect(checkoutPending.checkoutSync).toMatchObject({
      pendingCount: 1,
      items: [
        {
          taskId: "bd-land",
          pendingReason: "unstaged_changes",
          blockingPaths: ["hello.txt"],
        },
      ],
    });
    expect(JSON.stringify(checkoutPending)).not.toMatch(/tasks recover/);

    const incidentResult = makeRunResult({
      stopReason: "no_ready_tasks",
      completedBatchCount: 1,
      completedTaskCount: 2,
      batchResults: [
        {
          batchId: "batch-1",
          selectedTaskIds: ["t1", "t2"],
          completedTaskCount: 2,
          batchStatus: "completed",
        },
      ],
      landingReconciliation: {
        kind: "integrity_incident",
        transactions: [
          {
            transactionId: "ltx-1",
            taskId: "hub-host-contribution",
            taskBacked: false,
            verificationReusable: false,
            landed: false,
            closed: false,
            cleaned: false,
            worktreePresent: false,
            integrityIncident:
              "landing_integrity_incident: journal candidate does not match ref",
            pending: false,
            nextAction:
              "Inspect the candidate ref, landing receipt, verification artifact, and journal. Do not land or close the task again automatically.",
          },
        ],
        pendingCount: 0,
        reconstructedCount: 0,
        integrityIncident:
          "landing_integrity_incident: journal candidate does not match ref",
        message:
          "Hub landing integrity incident for ltx-1: landing_integrity_incident: journal candidate does not match ref This is not a task failure and does not require a recovery command.",
        nextAction:
          "Inspect the candidate ref, landing receipt, verification artifact, and journal. Do not land or close the task again automatically.",
      },
    });
    const incidentLines = renderer.outcome(
      incidentResult,
      projectHubRunOutcome(incidentResult),
    );
    const incidentWarning = parseRecord(incidentLines[0]!);
    expect(incidentWarning).toMatchObject({
      type: "landing_reconciliation_incident",
      transactionId: "ltx-1",
      affectsCurrentBatch: false,
      nextAction: expect.stringContaining("Inspect the candidate ref"),
    });
    const incident = parseRecord(incidentLines.at(-1)!);
    expect(incident).toMatchObject({
      outcome: "completed",
      exitCode: 0,
      completedBatchCount: 1,
      stopReason: "no_ready_tasks",
    });
    expect(incident.landingReconciliation).toMatchObject({
      kind: "integrity_incident",
      integrityIncident: expect.stringContaining("landing_integrity_incident"),
      nextAction: expect.stringContaining("Inspect the candidate ref"),
      affectsCurrentBatch: false,
    });
    expect(JSON.stringify(incident)).not.toMatch(/tasks recover/);
    expect(JSON.stringify(incident)).not.toMatch(/batch_failed|completed_with_failures/);
  });

  it("explains accepted and rejected legacy landing history in JSON", () => {
    const renderer = createHubRunJsonRenderer({
      hubProjectName: "alpha",
      flowId: "no-review",
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    const record = parseRecord(
      renderer
        .outcome(
          makeRunResult({
            landingReconciliation: {
              kind: "integrity_incident",
              transactions: [],
              pendingCount: 0,
              reconstructedCount: 0,
              integrityIncident: "legacy_landing_integrity: event_without_ancestry",
              message:
                "Rejected historical evidence for bd-1: a historical merge_succeeded event is not landing proof. The task is not landed, closed, or shipped. This is not a task failure and does not require a recovery command.",
              nextAction:
                "Inspect the task branch, configured target, and historical events. Do not close or reimplement the task automatically.",
              legacyHistory: [
                {
                  taskId: "bd-closed",
                  decision: "grandfathered_closed",
                  accepted: true,
                  hadMergeSucceededEvent: true,
                  message:
                    "Accepted historical evidence for bd-closed: already closed Beads status. Grandfathered as completed; no landing receipt required.",
                  nextAction:
                    "Inspect the task branch, configured target, and historical events. Do not close or reimplement the task automatically.",
                },
                {
                  taskId: "bd-1",
                  decision: "event_without_ancestry",
                  accepted: false,
                  hadMergeSucceededEvent: true,
                  message:
                    "Rejected historical evidence for bd-1: a historical merge_succeeded event is not landing proof.",
                  nextAction:
                    "Inspect the task branch, configured target, and historical events. Do not close or reimplement the task automatically.",
                  integrityIncident:
                    "legacy_landing_integrity: event_without_ancestry",
                },
              ],
            },
          }),
          projectHubRunOutcome(makeRunResult({})),
        )
        .at(-1)!,
    );
    expect(record.landingReconciliation).toMatchObject({
      kind: "integrity_incident",
      integrityIncident: "legacy_landing_integrity: event_without_ancestry",
      legacyHistory: [
        expect.objectContaining({
          taskId: "bd-closed",
          decision: "grandfathered_closed",
          accepted: true,
        }),
        expect.objectContaining({
          taskId: "bd-1",
          decision: "event_without_ancestry",
          accepted: false,
        }),
      ],
    });
    expect(JSON.stringify(record)).not.toMatch(/tasks recover/);
  });
});
