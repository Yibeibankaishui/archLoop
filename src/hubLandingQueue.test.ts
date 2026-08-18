import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  HubLandingCrash,
  bindHubLandingVerification,
  computeHubVerifierFingerprint,
  createHubLandingCandidate,
  invalidateHubLandingCandidate,
  readHubLandingReceipt,
  readHubLandingVerificationArtifact,
} from "./hubLanding.js";
import { coordinateHubQueueHeadLanding } from "./hubLandingCoordinator.js";
import { ensureHubLandingPolicy } from "./hubLandingPolicy.js";
import {
  HUB_LANDING_TARGET_DRIFT_REBUILD_LIMIT,
  HUB_TARGET_QUIET_WAIT,
  assignHubLandingQueueTickets,
  canLandHubLandingTicket,
  classifyHubHostTargetRelation,
  invalidateHubLandingSpeculativeSuffix,
  markHubLandingQueueFailed,
  markHubLandingQueueLanded,
  markHubLandingQueuePublishing,
  readHubHostDirtySnapshot,
  readHubLandingQueue,
  reconcileHubHostTargetContribution,
  recordHubLandingQueueCandidate,
  resolveHubLandingQueueHead,
  resolveRequiredDeliveryPredecessor,
  selectHubSpeculativeChain,
  verifyHubSpeculativeCandidatesConcurrently,
  type HubLandingQueueClock,
} from "./hubLandingQueue.js";
import {
  recordHubLandingRepairAttempt,
  remainingHubLandingRepairAttempts,
} from "./hubLandingRepair.js";
import { loadHubLandingTransaction } from "./hubLandingTransaction.js";

const execFileAsync = promisify(execFile);

const gitText = async (cwd: string, args: readonly string[]): Promise<string> => {
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

const silentClock = (): HubLandingQueueClock => ({
  now: () => new Date("2026-08-14T18:00:00.000Z"),
  sleep: async () => undefined,
  random: () => 0.5,
});

const driftPublishTarget = async (
  repoDir: string,
  publishTargetRef: string,
  name: string,
  content: string,
) => {
  await commitFile(repoDir, name, content, `host ${name}`);
  const oid = await gitText(repoDir, ["rev-parse", "HEAD"]);
  await execFileAsync("git", ["update-ref", publishTargetRef, oid], {
    cwd: repoDir,
  });
  return oid;
};

const prepareRepo = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `hub-landing-queue-${label}-`));
  const repoDir = join(root, "repo");
  const hubProjectDir = join(root, "hub-project");
  await mkdir(repoDir, { recursive: true });
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello\n", "init");
  const policy = ensureHubLandingPolicy({
    repoRoot: repoDir,
    hubProjectDir,
  }).policy;
  const fingerprint = computeHubVerifierFingerprint(repoDir);
  return { repoDir, hubProjectDir, policy, fingerprint };
};

const addTaskBranch = async (
  repoDir: string,
  label: string,
  file: string,
  content: string,
) => {
  const branch = `archloop/bd-${label}`;
  await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
  await commitFile(repoDir, file, content, `${label} feature`);
  await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });
  return branch;
};

const bindCandidate = (
  hubProjectDir: string,
  repoDir: string,
  fingerprint: string,
  candidate: Awaited<ReturnType<typeof createHubLandingCandidate>>,
) => {
  bindHubLandingVerification({
    hubProjectDir,
    transactionId: candidate.transactionId,
    taskId: candidate.taskId,
    candidateOid: candidate.candidateOid,
    verifierFingerprint: fingerprint,
    repoRoot: repoDir,
  });
};

describe("Hub landing FIFO tickets", () => {
  it("assigns durable FIFO tickets and refuses later landings before the queue head", async () => {
    const prepared = await prepareRepo("fifo");
    const branchA = await addTaskBranch(
      prepared.repoDir,
      "older",
      "a.txt",
      "a\n",
    );
    const branchB = await addTaskBranch(
      prepared.repoDir,
      "newer",
      "b.txt",
      "b\n",
    );
    const sourceA = await gitText(prepared.repoDir, [
      "rev-parse",
      `${branchA}^{commit}`,
    ]);
    const sourceB = await gitText(prepared.repoDir, [
      "rev-parse",
      `${branchB}^{commit}`,
    ]);
    const queue = assignHubLandingQueueTickets({
      hubProjectDir: prepared.hubProjectDir,
      publishTargetRef: prepared.policy.publishTargetRef,
      tasks: [
        { taskId: "bd-older", sourceOid: sourceA },
        { taskId: "bd-newer", sourceOid: sourceB },
      ],
      clock: silentClock(),
    });
    expect(queue.tickets.map((ticket) => ticket.taskId)).toEqual([
      "bd-older",
      "bd-newer",
    ]);
    expect(queue.tickets[0]?.sequence).toBe(1);
    expect(queue.tickets[1]?.sequence).toBe(2);
    expect(resolveHubLandingQueueHead(queue)?.taskId).toBe("bd-older");
    expect(
      canLandHubLandingTicket({
        hubProjectDir: prepared.hubProjectDir,
        taskId: "bd-newer",
      }),
    ).toBe(false);

    const candidateB = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-newer",
      branch: branchB,
    });
    bindCandidate(
      prepared.hubProjectDir,
      prepared.repoDir,
      prepared.fingerprint,
      candidateB,
    );
    const blocked = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-newer",
      branch: branchB,
      candidate: candidateB,
      verifierFingerprint: prepared.fingerprint,
      clock: silentClock(),
    });
    expect(blocked.kind).toBe("not_queue_head");
    if (blocked.kind === "not_queue_head") {
      expect(blocked.message).not.toMatch(/tasks recover/i);
    }
    expect(
      await gitText(prepared.repoDir, [
        "rev-parse",
        prepared.policy.publishTargetRef,
      ]),
    ).toBe(candidateB.baseOid);

    const candidateA = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-older",
      branch: branchA,
    });
    bindCandidate(
      prepared.hubProjectDir,
      prepared.repoDir,
      prepared.fingerprint,
      candidateA,
    );
    const landed = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-older",
      branch: branchA,
      candidate: candidateA,
      verifierFingerprint: prepared.fingerprint,
      clock: silentClock(),
    });
    expect(landed.kind).toBe("landed");
    expect(
      canLandHubLandingTicket({
        hubProjectDir: prepared.hubProjectDir,
        taskId: "bd-newer",
        shippedTaskIds: new Set(["bd-older"]),
      }),
    ).toBe(true);
  });

  it("keeps the original ticket when the same task is assigned again", async () => {
    const prepared = await prepareRepo("idempotent");
    assignHubLandingQueueTickets({
      hubProjectDir: prepared.hubProjectDir,
      publishTargetRef: prepared.policy.publishTargetRef,
      tasks: [{ taskId: "bd-keep" }, { taskId: "bd-later" }],
      clock: silentClock(),
    });
    const again = assignHubLandingQueueTickets({
      hubProjectDir: prepared.hubProjectDir,
      publishTargetRef: prepared.policy.publishTargetRef,
      tasks: [{ taskId: "bd-keep" }, { taskId: "bd-extra" }],
      clock: silentClock(),
    });
    expect(
      again.tickets.find((ticket) => ticket.taskId === "bd-keep")?.sequence,
    ).toBe(1);
    expect(
      again.tickets.find((ticket) => ticket.taskId === "bd-later")?.sequence,
    ).toBe(2);
    expect(
      again.tickets.find((ticket) => ticket.taskId === "bd-extra")?.sequence,
    ).toBe(3);
  });
});

describe("Hub speculative candidate chain", () => {
  it("builds each candidate on its predecessor OID and verifies exact OIDs concurrently", async () => {
    const prepared = await prepareRepo("chain");
    const branchA = await addTaskBranch(
      prepared.repoDir,
      "one",
      "one.txt",
      "one\n",
    );
    const branchB = await addTaskBranch(
      prepared.repoDir,
      "two",
      "two.txt",
      "two\n",
    );
    assignHubLandingQueueTickets({
      hubProjectDir: prepared.hubProjectDir,
      publishTargetRef: prepared.policy.publishTargetRef,
      tasks: [{ taskId: "bd-one" }, { taskId: "bd-two" }],
      clock: silentClock(),
    });
    const first = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-one",
      branch: branchA,
    });
    const second = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-two",
      branch: branchB,
      baseOid: first.candidateOid,
    });
    expect(second.baseOid).toBe(first.candidateOid);
    expect(second.candidateOid).not.toBe(first.candidateOid);
    recordHubLandingQueueCandidate({
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-one",
      sourceOid: first.sourceOid,
      predecessorOid: first.baseOid,
      candidateOid: first.candidateOid,
      transactionId: first.transactionId,
    });
    recordHubLandingQueueCandidate({
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-two",
      sourceOid: second.sourceOid,
      predecessorOid: second.baseOid,
      candidateOid: second.candidateOid,
      transactionId: second.transactionId,
    });

    const { verificationConcurrency } =
      await verifyHubSpeculativeCandidatesConcurrently(
        [first, second],
        async (candidate) => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          bindCandidate(
            prepared.hubProjectDir,
            prepared.repoDir,
            prepared.fingerprint,
            candidate,
          );
        },
      );
    expect(verificationConcurrency).toBeGreaterThan(1);
    expect(
      await gitText(prepared.repoDir, [
        "rev-parse",
        prepared.policy.publishTargetRef,
      ]),
    ).toBe(first.baseOid);

    const landedHead = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-one",
      branch: branchA,
      candidate: first,
      verifierFingerprint: prepared.fingerprint,
      clock: silentClock(),
    });
    expect(landedHead.kind).toBe("landed");
    if (landedHead.kind !== "landed") {
      return;
    }
    expect(landedHead.candidate.candidateOid).toBe(first.candidateOid);
    expect(
      await gitText(prepared.repoDir, [
        "rev-parse",
        prepared.policy.publishTargetRef,
      ]),
    ).toBe(first.candidateOid);

    const landedSecond = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-two",
      branch: branchB,
      candidate: second,
      verifierFingerprint: prepared.fingerprint,
      clock: silentClock(),
      shippedTaskIds: new Set(["bd-one"]),
    });
    expect(landedSecond.kind).toBe("landed");
    expect(
      await gitText(prepared.repoDir, [
        "rev-parse",
        prepared.policy.publishTargetRef,
      ]),
    ).toBe(second.candidateOid);
  });

  it("invalidates the speculative suffix after predecessor repair and rebuilds independent successors", async () => {
    const prepared = await prepareRepo("suffix-repair");
    const branchA = await addTaskBranch(
      prepared.repoDir,
      "head",
      "head.txt",
      "head\n",
    );
    const branchB = await addTaskBranch(
      prepared.repoDir,
      "independent",
      "ind.txt",
      "ind\n",
    );
    assignHubLandingQueueTickets({
      hubProjectDir: prepared.hubProjectDir,
      publishTargetRef: prepared.policy.publishTargetRef,
      tasks: [{ taskId: "bd-head" }, { taskId: "bd-independent" }],
      clock: silentClock(),
    });
    const head = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-head",
      branch: branchA,
    });
    const successor = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-independent",
      branch: branchB,
      baseOid: head.candidateOid,
    });
    bindCandidate(
      prepared.hubProjectDir,
      prepared.repoDir,
      prepared.fingerprint,
      successor,
    );
    recordHubLandingQueueCandidate({
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-head",
      sourceOid: head.sourceOid,
      predecessorOid: head.baseOid,
      candidateOid: head.candidateOid,
      transactionId: head.transactionId,
    });
    recordHubLandingQueueCandidate({
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-independent",
      sourceOid: successor.sourceOid,
      predecessorOid: successor.baseOid,
      candidateOid: successor.candidateOid,
      transactionId: successor.transactionId,
    });

    const repaired = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-head",
      branch: branchA,
      baseOid: head.baseOid,
    });
    expect(repaired.baseOid).toBe(head.baseOid);
    const invalidated = invalidateHubLandingSpeculativeSuffix({
      hubProjectDir: prepared.hubProjectDir,
      fromTaskId: "bd-head",
      reason: "predecessor_repair",
      clock: silentClock(),
    });
    expect(invalidated.map((ticket) => ticket.taskId)).toEqual([
      "bd-independent",
    ]);
    expect(
      readHubLandingVerificationArtifact(
        prepared.hubProjectDir,
        successor.transactionId,
      ),
    ).toBeUndefined();

    const rebuilt = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-independent",
      branch: branchB,
      baseOid: repaired.candidateOid,
    });
    expect(rebuilt.baseOid).toBe(repaired.candidateOid);
    expect(readHubLandingQueue(prepared.hubProjectDir)?.tickets[1]?.status).toBe(
      "invalidated",
    );
  });

  it("keeps a dependent task blocked when its predecessor fails and rebuilds an independent successor", async () => {
    const prepared = await prepareRepo("suffix-fail");
    const branchA = await addTaskBranch(
      prepared.repoDir,
      "fail",
      "fail.txt",
      "fail\n",
    );
    const branchB = await addTaskBranch(
      prepared.repoDir,
      "free",
      "free.txt",
      "free\n",
    );
    await addTaskBranch(prepared.repoDir, "dep", "dep.txt", "dep\n");
    const originalTarget = await gitText(prepared.repoDir, [
      "rev-parse",
      prepared.policy.publishTargetRef,
    ]);
    assignHubLandingQueueTickets({
      hubProjectDir: prepared.hubProjectDir,
      publishTargetRef: prepared.policy.publishTargetRef,
      tasks: [
        { taskId: "bd-fail" },
        { taskId: "bd-free" },
        { taskId: "bd-dep", blockerTaskIds: ["bd-fail"] },
      ],
      clock: silentClock(),
    });
    const failed = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-fail",
      branch: branchA,
    });
    const independent = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-free",
      branch: branchB,
      baseOid: failed.candidateOid,
    });
    recordHubLandingQueueCandidate({
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-fail",
      sourceOid: failed.sourceOid,
      predecessorOid: failed.baseOid,
      candidateOid: failed.candidateOid,
      transactionId: failed.transactionId,
    });
    recordHubLandingQueueCandidate({
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-free",
      sourceOid: independent.sourceOid,
      predecessorOid: independent.baseOid,
      candidateOid: independent.candidateOid,
      transactionId: independent.transactionId,
    });
    markHubLandingQueueFailed(prepared.hubProjectDir, "bd-fail");
    invalidateHubLandingCandidate({
      hubProjectDir: prepared.hubProjectDir,
      transactionId: failed.transactionId,
    });
    invalidateHubLandingSpeculativeSuffix({
      hubProjectDir: prepared.hubProjectDir,
      fromTaskId: "bd-fail",
      reason: "predecessor_failure",
      clock: silentClock(),
    });

    const queue = readHubLandingQueue(prepared.hubProjectDir);
    expect(resolveHubLandingQueueHead(queue)?.taskId).toBe("bd-free");
    expect(selectHubSpeculativeChain(queue, new Set()).map((ticket) => ticket.taskId)).toEqual(
      ["bd-free"],
    );

    const rebuilt = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-free",
      branch: branchB,
      baseOid: originalTarget,
    });
    expect(rebuilt.baseOid).toBe(originalTarget);
  });
});

describe("Hub host-target contribution", () => {
  it("imports a descendant committed host tip and leaves uncommitted host state untouched", async () => {
    const prepared = await prepareRepo("host-desc");
    await writeFile(join(prepared.repoDir, "wip.txt"), "do not import\n");
    await writeFile(join(prepared.repoDir, "hello.txt"), "dirty hello\n");
    const before = await readHubHostDirtySnapshot(prepared.repoDir);
    await commitFile(prepared.repoDir, "human.txt", "human\n", "human commit");
    const hostOid = await gitText(prepared.repoDir, ["rev-parse", "HEAD"]);
    const classified = await classifyHubHostTargetRelation({
      repoRoot: prepared.repoDir,
      policy: prepared.policy,
    });
    expect(classified.relation).toBe("descendant");
    expect(classified.hostOid).toBe(hostOid);

    const result = await reconcileHubHostTargetContribution({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      policy: prepared.policy,
      clock: silentClock(),
    });
    expect(result?.imported).toBe(true);
    expect(result?.relation).toBe("descendant");
    expect(result?.hostDirtyUnchanged).toBe(true);
    expect(await readFile(join(prepared.repoDir, "wip.txt"), "utf8")).toBe(
      "do not import\n",
    );
    expect(await readFile(join(prepared.repoDir, "hello.txt"), "utf8")).toBe(
      "dirty hello\n",
    );
    expect(result?.afterDirty.porcelain).toContain("wip.txt");
    expect(result?.afterDirty.porcelain).toContain("hello.txt");
    expect(result?.afterDirty.porcelain).toBe(before.porcelain);
    const publishOid = await gitText(prepared.repoDir, [
      "rev-parse",
      prepared.policy.publishTargetRef,
    ]);
    expect(
      await gitText(prepared.repoDir, [
        "merge-base",
        "--is-ancestor",
        hostOid,
        publishOid,
      ]),
    ).toBe("");
  });

  it("imports diverged committed host work and ignores a behind host tip", async () => {
    const prepared = await prepareRepo("host-div");
    await execFileAsync("git", ["checkout", "-b", "side"], {
      cwd: prepared.repoDir,
    });
    await commitFile(prepared.repoDir, "side.txt", "side\n", "side commit");
    const sideOid = await gitText(prepared.repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync(
      "git",
      ["update-ref", prepared.policy.publishTargetRef, sideOid],
      { cwd: prepared.repoDir },
    );
    await execFileAsync("git", ["checkout", "main"], { cwd: prepared.repoDir });
    await commitFile(prepared.repoDir, "host-div.txt", "host\n", "host diverge");
    expect(
      (
        await classifyHubHostTargetRelation({
          repoRoot: prepared.repoDir,
          policy: prepared.policy,
        })
      ).relation,
    ).toBe("diverged");
    const diverged = await reconcileHubHostTargetContribution({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      policy: prepared.policy,
      clock: silentClock(),
    });
    expect(diverged?.imported).toBe(true);
    expect(diverged?.relation).toBe("diverged");
    const after = await gitText(prepared.repoDir, [
      "rev-parse",
      prepared.policy.publishTargetRef,
    ]);
    expect(
      await gitText(prepared.repoDir, [
        "merge-base",
        "--is-ancestor",
        diverged?.hostOid ?? "",
        after,
      ]),
    ).toBe("");

    const behindClass = await classifyHubHostTargetRelation({
      repoRoot: prepared.repoDir,
      policy: prepared.policy,
    });
    expect(behindClass.relation).toBe("behind");
    const behind = await reconcileHubHostTargetContribution({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      policy: prepared.policy,
      clock: silentClock(),
    });
    expect(behind?.imported).toBe(false);
    expect(behind?.relation).toBe("behind");
  });

  it("classifies a deterministic add/add host merge conflict as host_contribution_conflict, not target_quiet_wait", async () => {
    const prepared = await prepareRepo("host-add-add");
    await execFileAsync("git", ["checkout", "-b", "pub-side"], {
      cwd: prepared.repoDir,
    });
    await commitFile(
      prepared.repoDir,
      "README.md",
      "publish readme\n",
      "publish readme",
    );
    const publishOid = await gitText(prepared.repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync(
      "git",
      ["update-ref", prepared.policy.publishTargetRef, publishOid],
      { cwd: prepared.repoDir },
    );
    await execFileAsync("git", ["checkout", "main"], {
      cwd: prepared.repoDir,
    });
    await commitFile(
      prepared.repoDir,
      "README.md",
      "host readme\n",
      "host readme",
    );
    await commitFile(
      prepared.repoDir,
      ".gitignore",
      "host-ignore\n",
      "host gitignore",
    );
    expect(
      (
        await classifyHubHostTargetRelation({
          repoRoot: prepared.repoDir,
          policy: prepared.policy,
        })
      ).relation,
    ).toBe("diverged");

    const result = await reconcileHubHostTargetContribution({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      policy: prepared.policy,
      clock: silentClock(),
    });

    expect(result?.imported).toBe(false);
    expect(result?.pending).toBe(true);
    expect(result?.pendingReason).toBe("host_contribution_conflict");
    expect(result?.message).toMatch(/host contribution/i);
    expect(result?.message).toMatch(/conflict/i);
    expect(result?.message).not.toMatch(/target_quiet_wait|quiet wait/i);
    expect(result?.message).toMatch(/does not require a recovery command/i);
    expect(result?.message).toMatch(/resolve|rerun|archloop run/i);
  });
});

describe("Hub target quiet wait", () => {
  it("enters target_quiet_wait after three drift rebuilds, refuses overtaking, and resumes on a stable window", async () => {
    const prepared = await prepareRepo("quiet");
    const branchA = await addTaskBranch(
      prepared.repoDir,
      "head",
      "head.txt",
      "head\n",
    );
    const branchB = await addTaskBranch(
      prepared.repoDir,
      "later",
      "later.txt",
      "later\n",
    );
    assignHubLandingQueueTickets({
      hubProjectDir: prepared.hubProjectDir,
      publishTargetRef: prepared.policy.publishTargetRef,
      tasks: [{ taskId: "bd-head" }, { taskId: "bd-later" }],
      clock: silentClock(),
    });
    const candidate = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-head",
      branch: branchA,
    });
    bindCandidate(
      prepared.hubProjectDir,
      prepared.repoDir,
      prepared.fingerprint,
      candidate,
    );
    recordHubLandingRepairAttempt({
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-head",
      sourceOid: candidate.sourceOid,
      kind: "verification",
      fingerprint: candidate.candidateOid,
      candidateOid: candidate.candidateOid,
      candidateGeneration: 1,
    });
    const remainingBefore = remainingHubLandingRepairAttempts({
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-head",
      sourceOid: candidate.sourceOid,
      kind: "verification",
    });

    await driftPublishTarget(
      prepared.repoDir,
      prepared.policy.publishTargetRef,
      "pre-drift.txt",
      "pre\n",
    );

    let driftCount = 0;
    const outcome = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-head",
      branch: branchA,
      candidate,
      verifierFingerprint: prepared.fingerprint,
      clock: silentClock(),
      rebuild: async () => {
        const next = await createHubLandingCandidate({
          repoRoot: prepared.repoDir,
          hubProjectDir: prepared.hubProjectDir,
          taskId: "bd-head",
          branch: branchA,
        });
        bindCandidate(
          prepared.hubProjectDir,
          prepared.repoDir,
          prepared.fingerprint,
          next,
        );
        driftCount += 1;
        await driftPublishTarget(
          prepared.repoDir,
          prepared.policy.publishTargetRef,
          `drift-${driftCount}.txt`,
          `drift ${driftCount}\n`,
        );
        return next;
      },
    });
    expect(outcome.kind).toBe("target_quiet_wait");
    if (outcome.kind === "target_quiet_wait") {
      expect(outcome.message).toContain(HUB_TARGET_QUIET_WAIT);
      expect(outcome.message).not.toMatch(/tasks recover/i);
    }
    expect(driftCount).toBe(HUB_LANDING_TARGET_DRIFT_REBUILD_LIMIT);
    const queue = readHubLandingQueue(prepared.hubProjectDir);
    expect(queue?.tickets[0]?.status).toBe("target_quiet_wait");
    expect(queue?.tickets[0]?.sequence).toBe(1);

    const later = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-later",
      branch: branchB,
    });
    bindCandidate(
      prepared.hubProjectDir,
      prepared.repoDir,
      prepared.fingerprint,
      later,
    );
    const overtake = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-later",
      branch: branchB,
      candidate: later,
      verifierFingerprint: prepared.fingerprint,
      clock: silentClock(),
    });
    expect(overtake.kind).toBe("not_queue_head");
    if (overtake.kind === "not_queue_head") {
      expect(overtake.message).not.toMatch(/tasks recover/i);
    }

    const resumed = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-head",
      branch: branchA,
      verifierFingerprint: prepared.fingerprint,
      clock: silentClock(),
    });
    expect(resumed.kind).toBe("landed");
    if (resumed.kind !== "landed") {
      return;
    }
    expect(
      remainingHubLandingRepairAttempts({
        hubProjectDir: prepared.hubProjectDir,
        taskId: "bd-head",
        sourceOid: candidate.sourceOid,
        kind: "verification",
      }),
    ).toBe(remainingBefore);
    expect(
      loadHubLandingTransaction(
        prepared.hubProjectDir,
        resumed.candidate.transactionId,
      )?.checkpoint,
    ).toBe("target_landed");
    expect(
      readHubLandingReceipt(prepared.repoDir, resumed.candidate.transactionId)
        ?.receipt.candidateOid,
    ).toBe(resumed.candidate.candidateOid);
    expect(readHubLandingQueue(prepared.hubProjectDir)?.tickets[0]?.status).toBe(
      "landed",
    );
  });

  it("does not busy-loop when the target keeps moving during quiet wait", async () => {
    const prepared = await prepareRepo("quiet-churn");
    const branch = await addTaskBranch(
      prepared.repoDir,
      "churn",
      "c.txt",
      "c\n",
    );
    const candidate = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-churn",
      branch,
    });
    bindCandidate(
      prepared.hubProjectDir,
      prepared.repoDir,
      prepared.fingerprint,
      candidate,
    );
    let sleeps = 0;
    const clock: HubLandingQueueClock = {
      now: () => new Date("2026-08-14T18:00:00.000Z"),
      sleep: async () => {
        sleeps += 1;
      },
      random: () => 0.5,
    };
    await driftPublishTarget(
      prepared.repoDir,
      prepared.policy.publishTargetRef,
      "pre-churn.txt",
      "pre\n",
    );
    const first = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-churn",
      branch,
      candidate,
      verifierFingerprint: prepared.fingerprint,
      clock,
      rebuild: async () => {
        const next = await createHubLandingCandidate({
          repoRoot: prepared.repoDir,
          hubProjectDir: prepared.hubProjectDir,
          taskId: "bd-churn",
          branch,
        });
        bindCandidate(
          prepared.hubProjectDir,
          prepared.repoDir,
          prepared.fingerprint,
          next,
        );
        await driftPublishTarget(
          prepared.repoDir,
          prepared.policy.publishTargetRef,
          `more-${sleeps}.txt`,
          "more\n",
        );
        return next;
      },
    });
    expect(first.kind).toBe("target_quiet_wait");
    const sleepsAfterEnter = sleeps;
    await driftPublishTarget(
      prepared.repoDir,
      prepared.policy.publishTargetRef,
      "still-moving.txt",
      "move\n",
    );
    const waiting = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-churn",
      branch,
      candidate,
      verifierFingerprint: prepared.fingerprint,
      clock,
    });
    expect(waiting.kind).toBe("target_quiet_wait");
    expect(sleeps).toBe(sleepsAfterEnter);
  });
});

describe("Hub required delivery ordering", () => {
  it("blocks successor local landing until the predecessor leaves publishing", async () => {
    const prepared = await prepareRepo("req-fifo");
    const { configureHubLandingPolicy } = await import("./hubLandingPolicy.js");
    configureHubLandingPolicy({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      publishPolicy: "required",
      remoteTarget: "origin/main",
    });
    assignHubLandingQueueTickets({
      hubProjectDir: prepared.hubProjectDir,
      publishTargetRef: prepared.policy.publishTargetRef,
      tasks: [{ taskId: "bd-first" }, { taskId: "bd-second" }],
      clock: silentClock(),
    });
    markHubLandingQueuePublishing(prepared.hubProjectDir, "bd-first");

    expect(
      resolveRequiredDeliveryPredecessor({
        hubProjectDir: prepared.hubProjectDir,
        taskId: "bd-second",
      })?.taskId,
    ).toBe("bd-first");
    expect(
      canLandHubLandingTicket({
        hubProjectDir: prepared.hubProjectDir,
        taskId: "bd-second",
      }),
    ).toBe(false);
    expect(
      selectHubSpeculativeChain(
        readHubLandingQueue(prepared.hubProjectDir),
        new Set(),
      ).map((ticket) => ticket.taskId),
    ).toEqual(["bd-second"]);

    markHubLandingQueueLanded(prepared.hubProjectDir, "bd-first");
    expect(
      canLandHubLandingTicket({
        hubProjectDir: prepared.hubProjectDir,
        taskId: "bd-second",
      }),
    ).toBe(true);
  });
});

describe("Hub landing queue crash recovery", () => {
  it("reconstructs queue-head landing after CAS crash without duplicating the receipt", async () => {
    const prepared = await prepareRepo("crash");
    const branch = await addTaskBranch(
      prepared.repoDir,
      "crash",
      "x.txt",
      "x\n",
    );
    const candidate = await createHubLandingCandidate({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-crash",
      branch,
    });
    bindCandidate(
      prepared.hubProjectDir,
      prepared.repoDir,
      prepared.fingerprint,
      candidate,
    );
    await expect(
      coordinateHubQueueHeadLanding({
        repoRoot: prepared.repoDir,
        hubProjectDir: prepared.hubProjectDir,
        taskId: "bd-crash",
        branch,
        candidate,
        verifierFingerprint: prepared.fingerprint,
        clock: silentClock(),
        faultInjection: { crashAfter: "atomic_landing" },
      }),
    ).rejects.toBeInstanceOf(HubLandingCrash);

    const resumed = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: "bd-crash",
      branch,
      candidate,
      verifierFingerprint: prepared.fingerprint,
      clock: silentClock(),
    });
    expect(resumed.kind).toBe("landed");
    const receipts = (
      await gitText(prepared.repoDir, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/archloop/receipts/",
      ])
    )
      .split("\n")
      .filter((line) => line.length > 0);
    expect(receipts).toEqual([
      `refs/archloop/receipts/${candidate.transactionId}`,
    ]);
  });
});
