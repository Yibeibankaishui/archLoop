import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  HubLandingCrash,
  bindHubLandingVerification,
  computeHubVerifierFingerprint,
  createHubLandingCandidate,
  readHubLandingReceipt,
  readHubLandingVerificationArtifact,
} from "./hubLanding.js";
import {
  acquireHubLandingLease,
  coordinateHubQueueHeadLanding,
  isLiveHubLandingLeaseOwner,
  landHubCandidateWithLease,
  readHubLandingLease,
  type HubLandingLeaseProbe,
} from "./hubLandingCoordinator.js";
import { ensureHubLandingPolicy } from "./hubLandingPolicy.js";
import { loadHubLandingTransaction } from "./hubLandingTransaction.js";

const execFileAsync = promisify(execFile);

const gitText = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
};

const gitWithStdin = (cwd: string, args: readonly string[], input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout).trim());
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });

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

const createProbe = (
  overrides: Partial<HubLandingLeaseProbe> & {
    readonly pid?: number;
    readonly processStartIdentity?: string;
    readonly bootIdentity?: string;
    readonly alive?: ReadonlySet<number>;
  } = {},
): HubLandingLeaseProbe => {
  const pid = overrides.pid ?? 4242;
  const processStartIdentity =
    overrides.processStartIdentity ?? `${pid}:1000`;
  const bootIdentity = overrides.bootIdentity ?? "boot-a";
  const alive = overrides.alive ?? new Set([pid]);
  return {
    now: overrides.now ?? (() => new Date("2026-08-14T16:00:00.000Z")),
    createNonce: overrides.createNonce ?? (() => "nonce-self"),
    readIdentity: overrides.readIdentity ?? (() => ({
      pid,
      processStartIdentity,
      bootIdentity,
    })),
    readProcessStartIdentity:
      overrides.readProcessStartIdentity ??
      ((observedPid) =>
        observedPid === pid ? processStartIdentity : `${observedPid}:other`),
    isProcessAlive:
      overrides.isProcessAlive ?? ((observedPid) => alive.has(observedPid)),
    readBootIdentity: overrides.readBootIdentity ?? (() => bootIdentity),
  };
};

const preparePolicy = async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-landing-lease-"));
  const repoDir = join(root, "repo");
  const hubProjectDir = join(root, "hub-project");
  await mkdir(repoDir, { recursive: true });
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello\n", "init");
  const policy = ensureHubLandingPolicy({
    repoRoot: repoDir,
    hubProjectDir,
  }).policy;
  const targetOid = await gitText(repoDir, [
    "rev-parse",
    policy.publishTargetRef,
  ]);
  const fenceOid = await gitText(repoDir, ["rev-parse", policy.fenceRef]);
  return { repoDir, hubProjectDir, policy, targetOid, fenceOid };
};

describe("Hub landing lease", () => {
  it("identifies the owner with a nonce, process start identity, and boot identity", async () => {
    const { repoDir, hubProjectDir, policy, targetOid, fenceOid } =
      await preparePolicy();
    const probe = createProbe();

    const acquired = await acquireHubLandingLease({
      repoRoot: repoDir,
      hubProjectDir,
      policy,
      probe,
    });

    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      return;
    }
    expect(acquired.lease.ownerNonce).toBe("nonce-self");
    expect(acquired.lease.pid).toBe(4242);
    expect(acquired.lease.processStartIdentity).toBe("4242:1000");
    expect(acquired.lease.bootIdentity).toBe("boot-a");
    expect(acquired.lease.expectedTargetOid).toBe(targetOid);
    expect(acquired.lease.expectedFenceOid).toBe(fenceOid);
    expect(readHubLandingLease(hubProjectDir)).toEqual(acquired.lease);
    expect(
      isLiveHubLandingLeaseOwner(acquired.lease, probe),
    ).toBe(true);
  });

  it("does not steal a lease from a demonstrably live owner only because a TTL elapsed", async () => {
    const { repoDir, hubProjectDir, policy } = await preparePolicy();
    const liveOwner = createProbe({
      pid: 111,
      processStartIdentity: "111:9",
      bootIdentity: "boot-a",
      createNonce: () => "nonce-live",
    });
    const first = await acquireHubLandingLease({
      repoRoot: repoDir,
      hubProjectDir,
      policy,
      probe: liveOwner,
    });
    expect(first.status).toBe("acquired");

    const later = new Date("2026-08-14T16:10:00.000Z");
    const challenger = createProbe({
      pid: 222,
      processStartIdentity: "222:8",
      bootIdentity: "boot-a",
      createNonce: () => "nonce-challenger",
      now: () => later,
      readProcessStartIdentity: (pid) =>
        pid === 111 ? "111:9" : pid === 222 ? "222:8" : undefined,
      isProcessAlive: (pid) => pid === 111 || pid === 222,
    });

    const stolen = await acquireHubLandingLease({
      repoRoot: repoDir,
      hubProjectDir,
      policy,
      probe: challenger,
    });

    expect(stolen.status).toBe("pending_contention");
    if (stolen.status !== "pending_contention") {
      return;
    }
    expect(stolen.owner.ownerNonce).toBe("nonce-live");
    expect(stolen.owner.pid).toBe(111);
    expect(readHubLandingLease(hubProjectDir)?.ownerNonce).toBe("nonce-live");
  });

  it("takes over a dead owner's lease", async () => {
    const { repoDir, hubProjectDir, policy } = await preparePolicy();
    const dead = createProbe({
      pid: 111,
      processStartIdentity: "111:9",
      createNonce: () => "nonce-dead",
      alive: new Set(),
    });
    expect(
      (
        await acquireHubLandingLease({
          repoRoot: repoDir,
          hubProjectDir,
          policy,
          probe: dead,
        })
      ).status,
    ).toBe("acquired");

    const successor = createProbe({
      pid: 222,
      processStartIdentity: "222:8",
      createNonce: () => "nonce-successor",
      readProcessStartIdentity: (pid) =>
        pid === 222 ? "222:8" : pid === 111 ? "111:9" : undefined,
      isProcessAlive: (pid) => pid === 222,
    });
    const acquired = await acquireHubLandingLease({
      repoRoot: repoDir,
      hubProjectDir,
      policy,
      probe: successor,
    });
    expect(acquired.status).toBe("acquired");
    expect(readHubLandingLease(hubProjectDir)?.ownerNonce).toBe(
      "nonce-successor",
    );
  });

  it("treats PID reuse as a dead owner", async () => {
    const { repoDir, hubProjectDir, policy } = await preparePolicy();
    await acquireHubLandingLease({
      repoRoot: repoDir,
      hubProjectDir,
      policy,
      probe: createProbe({
        pid: 111,
        processStartIdentity: "111:9",
        createNonce: () => "nonce-old",
      }),
    });

    const reused = createProbe({
      pid: 222,
      processStartIdentity: "222:8",
      createNonce: () => "nonce-reused",
      readProcessStartIdentity: (pid) =>
        pid === 111 ? "111:99" : pid === 222 ? "222:8" : undefined,
      isProcessAlive: (pid) => pid === 111 || pid === 222,
    });
    const acquired = await acquireHubLandingLease({
      repoRoot: repoDir,
      hubProjectDir,
      policy,
      probe: reused,
    });
    expect(acquired.status).toBe("acquired");
    expect(readHubLandingLease(hubProjectDir)?.ownerNonce).toBe("nonce-reused");
  });

  it("treats a boot identity change as a dead owner", async () => {
    const { repoDir, hubProjectDir, policy } = await preparePolicy();
    await acquireHubLandingLease({
      repoRoot: repoDir,
      hubProjectDir,
      policy,
      probe: createProbe({
        pid: 111,
        processStartIdentity: "111:9",
        bootIdentity: "boot-a",
        createNonce: () => "nonce-pre-reboot",
      }),
    });

    const afterReboot = createProbe({
      pid: 222,
      processStartIdentity: "222:1",
      bootIdentity: "boot-b",
      createNonce: () => "nonce-post-reboot",
      readProcessStartIdentity: (pid) =>
        pid === 111 ? "111:9" : pid === 222 ? "222:1" : undefined,
      isProcessAlive: (pid) => pid === 111 || pid === 222,
      readBootIdentity: () => "boot-b",
    });
    const acquired = await acquireHubLandingLease({
      repoRoot: repoDir,
      hubProjectDir,
      policy,
      probe: afterReboot,
    });
    expect(acquired.status).toBe("acquired");
    expect(readHubLandingLease(hubProjectDir)?.bootIdentity).toBe("boot-b");
  });
});

const prepareLandableTask = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `hub-landing-${label}-`));
  const repoDir = join(root, "repo");
  const hubProjectDir = join(root, "hub-project");
  await mkdir(repoDir, { recursive: true });
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello\n", "init");
  const branch = `archloop/bd-${label}`;
  await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
  await commitFile(repoDir, "feature.txt", `${label}\n`, "feature");
  await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });
  const policy = ensureHubLandingPolicy({
    repoRoot: repoDir,
    hubProjectDir,
  }).policy;
  const candidate = await createHubLandingCandidate({
    repoRoot: repoDir,
    hubProjectDir,
    taskId: `bd-${label}`,
    branch,
  });
  const fingerprint = computeHubVerifierFingerprint(repoDir);
  bindHubLandingVerification({
    hubProjectDir,
    transactionId: candidate.transactionId,
    taskId: candidate.taskId,
    candidateOid: candidate.candidateOid,
    verifierFingerprint: fingerprint,
    repoRoot: repoDir,
  });
  return {
    repoDir,
    hubProjectDir,
    policy,
    branch,
    candidate,
    fingerprint,
  };
};

describe("Hub landing coordinator fencing", () => {
  it("rejects a stale owner after fence replacement", async () => {
    const prepared = await prepareLandableTask("stale-fence");
    const owner = createProbe({
      pid: 111,
      processStartIdentity: "111:1",
      createNonce: () => "nonce-stale",
    });
    const acquired = await acquireHubLandingLease({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      policy: prepared.policy,
      probe: owner,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      return;
    }

    const newFenceOid = await gitWithStdin(
      prepared.repoDir,
      ["hash-object", "-w", "--stdin"],
      '{"kind":"replaced"}\n',
    );
    await execFileAsync(
      "git",
      ["update-ref", prepared.policy.fenceRef, newFenceOid],
      { cwd: prepared.repoDir },
    );

    const outcome = await landHubCandidateWithLease({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      candidate: prepared.candidate,
      verifierFingerprint: prepared.fingerprint,
      probe: owner,
      lease: acquired.lease,
    });
    expect(outcome.kind).toBe("stale_owner_rejected");
    expect(outcome.expectedFenceOid).toBe(acquired.lease.expectedFenceOid);
    expect(outcome.observedFenceOid).toBe(newFenceOid);
    expect(
      await gitText(prepared.repoDir, [
        "rev-parse",
        prepared.policy.publishTargetRef,
      ]),
    ).not.toBe(prepared.candidate.candidateOid);
  });

  it("rejects target ABA when the fence OID changed even if the target OID returned", async () => {
    const prepared = await prepareLandableTask("aba");
    const originalTarget = prepared.candidate.baseOid;
    const owner = createProbe({
      pid: 111,
      processStartIdentity: "111:1",
      createNonce: () => "nonce-aba",
    });
    const acquired = await acquireHubLandingLease({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      policy: prepared.policy,
      probe: owner,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      return;
    }

    await commitFile(prepared.repoDir, "drift.txt", "drift\n", "drift");
    const drifted = await gitText(prepared.repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync(
      "git",
      ["update-ref", prepared.policy.publishTargetRef, drifted],
      { cwd: prepared.repoDir },
    );
    const replacedFence = await gitWithStdin(
      prepared.repoDir,
      ["hash-object", "-w", "--stdin"],
      '{"kind":"aba-fence"}\n',
    );
    await execFileAsync(
      "git",
      ["update-ref", prepared.policy.fenceRef, replacedFence],
      { cwd: prepared.repoDir },
    );
    await execFileAsync(
      "git",
      ["update-ref", prepared.policy.publishTargetRef, originalTarget],
      { cwd: prepared.repoDir },
    );

    const outcome = await landHubCandidateWithLease({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      candidate: prepared.candidate,
      verifierFingerprint: prepared.fingerprint,
      probe: owner,
      lease: acquired.lease,
    });

    expect(await gitText(prepared.repoDir, [
      "rev-parse",
      prepared.policy.publishTargetRef,
    ])).toBe(originalTarget);
    expect(outcome.kind).toBe("stale_owner_rejected");
    expect(outcome.expectedFenceOid).toBe(acquired.lease.expectedFenceOid);
    expect(outcome.observedFenceOid).toBe(replacedFence);
  });

  it("keeps a paused live owner from landing after another owner takes the lease", async () => {
    const prepared = await prepareLandableTask("paused-owner");
    const paused = createProbe({
      pid: 111,
      processStartIdentity: "111:1",
      createNonce: () => "nonce-paused",
    });
    const acquired = await acquireHubLandingLease({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      policy: prepared.policy,
      probe: paused,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      return;
    }

    const successor = createProbe({
      pid: 222,
      processStartIdentity: "222:2",
      createNonce: () => "nonce-successor",
      isProcessAlive: (pid) => pid === 222,
      readProcessStartIdentity: (pid) =>
        pid === 222 ? "222:2" : pid === 111 ? "111:1" : undefined,
    });
    const taken = await acquireHubLandingLease({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      policy: prepared.policy,
      probe: successor,
    });
    expect(taken.status).toBe("acquired");

    const rejected = await landHubCandidateWithLease({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      candidate: prepared.candidate,
      verifierFingerprint: prepared.fingerprint,
      probe: paused,
      lease: acquired.status === "acquired" ? acquired.lease : undefined,
    });
    expect(rejected.kind).toBe("stale_owner_rejected");
  });
});

describe("Hub landing coordinator drift rebuild", () => {
  it("invalidates the stale candidate and verification artifact, rebuilds on the new target, and reverifies before CAS", async () => {
    const prepared = await prepareLandableTask("rebuild");
    const staleTransactionId = prepared.candidate.transactionId;
    const staleCandidateOid = prepared.candidate.candidateOid;
    expect(
      readHubLandingVerificationArtifact(
        prepared.hubProjectDir,
        staleTransactionId,
      )?.candidateOid,
    ).toBe(staleCandidateOid);

    await commitFile(prepared.repoDir, "host.txt", "host\n", "host drift");
    const driftedTarget = await gitText(prepared.repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync(
      "git",
      ["update-ref", prepared.policy.publishTargetRef, driftedTarget],
      { cwd: prepared.repoDir },
    );

    let verifiedOids: string[] = [];
    const outcome = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: prepared.candidate.taskId,
      branch: prepared.branch,
      candidate: prepared.candidate,
      verifierFingerprint: prepared.fingerprint,
      verify: (candidate) => {
        verifiedOids.push(candidate.candidateOid);
        bindHubLandingVerification({
          hubProjectDir: prepared.hubProjectDir,
          transactionId: candidate.transactionId,
          taskId: candidate.taskId,
          candidateOid: candidate.candidateOid,
          verifierFingerprint: prepared.fingerprint,
          repoRoot: prepared.repoDir,
        });
      },
    });

    expect(outcome.kind).toBe("landed");
    if (outcome.kind !== "landed") {
      return;
    }
    expect(outcome.candidate.baseOid).toBe(driftedTarget);
    expect(outcome.candidate.candidateOid).not.toBe(staleCandidateOid);
    expect(outcome.candidate.transactionId).not.toBe(staleTransactionId);
    expect(verifiedOids).toContain(outcome.candidate.candidateOid);
    expect(
      readHubLandingVerificationArtifact(
        prepared.hubProjectDir,
        staleTransactionId,
      ),
    ).toBeUndefined();
    expect(
      readHubLandingVerificationArtifact(
        prepared.hubProjectDir,
        outcome.candidate.transactionId,
      )?.candidateOid,
    ).toBe(outcome.candidate.candidateOid);
    expect(
      await gitText(prepared.repoDir, [
        "rev-parse",
        prepared.policy.publishTargetRef,
      ]),
    ).toBe(outcome.candidate.candidateOid);
    expect(
      loadHubLandingTransaction(
        prepared.hubProjectDir,
        outcome.candidate.transactionId,
      )?.checkpoint,
    ).toBe("target_landed");
  });

  it("does not land a stale verification artifact after rebuild", async () => {
    const prepared = await prepareLandableTask("stale-artifact");
    await commitFile(prepared.repoDir, "host.txt", "host\n", "host drift");
    await execFileAsync(
      "git",
      [
        "update-ref",
        prepared.policy.publishTargetRef,
        await gitText(prepared.repoDir, ["rev-parse", "HEAD"]),
      ],
      { cwd: prepared.repoDir },
    );

    const outcome = await coordinateHubQueueHeadLanding({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      taskId: prepared.candidate.taskId,
      branch: prepared.branch,
      candidate: prepared.candidate,
      verifierFingerprint: prepared.fingerprint,
    });
    expect(outcome.kind).toBe("landed");
    if (outcome.kind !== "landed") {
      return;
    }
    expect(
      readHubLandingVerificationArtifact(
        prepared.hubProjectDir,
        prepared.candidate.transactionId,
      ),
    ).toBeUndefined();
    expect(outcome.candidate.candidateOid).not.toBe(
      prepared.candidate.candidateOid,
    );
  });
});

describe("Hub landing coordinator concurrency", () => {
  it("converges two simultaneous landings of the same task to one receipt", async () => {
    const prepared = await prepareLandableTask("same-task");
    const [first, second] = await Promise.all([
      coordinateHubQueueHeadLanding({
        repoRoot: prepared.repoDir,
        hubProjectDir: prepared.hubProjectDir,
        taskId: prepared.candidate.taskId,
        branch: prepared.branch,
        candidate: prepared.candidate,
        verifierFingerprint: prepared.fingerprint,
      }),
      coordinateHubQueueHeadLanding({
        repoRoot: prepared.repoDir,
        hubProjectDir: prepared.hubProjectDir,
        taskId: prepared.candidate.taskId,
        branch: prepared.branch,
        candidate: prepared.candidate,
        verifierFingerprint: prepared.fingerprint,
      }),
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toContain("landed");
    expect(kinds.every((kind) => kind === "landed" || kind === "pending_contention" || kind === "stale_owner_rejected")).toBe(true);
    expect(
      await gitText(prepared.repoDir, [
        "rev-parse",
        prepared.policy.publishTargetRef,
      ]),
    ).toBe(prepared.candidate.candidateOid);
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
      `refs/archloop/receipts/${prepared.candidate.transactionId}`,
    ]);
    const receipt = readHubLandingReceipt(
      prepared.repoDir,
      prepared.candidate.transactionId,
    );
    expect(receipt?.receipt.candidateOid).toBe(prepared.candidate.candidateOid);
  });

  it("lets the second project run rebuild after the first lands a different candidate base", async () => {
    const first = await prepareLandableTask("project-a");
    await commitFile(first.repoDir, "other.txt", "other\n", "second task");
    const secondBranch = "archloop/bd-project-b";
    await execFileAsync("git", ["checkout", "-b", secondBranch], {
      cwd: first.repoDir,
    });
    await commitFile(first.repoDir, "second.txt", "second\n", "second feature");
    await execFileAsync("git", ["checkout", "main"], { cwd: first.repoDir });
    const secondCandidate = await createHubLandingCandidate({
      repoRoot: first.repoDir,
      hubProjectDir: first.hubProjectDir,
      taskId: "bd-project-b",
      branch: secondBranch,
    });
    bindHubLandingVerification({
      hubProjectDir: first.hubProjectDir,
      transactionId: secondCandidate.transactionId,
      taskId: secondCandidate.taskId,
      candidateOid: secondCandidate.candidateOid,
      verifierFingerprint: first.fingerprint,
      repoRoot: first.repoDir,
    });

    const landed = await coordinateHubQueueHeadLanding({
      repoRoot: first.repoDir,
      hubProjectDir: first.hubProjectDir,
      taskId: first.candidate.taskId,
      branch: first.branch,
      candidate: first.candidate,
      verifierFingerprint: first.fingerprint,
    });
    expect(landed.kind).toBe("landed");

    const rebuilt = await coordinateHubQueueHeadLanding({
      repoRoot: first.repoDir,
      hubProjectDir: first.hubProjectDir,
      taskId: secondCandidate.taskId,
      branch: secondBranch,
      candidate: secondCandidate,
      verifierFingerprint: first.fingerprint,
    });
    expect(rebuilt.kind).toBe("landed");
    if (rebuilt.kind !== "landed") {
      return;
    }
    expect(rebuilt.candidate.baseOid).toBe(first.candidate.candidateOid);
    expect(rebuilt.candidate.transactionId).not.toBe(
      secondCandidate.transactionId,
    );
  });

  it("reports live-owner contention as pending instead of a semantic failure", async () => {
    const prepared = await prepareLandableTask("contention");
    const live = createProbe({
      pid: 111,
      processStartIdentity: "111:1",
      createNonce: () => "nonce-live",
    });
    expect(
      (
        await acquireHubLandingLease({
          repoRoot: prepared.repoDir,
          hubProjectDir: prepared.hubProjectDir,
          policy: prepared.policy,
          probe: live,
        })
      ).status,
    ).toBe("acquired");

    const outcome = await landHubCandidateWithLease({
      repoRoot: prepared.repoDir,
      hubProjectDir: prepared.hubProjectDir,
      candidate: prepared.candidate,
      verifierFingerprint: prepared.fingerprint,
      probe: createProbe({
        pid: 222,
        processStartIdentity: "222:2",
        createNonce: () => "nonce-waiter",
        readProcessStartIdentity: (pid) =>
          pid === 111 ? "111:1" : pid === 222 ? "222:2" : undefined,
        isProcessAlive: (pid) => pid === 111 || pid === 222,
      }),
    });
    expect(outcome.kind).toBe("pending_contention");
    if (outcome.kind !== "pending_contention") {
      return;
    }
    expect(outcome.message).not.toMatch(/tasks recover/i);
    expect(
      await gitText(prepared.repoDir, [
        "rev-parse",
        prepared.policy.publishTargetRef,
      ]),
    ).toBe(prepared.candidate.baseOid);
  });

  it("continues automatically after lease and CAS fault injection", async () => {
    for (const crash of [
      { crashBefore: "landing_lease" as const },
      { crashAfter: "landing_lease" as const },
      { crashBefore: "atomic_landing" as const },
      { crashAfter: "atomic_landing" as const },
    ]) {
      const prepared = await prepareLandableTask(
        `fault-${crash.crashBefore ?? crash.crashAfter}`,
      );
      try {
        await coordinateHubQueueHeadLanding({
          repoRoot: prepared.repoDir,
          hubProjectDir: prepared.hubProjectDir,
          taskId: prepared.candidate.taskId,
          branch: prepared.branch,
          candidate: prepared.candidate,
          verifierFingerprint: prepared.fingerprint,
          faultInjection: crash,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(HubLandingCrash);
      }
      const resumed = await coordinateHubQueueHeadLanding({
        repoRoot: prepared.repoDir,
        hubProjectDir: prepared.hubProjectDir,
        taskId: prepared.candidate.taskId,
        branch: prepared.branch,
        candidate: prepared.candidate,
        verifierFingerprint: prepared.fingerprint,
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
        `refs/archloop/receipts/${prepared.candidate.transactionId}`,
      ]);
    }
  });
});
