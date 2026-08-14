import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { HubTaskEvent } from "./hubExecution.js";
import { deriveHubLandingShipped } from "./hubLandingTransaction.js";
import { ensureHubLandingPolicy } from "./hubLandingPolicy.js";
import {
  inspectHubLandingTransactions,
  reconcileHubLandingTransactions,
} from "./hubLandingReconciliation.js";
import { loadHubLandingTransaction } from "./hubLandingTransaction.js";
import type { HubLegacyLandingTask } from "./hubLandingLegacyHistory.js";
import { HUB_LEGACY_LANDING_INTEGRITY } from "./hubLandingLegacyHistory.js";

const execFileAsync = promisify(execFile);

const gitText = async (
  cwd: string,
  args: readonly string[],
): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
};

const initRepo = async (dir: string) => {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execFileAsync("git", ["add", name], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", message], { cwd: dir });
};

const mergeEvent = (
  taskId: string,
  branch: string,
  type: HubTaskEvent["type"] = "merge_succeeded",
): HubTaskEvent => ({
  type,
  runId: "run-legacy",
  batchId: "batch-legacy",
  taskId,
  branch,
  createdAt: "2026-08-01T00:00:00.000Z",
  status: "merging",
});

const closedTask = (id: string): HubLegacyLandingTask => ({
  id,
  title: id,
  hubStatus: "done",
  metadata: {},
});

const inFlightTask = (id: string): HubLegacyLandingTask => ({
  id,
  title: id,
  hubStatus: "waiting_for_merge",
  metadata: {},
});

const createLegacyFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `hub-legacy-landing-${label}-`));
  const repoDir = join(root, "repo");
  const hubProjectDir = join(root, "hub-project");
  await mkdir(repoDir, { recursive: true });
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello\n", "init");
  const policy = ensureHubLandingPolicy({
    repoRoot: repoDir,
    hubProjectDir,
  }).policy;
  return { repoDir, hubProjectDir, policy, branch: `archloop/${label}` };
};

const listReceiptRefs = async (repoDir: string): Promise<string> => {
  try {
    return await gitText(repoDir, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/archloop/receipts/",
    ]);
  } catch {
    return "";
  }
};

describe("legacy Hub landing history", () => {
  it("grandfathers already closed historical tasks without receipts or reopen", async () => {
    const { repoDir, hubProjectDir } =
      await createLegacyFixture("bd-closed");
    const tasks = [closedTask("bd-closed")];
    const events = [
      mergeEvent("bd-closed", "archloop/bd-closed"),
    ];
    const closes: string[] = [];
    const inspection = inspectHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks,
      events,
    });
    expect(inspection.legacyHistory ?? []).toEqual([
      expect.objectContaining({
        taskId: "bd-closed",
        decision: "grandfathered_closed",
        accepted: true,
      }),
    ]);
    expect(inspection.message).toMatch(/already closed|Grandfathered/i);
    expect(inspection.message).not.toMatch(/tasks recover/);
    expect(inspection.kind).toBe("clean");

    const outcome = await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks,
      events,
      closeTask: async ({ taskId }) => {
        closes.push(taskId);
      },
    });
    expect(closes).toEqual([]);
    expect(await listReceiptRefs(repoDir)).toBe("");
    expect(outcome.legacyHistory ?? []).toEqual([
      expect.objectContaining({
        decision: "grandfathered_closed",
        accepted: true,
      }),
    ]);
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

  it("adopts an in-flight task whose source is contained in the configured target", async () => {
    const { repoDir, hubProjectDir, branch, policy } =
      await createLegacyFixture("bd-contained");
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    const sourceOid = await gitText(repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });
    await execFileAsync("git", ["merge", "--no-ff", branch, "-m", "land"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["update-ref", policy.publishTargetRef, "HEAD"], {
      cwd: repoDir,
    });
    const targetOid = await gitText(repoDir, ["rev-parse", "HEAD"]);
    const tasks = [inFlightTask("bd-contained")];
    const events = [mergeEvent("bd-contained", branch)];
    const closed: Array<{ taskId: string; transactionId: string; candidateOid: string }> =
      [];

    const inspection = inspectHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks,
      events,
    });
    expect(inspection.legacyHistory?.[0]).toMatchObject({
      decision: "ancestry_contained",
      accepted: true,
      sourceOid,
    });
    expect(inspection.kind).toBe("clean");
    expect(closed).toEqual([]);

    const beads: {
      closed: boolean;
      transactionId?: string;
      candidateOid?: string;
    } = { closed: false };
    const outcome = await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks,
      events,
      readTaskClose: () =>
        beads.closed
          ? {
              closed: true,
              transactionId: beads.transactionId,
              candidateOid: beads.candidateOid,
            }
          : { closed: false },
      closeTask: async ({ taskId, transactionId, candidateOid }) => {
        closed.push({ taskId, transactionId, candidateOid });
        beads.closed = true;
        beads.transactionId = transactionId;
        beads.candidateOid = candidateOid;
      },
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.candidateOid).toBe(sourceOid);
    expect(outcome.legacyHistory?.[0]?.decision).toBe("ancestry_contained");
    expect(outcome.legacyHistory?.[0]?.transactionId).toBeTruthy();
    expect(outcome.message).not.toMatch(/tasks recover/);
    const transactionId = closed[0]!.transactionId;
    expect(
      loadHubLandingTransaction(hubProjectDir, transactionId)?.checkpoint,
    ).toBe("cleaned");
    expect(await gitText(repoDir, ["rev-parse", policy.publishTargetRef])).toBe(
      targetOid,
    );
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: true,
        transactionId,
        closedTransactionId: transactionId,
        candidateOid: sourceOid,
        closedCandidateOid: sourceOid,
        publishTargetOid: targetOid,
        candidateContainedInTarget: true,
      }).shipped,
    ).toBe(true);

    const again = await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks: [
        {
          id: "bd-contained",
          title: "bd-contained",
          hubStatus: "done",
          metadata: {
            landingTransactionId: transactionId,
            landingCandidateOid: sourceOid,
          },
        },
      ],
      events,
      readTaskClose: () => ({
        closed: true,
        transactionId,
        candidateOid: sourceOid,
      }),
      closeTask: async () => {
        closed.push({
          taskId: "again",
          transactionId,
          candidateOid: sourceOid,
        });
      },
    });
    expect(closed).toHaveLength(1);
    expect(again.kind === "integrity_incident").toBe(false);
  });

  it("never treats merge_succeeded without ancestry as landed, closed, or shipped", async () => {
    const { repoDir, hubProjectDir, branch } =
      await createLegacyFixture("bd-event-only");
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "extra.txt", "extra\n", "unmerged work");
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });
    const branchOid = await gitText(repoDir, ["rev-parse", branch]);
    const tasks = [inFlightTask("bd-event-only")];
    const events = [mergeEvent("bd-event-only", branch)];
    const closes: string[] = [];

    const inspection = inspectHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks,
      events,
    });
    expect(inspection.kind).toBe("integrity_incident");
    expect(inspection.integrityIncident).toBe(
      `${HUB_LEGACY_LANDING_INTEGRITY}: event_without_ancestry`,
    );
    expect(inspection.legacyHistory?.[0]).toMatchObject({
      decision: "event_without_ancestry",
      accepted: false,
      hadMergeSucceededEvent: true,
    });
    expect(inspection.message).toMatch(
      /merge_succeeded event is not landing proof/i,
    );
    expect(inspection.message).not.toMatch(/tasks recover/);

    const outcome = await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks,
      events,
      closeTask: async ({ taskId }) => {
        closes.push(taskId);
      },
    });
    expect(closes).toEqual([]);
    expect(outcome.kind).toBe("integrity_incident");
    expect(await gitText(repoDir, ["rev-parse", branch])).toBe(branchOid);
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: false,
        transactionId: "ltx-event-only",
      }).shipped,
    ).toBe(false);
  });

  it("surfaces a missing task branch as a distinct legacy integrity condition", async () => {
    const { repoDir, hubProjectDir } =
      await createLegacyFixture("bd-missing");
    const inspection = inspectHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks: [inFlightTask("bd-missing")],
      events: [mergeEvent("bd-missing", "archloop/bd-missing-gone")],
    });
    expect(inspection.kind).toBe("integrity_incident");
    expect(inspection.integrityIncident).toBe(
      `${HUB_LEGACY_LANDING_INTEGRITY}: missing_branch`,
    );
    expect(inspection.legacyHistory?.[0]?.decision).toBe("missing_branch");
    expect(inspection.nextAction).toMatch(/Inspect/);
    expect(inspection.message).not.toMatch(/tasks recover/);
  });

  it("surfaces a diverged target without closing or rewriting preserved work", async () => {
    const { repoDir, hubProjectDir, branch, policy } =
      await createLegacyFixture("bd-diverged");
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    const branchOid = await gitText(repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });
    await commitFile(repoDir, "main.txt", "main\n", "main continues");
    await execFileAsync("git", ["update-ref", policy.publishTargetRef, "HEAD"], {
      cwd: repoDir,
    });
    const inspection = inspectHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks: [inFlightTask("bd-diverged")],
      events: [mergeEvent("bd-diverged", branch)],
    });
    expect(inspection.legacyHistory?.[0]?.decision).toBe("diverged_target");
    expect(inspection.integrityIncident).toBe(
      `${HUB_LEGACY_LANDING_INTEGRITY}: diverged_target`,
    );
    const closes: string[] = [];
    await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      tasks: [inFlightTask("bd-diverged")],
      events: [mergeEvent("bd-diverged", branch)],
      closeTask: async ({ taskId }) => {
        closes.push(taskId);
      },
    });
    expect(closes).toEqual([]);
    expect(await gitText(repoDir, ["rev-parse", branch])).toBe(branchOid);
    expect(await gitText(repoDir, ["log", "-1", "--pretty=%s", branch])).toBe(
      "feature",
    );
  });
});
