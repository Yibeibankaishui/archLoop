import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  appendHubLandingCheckpoint,
  deriveHubLandingShipped,
  loadHubLandingTransaction,
  parseHubLandingTransactionRecord,
  reduceHubLandingTransaction,
  resolveHubLandingJournalPath,
  resolveHubLandingTransactionId,
  type HubLandingTransactionRecord,
} from "./hubLandingTransaction.js";

const oid = (n: number): string => n.toString(16).padStart(40, "0");

const record = (
  overrides: Partial<HubLandingTransactionRecord> &
    Pick<HubLandingTransactionRecord, "checkpoint">,
): HubLandingTransactionRecord => ({
  type: "checkpoint",
  transactionId: "ltx-task-1",
  taskId: "task-1",
  createdAt: "2026-08-13T00:00:00.000Z",
  ...overrides,
});

describe("Hub landing transaction store", () => {
  it("assigns a stable idempotency id from task and exact OIDs", () => {
    const first = resolveHubLandingTransactionId({
      taskId: "bd-1",
      sourceOid: oid(1),
      baseOid: oid(2),
    });
    const second = resolveHubLandingTransactionId({
      taskId: "bd-1",
      sourceOid: oid(1),
      baseOid: oid(2),
    });
    const differentBase = resolveHubLandingTransactionId({
      taskId: "bd-1",
      sourceOid: oid(1),
      baseOid: oid(3),
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^ltx-bd-1-/);
    expect(differentBase).not.toBe(first);
  });

  it("replays checkpoints and ignores truncated or invalid journal tails", async () => {
    const hubProjectDir = await mkdtemp(join(tmpdir(), "hub-landing-txn-"));
    const opened = appendHubLandingCheckpoint(
      hubProjectDir,
      record({ checkpoint: "opened" }),
    );
    expect(opened.checkpoint).toBe("opened");
    appendHubLandingCheckpoint(
      hubProjectDir,
      record({
        checkpoint: "base_pinned",
        sourceOid: oid(1),
        baseOid: oid(2),
        createdAt: "2026-08-13T00:00:01.000Z",
      }),
    );
    appendHubLandingCheckpoint(
      hubProjectDir,
      record({
        checkpoint: "candidate_created",
        candidateOid: oid(3),
        candidateRef: "refs/archloop/candidates/ltx-task-1",
        createdAt: "2026-08-13T00:00:02.000Z",
      }),
    );

    const journalPath = resolveHubLandingJournalPath(
      hubProjectDir,
      "ltx-task-1",
    );
    const existing = await readFile(journalPath, "utf8");
    await writeFile(
      journalPath,
      `${existing}{"type":"checkpoint","checkpoint":"target_landed","transactionId":"ltx-task-1"\nnot json\n`,
    );

    const loaded = loadHubLandingTransaction(hubProjectDir, "ltx-task-1");
    expect(loaded?.checkpoint).toBe("candidate_created");
    expect(loaded?.sourceOid).toBe(oid(1));
    expect(loaded?.baseOid).toBe(oid(2));
    expect(loaded?.candidateOid).toBe(oid(3));
  });

  it("rejects mismatched OIDs when parsing records", () => {
    expect(
      parseHubLandingTransactionRecord({
        type: "checkpoint",
        checkpoint: "candidate_created",
        transactionId: "ltx-task-1",
        taskId: "task-1",
        createdAt: "2026-08-13T00:00:00.000Z",
        candidateOid: "not-an-oid",
      }),
    ).toBeUndefined();
  });

  it("preserves filtered Beads runtime paths on candidate checkpoints", () => {
    const parsed = parseHubLandingTransactionRecord({
      type: "checkpoint",
      checkpoint: "candidate_created",
      transactionId: "ltx-task-1",
      taskId: "task-1",
      createdAt: "2026-08-13T00:00:00.000Z",
      candidateOid: oid(3),
      filteredBeadsRuntimePaths: [".beads/issues.jsonl", ""],
    });
    expect(parsed?.filteredBeadsRuntimePaths).toEqual([".beads/issues.jsonl"]);
    expect(
      reduceHubLandingTransaction([
        record({ checkpoint: "opened" }),
        record({
          checkpoint: "candidate_created",
          candidateOid: oid(3),
          filteredBeadsRuntimePaths: [".beads/issues.jsonl"],
        }),
      ])?.filteredBeadsRuntimePaths,
    ).toEqual([".beads/issues.jsonl"]);
  });

  it("keeps duplicate later records stable when reducing", () => {
    const reduced = reduceHubLandingTransaction([
      record({ checkpoint: "opened" }),
      record({
        checkpoint: "candidate_verified",
        candidateOid: oid(3),
        verifierFingerprint: "abc",
        createdAt: "2026-08-13T00:00:03.000Z",
      }),
      record({
        checkpoint: "candidate_verified",
        candidateOid: oid(3),
        verifierFingerprint: "abc",
        createdAt: "2026-08-13T00:00:04.000Z",
      }),
    ]);
    expect(reduced?.checkpoint).toBe("candidate_verified");
    expect(reduced?.candidateOid).toBe(oid(3));
    expect(reduced?.verifierFingerprint).toBe("abc");
    expect(reduced?.updatedAt).toBe("2026-08-13T00:00:04.000Z");
  });

  it("derives shipped only from verified landing plus matching closure", () => {
    const candidateOid = oid(9);
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: true,
        transactionId: "ltx-1",
        closedTransactionId: "ltx-1",
        candidateOid,
        closedCandidateOid: candidateOid,
        publishTargetOid: candidateOid,
      }).shipped,
    ).toBe(true);
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: true,
        transactionId: "ltx-1",
        closedTransactionId: "ltx-1",
        candidateOid,
        closedCandidateOid: candidateOid,
        publishTargetOid: oid(8),
      }),
    ).toMatchObject({
      shipped: false,
      reason: "publish_target_does_not_contain_candidate",
    });
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: true,
        transactionId: "ltx-1",
        closedTransactionId: "other",
        candidateOid,
        closedCandidateOid: candidateOid,
        publishTargetOid: candidateOid,
      }).shipped,
    ).toBe(false);
    expect(
      deriveHubLandingShipped({
        publishPolicy: "best_effort",
        taskClosed: false,
        transactionId: "ltx-1",
        candidateOid,
        publishTargetOid: candidateOid,
      }).shipped,
    ).toBe(false);
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: true,
        legacyClosedGrandfathered: true,
      }),
    ).toMatchObject({
      shipped: true,
      reason: "legacy_closed_grandfathered",
    });
  });
});
