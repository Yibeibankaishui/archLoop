import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  HUB_LANDING_SIDE_EFFECTS,
  bindHubLandingVerification,
  cleanupHubLandingCandidate,
  closeHubLandingTask,
  commitHubLandingTarget,
  computeHubVerifierFingerprint,
  createHubLandingCandidate,
  HubLandingCrash,
  readHubLandingVerificationArtifact,
  type HubLandingBeadsCloseEvidence,
  type HubLandingSideEffect,
} from "./hubLanding.js";
import { ensureHubLandingPolicy } from "./hubLandingPolicy.js";
import {
  inspectHubLandingTransactions,
  reconcileHubLandingTransactions,
} from "./hubLandingReconciliation.js";
import {
  deriveHubLandingShipped,
  loadHubLandingTransaction,
  resolveHubLandingJournalPath,
} from "./hubLandingTransaction.js";
import { projectHubCheckoutOutbox } from "./hubCheckoutProjection.js";

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

const dropJournalCheckpoint = async (
  hubProjectDir: string,
  transactionId: string,
  checkpoint: string,
) => {
  const journalPath = resolveHubLandingJournalPath(
    hubProjectDir,
    transactionId,
  );
  const journal = await readFile(journalPath, "utf8");
  await writeFile(
    journalPath,
    journal
      .split("\n")
      .filter((line) => !line.includes(`"checkpoint":"${checkpoint}"`))
      .join("\n"),
  );
};

const createLandingFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `hub-landing-${label}-`));
  const repoDir = join(root, "repo");
  const hubProjectDir = join(root, "hub-project");
  await mkdir(repoDir, { recursive: true });
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello\n", "init");
  const branch = `archloop/${label}`;
  await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
  await commitFile(repoDir, "feature.txt", `${label}\n`, label);
  await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });
  const policy = ensureHubLandingPolicy({
    repoRoot: repoDir,
    hubProjectDir,
  }).policy;
  return { repoDir, hubProjectDir, branch, policy, taskId: label };
};

const createVerifiedCandidate = async (label: string) => {
  const fixture = await createLandingFixture(label);
  const candidate = await createHubLandingCandidate({
    repoRoot: fixture.repoDir,
    hubProjectDir: fixture.hubProjectDir,
    taskId: fixture.taskId,
    branch: fixture.branch,
  });
  const fingerprint = computeHubVerifierFingerprint(fixture.repoDir);
  bindHubLandingVerification({
    hubProjectDir: fixture.hubProjectDir,
    transactionId: candidate.transactionId,
    taskId: fixture.taskId,
    candidateOid: candidate.candidateOid,
    verifierFingerprint: fingerprint,
    repoRoot: fixture.repoDir,
  });
  return { ...fixture, candidate, fingerprint };
};

describe("Hub landing transaction reconciliation", () => {
  it("reuses a verification artifact only when OID, fingerprints, result, and hash match", async () => {
    const { repoDir, hubProjectDir, candidate, fingerprint } =
      await createVerifiedCandidate("bd-artifact");
    await dropJournalCheckpoint(
      hubProjectDir,
      candidate.transactionId,
      "candidate_verified",
    );
    expect(
      loadHubLandingTransaction(hubProjectDir, candidate.transactionId)
        ?.checkpoint,
    ).toBe("candidate_created");

    const reused = bindHubLandingVerification({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: candidate.taskId,
      candidateOid: candidate.candidateOid,
      verifierFingerprint: fingerprint,
      repoRoot: repoDir,
    });
    const stored = readHubLandingVerificationArtifact(
      hubProjectDir,
      candidate.transactionId,
    );
    expect(stored?.createdAt).toBe(reused.createdAt);
    expect(stored?.artifactHash).toBe(reused.artifactHash);

    bindHubLandingVerification({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: candidate.taskId,
      candidateOid: candidate.candidateOid,
      verifierFingerprint: "deadbeef",
      repoRoot: repoDir,
      output: "different",
    });
    const replaced = readHubLandingVerificationArtifact(
      hubProjectDir,
      candidate.transactionId,
    );
    expect(replaced?.artifactHash).not.toBe(reused.artifactHash);
  });

  it("reconstructs local landing from the atomic receipt without a second CAS", async () => {
    const { repoDir, hubProjectDir, candidate, fingerprint, policy } =
      await createVerifiedCandidate("bd-receipt");
    const first = await commitHubLandingTarget({
      repoRoot: repoDir,
      hubProjectDir,
      candidate,
      verifierFingerprint: fingerprint,
    });
    await dropJournalCheckpoint(
      hubProjectDir,
      candidate.transactionId,
      "target_landed",
    );
    const reflogBefore = await gitText(repoDir, [
      "reflog",
      "show",
      policy.publishTargetRef,
    ]);

    const second = await commitHubLandingTarget({
      repoRoot: repoDir,
      hubProjectDir,
      candidate,
      verifierFingerprint: fingerprint,
    });
    expect(second.receiptOid).toBe(first.receiptOid);
    expect(second.publishTargetOid).toBe(first.publishTargetOid);
    expect(await gitText(repoDir, ["rev-parse", policy.publishTargetRef])).toBe(
      candidate.candidateOid,
    );
    expect(
      await gitText(repoDir, ["reflog", "show", policy.publishTargetRef]),
    ).toBe(reflogBefore);
    expect(
      loadHubLandingTransaction(hubProjectDir, candidate.transactionId)
        ?.checkpoint,
    ).toBe("target_landed");
  });

  it("treats a matching Beads close as idempotent after an unknown outcome", async () => {
    const { hubProjectDir, candidate } =
      await createVerifiedCandidate("bd-close");
    const closes: string[] = [];
    const evidence: HubLandingBeadsCloseEvidence = {
      closed: true,
      transactionId: candidate.transactionId,
      candidateOid: candidate.candidateOid,
    };
    const first = await closeHubLandingTask({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: candidate.taskId,
      candidateOid: candidate.candidateOid,
      readTaskClose: () => evidence,
      closeTask: async () => {
        closes.push("close");
      },
    });
    const second = await closeHubLandingTask({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: candidate.taskId,
      candidateOid: candidate.candidateOid,
      readTaskClose: () => evidence,
      closeTask: async () => {
        closes.push("close");
      },
    });
    expect(closes).toEqual([]);
    expect(first.checkpoint).toBe("task_closed");
    expect(second.checkpoint).toBe("task_closed");
  });

  it("retries cleanup without revoking shipped proof", async () => {
    const { repoDir, hubProjectDir, candidate, fingerprint, policy } =
      await createVerifiedCandidate("bd-cleanup");
    await commitHubLandingTarget({
      repoRoot: repoDir,
      hubProjectDir,
      candidate,
      verifierFingerprint: fingerprint,
    });
    await closeHubLandingTask({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: candidate.taskId,
      candidateOid: candidate.candidateOid,
    });
    await cleanupHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      candidate,
    });
    await dropJournalCheckpoint(
      hubProjectDir,
      candidate.transactionId,
      "cleaned",
    );
    await cleanupHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      candidate,
    });
    expect(existsSync(candidate.worktreeDir)).toBe(false);
    expect(await gitText(repoDir, ["rev-parse", policy.publishTargetRef])).toBe(
      candidate.candidateOid,
    );
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: true,
        transactionId: candidate.transactionId,
        closedTransactionId: candidate.transactionId,
        candidateOid: candidate.candidateOid,
        closedCandidateOid: candidate.candidateOid,
        publishTargetOid: candidate.candidateOid,
      }).shipped,
    ).toBe(true);
  });

  it("lets inspect project pending state without writing checkpoints", async () => {
    const { repoDir, hubProjectDir, candidate } =
      await createVerifiedCandidate("bd-inspect");
    await dropJournalCheckpoint(
      hubProjectDir,
      candidate.transactionId,
      "candidate_verified",
    );
    const journalPath = resolveHubLandingJournalPath(
      hubProjectDir,
      candidate.transactionId,
    );
    const before = await readFile(journalPath, "utf8");
    const inspection = await inspectHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
    });
    expect(inspection.kind).toBe("pending");
    expect(inspection.message).not.toMatch(/tasks recover/);
    expect(inspection.transactions[0]?.verificationReusable).toBe(true);
    expect(await readFile(journalPath, "utf8")).toBe(before);
    expect(
      loadHubLandingTransaction(hubProjectDir, candidate.transactionId)
        ?.checkpoint,
    ).toBe("candidate_created");
  });

  it("reconstructs missing checkpoints from physical evidence on mutating reconcile", async () => {
    const { repoDir, hubProjectDir, candidate, fingerprint, policy } =
      await createVerifiedCandidate("bd-reconcile");
    await commitHubLandingTarget({
      repoRoot: repoDir,
      hubProjectDir,
      candidate,
      verifierFingerprint: fingerprint,
    });
    await dropJournalCheckpoint(
      hubProjectDir,
      candidate.transactionId,
      "target_landed",
    );
    const closes: string[] = [];
    const outcome = await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
      readTaskClose: () => ({
        closed: true,
        transactionId: candidate.transactionId,
        candidateOid: candidate.candidateOid,
      }),
      closeTask: async () => {
        closes.push("close");
      },
    });
    expect(closes).toEqual([]);
    expect(outcome.message).not.toMatch(/tasks recover/);
    expect(
      loadHubLandingTransaction(hubProjectDir, candidate.transactionId)
        ?.checkpoint,
    ).toBe("cleaned");
    expect(await gitText(repoDir, ["rev-parse", policy.publishTargetRef])).toBe(
      candidate.candidateOid,
    );
    expect(existsSync(candidate.worktreeDir)).toBe(false);
  });

  it("surfaces mismatched candidate OIDs as an integrity incident", async () => {
    const { repoDir, hubProjectDir, candidate } =
      await createVerifiedCandidate("bd-mismatch");
    const head = await gitText(repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync(
      "git",
      ["update-ref", candidate.candidateRef, head],
      { cwd: repoDir },
    );
    const inspection = await inspectHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
    });
    expect(inspection.kind).toBe("integrity_incident");
    expect(inspection.message).toMatch(/landing_integrity_incident|does not match/);
    expect(inspection.message).not.toMatch(/tasks recover/);
    const outcome = await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
    });
    expect(outcome.kind).toBe("integrity_incident");
    expect(
      loadHubLandingTransaction(hubProjectDir, candidate.transactionId)
        ?.candidateOid,
    ).toBe(candidate.candidateOid);
  });

  it("converges duplicate startup invocations and two runs for the same task", async () => {
    const { repoDir, hubProjectDir, branch, taskId } =
      await createLandingFixture("bd-twice");
    const first = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId,
      branch,
    });
    const second = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId,
      branch,
    });
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.candidateOid).toBe(first.candidateOid);
    const once = await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
    });
    const twice = await reconcileHubLandingTransactions({
      repoRoot: repoDir,
      hubProjectDir,
    });
    expect(twice.transactions[0]?.candidateOid).toBe(first.candidateOid);
    expect(once.kind === "integrity_incident").toBe(false);
    expect(twice.kind === "integrity_incident").toBe(false);
  });

  it.each(
    HUB_LANDING_SIDE_EFFECTS.flatMap(
      (
        sideEffect,
      ): {
        sideEffect: HubLandingSideEffect;
        timing: "before" | "after";
      }[] => [
        { sideEffect, timing: "before" },
        { sideEffect, timing: "after" },
      ],
    ),
  )(
    "resumes after a crash $timing $sideEffect with at-most-once landing and close",
    async ({ sideEffect, timing }) => {
      const { repoDir, hubProjectDir, branch, taskId, policy } =
        await createLandingFixture(`bd-fault-${timing}-${sideEffect}`);
      const fingerprint = computeHubVerifierFingerprint(repoDir);
      const faultInjection =
        timing === "before"
          ? { crashBefore: sideEffect }
          : { crashAfter: sideEffect };
      const beads: {
        closed: boolean;
        transactionId?: string;
        candidateOid?: string;
      } = {
        closed: false,
      };
      const closeCounts = { value: 0 };
      const closeTask = async (input: {
        readonly transactionId: string;
        readonly candidateOid: string;
      }) => {
        closeCounts.value += 1;
        beads.closed = true;
        beads.transactionId = input.transactionId;
        beads.candidateOid = input.candidateOid;
      };

      const runStep = async <T>(
        operation: (fault?: typeof faultInjection) => Promise<T>,
      ): Promise<T> => {
        try {
          return await operation(faultInjection);
        } catch (error) {
          expect(error).toBeInstanceOf(HubLandingCrash);
          return await operation(undefined);
        }
      };

      const candidate = await runStep((fault) =>
        createHubLandingCandidate({
          repoRoot: repoDir,
          hubProjectDir,
          taskId,
          branch,
          faultInjection: fault,
        }),
      );
      await runStep(async (fault) =>
        bindHubLandingVerification({
          hubProjectDir,
          transactionId: candidate.transactionId,
          taskId,
          candidateOid: candidate.candidateOid,
          verifierFingerprint: fingerprint,
          repoRoot: repoDir,
          faultInjection: fault,
        }),
      );
      await runStep((fault) =>
        commitHubLandingTarget({
          repoRoot: repoDir,
          hubProjectDir,
          candidate,
          verifierFingerprint: fingerprint,
          faultInjection: fault,
        }),
      );
      await runStep((fault) =>
        closeHubLandingTask({
          hubProjectDir,
          transactionId: candidate.transactionId,
          taskId,
          candidateOid: candidate.candidateOid,
          readTaskClose: () => beads,
          closeTask,
          faultInjection: fault,
        }),
      );
      await runStep((fault) =>
        cleanupHubLandingCandidate({
          repoRoot: repoDir,
          hubProjectDir,
          candidate,
          faultInjection: fault,
        }),
      );
      await runStep((fault) =>
        projectHubCheckoutOutbox({
          repoRoot: repoDir,
          hubProjectDir,
          faultInjection: fault,
        }),
      );
      expect(await gitText(repoDir, ["rev-parse", policy.publishTargetRef])).toBe(
        candidate.candidateOid,
      );
      expect(await gitText(repoDir, ["rev-parse", candidate.candidateRef])).toBe(
        candidate.candidateOid,
      );
      const receiptCount = (
        await gitText(repoDir, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/archloop/receipts/",
        ])
      )
        .split("\n")
        .filter((line) => line.length > 0);
      expect(receiptCount).toEqual([
        `refs/archloop/receipts/${candidate.transactionId}`,
      ]);
      expect(closeCounts.value).toBe(1);
      expect(beads.closed).toBe(true);
      expect(
        deriveHubLandingShipped({
          publishPolicy: "off",
          taskClosed: true,
          transactionId: candidate.transactionId,
          closedTransactionId: candidate.transactionId,
          candidateOid: candidate.candidateOid,
          closedCandidateOid: candidate.candidateOid,
          publishTargetOid: candidate.candidateOid,
        }).shipped,
      ).toBe(true);
    },
  );
});
