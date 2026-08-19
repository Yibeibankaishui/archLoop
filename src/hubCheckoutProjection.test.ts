import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  HubLandingCrash,
  bindHubLandingVerification,
  cleanupHubLandingCandidate,
  commitHubLandingTarget,
  computeHubVerifierFingerprint,
  createHubLandingCandidate,
} from "./hubLanding.js";
import { ensureHubLandingPolicy } from "./hubLandingPolicy.js";
import { deriveHubLandingShipped } from "./hubLandingTransaction.js";
import {
  classifyHostPublishBranchRelation,
  enqueueHubCheckoutProjection,
  inspectHubCheckoutOutbox,
  listHubCheckoutOutboxItems,
  projectHubCheckoutOutbox,
  resolveHubCheckoutProjectionId,
} from "./hubCheckoutProjection.js";

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

const gitOk = async (
  cwd: string,
  args: readonly string[],
): Promise<boolean> => {
  try {
    await gitText(cwd, args);
    return true;
  } catch {
    return false;
  }
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

const captureCheckout = async (repoDir: string) => {
  const head = await gitText(repoDir, ["rev-parse", "HEAD"]);
  const branch = await gitText(repoDir, ["branch", "--show-current"]);
  const status = await gitText(repoDir, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const index = await gitText(repoDir, ["ls-files", "-s"]);
  const diff = await gitText(repoDir, ["diff"]);
  const cached = await gitText(repoDir, ["diff", "--cached"]);
  return { head, branch, status, index, diff, cached };
};

const installHook = async (
  repoDir: string,
  name: string,
  markerPath: string,
) => {
  const hookPath = join(repoDir, ".git", "hooks", name);
  await writeFile(
    hookPath,
    `#!/bin/sh\necho ${name} >> ${JSON.stringify(markerPath)}\n`,
  );
  await chmod(hookPath, 0o755);
};

const prepareLandedFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `hub-checkout-${label}-`));
  const repoDir = join(root, "repo");
  const hubProjectDir = join(root, "hub-project");
  await mkdir(repoDir, { recursive: true });
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello\n", "init");
  const branch = `archloop/${label}`;
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
    taskId: label,
    branch,
  });
  const fingerprint = computeHubVerifierFingerprint(repoDir);
  bindHubLandingVerification({
    hubProjectDir,
    transactionId: candidate.transactionId,
    taskId: label,
    candidateOid: candidate.candidateOid,
    verifierFingerprint: fingerprint,
    repoRoot: repoDir,
  });
  const landed = await commitHubLandingTarget({
    repoRoot: repoDir,
    hubProjectDir,
    candidate,
    verifierFingerprint: fingerprint,
  });
  await cleanupHubLandingCandidate({
    repoRoot: repoDir,
    hubProjectDir,
    candidate,
  });
  return {
    root,
    repoDir,
    hubProjectDir,
    policy,
    candidate,
    landed,
    taskId: label,
  };
};

describe("Hub checkout projection outbox", () => {
  it("enqueues an idempotent projection from landing without updating the worktree", async () => {
    const fixture = await prepareLandedFixture("bd-enqueue");
    await writeFile(join(fixture.repoDir, "wip.txt"), "wip\n");
    const before = await captureCheckout(fixture.repoDir);

    const first = enqueueHubCheckoutProjection({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });
    const second = enqueueHubCheckoutProjection({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    expect(second.id).toBe(first.id);
    expect(first.id).toBe(
      resolveHubCheckoutProjectionId({
        transactionId: fixture.candidate.transactionId,
        hostTargetBranch: fixture.policy.hostTargetBranch,
        candidateOid: fixture.candidate.candidateOid,
      }),
    );
    expect(first.status).toBe("pending");
    expect(await captureCheckout(fixture.repoDir)).toEqual(before);
    expect(await gitText(fixture.repoDir, ["rev-parse", "HEAD"])).not.toBe(
      fixture.candidate.candidateOid,
    );
    expect(
      await gitText(fixture.repoDir, [
        "rev-parse",
        fixture.policy.publishTargetRef,
      ]),
    ).toBe(fixture.candidate.candidateOid);
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: true,
        transactionId: fixture.candidate.transactionId,
        closedTransactionId: fixture.candidate.transactionId,
        candidateOid: fixture.candidate.candidateOid,
        closedCandidateOid: fixture.candidate.candidateOid,
        publishTargetOid: fixture.candidate.candidateOid,
      }).shipped,
    ).toBe(true);
  });

  it("fast-forwards a clean checked-out host branch and suppresses hooks", async () => {
    const fixture = await prepareLandedFixture("bd-clean-ff");
    const marker = join(fixture.root, "hooks.log");
    await installHook(fixture.repoDir, "post-merge", marker);
    await installHook(fixture.repoDir, "post-checkout", marker);
    await installHook(fixture.repoDir, "reference-transaction", marker);
    enqueueHubCheckoutProjection({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    const outcome = await projectHubCheckoutOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.pendingCount).toBe(0);
    expect(outcome.attempts[0]?.status).toBe("succeeded");
    expect(await gitText(fixture.repoDir, ["rev-parse", "HEAD"])).toBe(
      fixture.candidate.candidateOid,
    );
    expect(await gitText(fixture.repoDir, ["branch", "--show-current"])).toBe(
      "main",
    );
    await expect(
      readFile(join(fixture.repoDir, "feature.txt"), "utf8"),
    ).resolves.toBe("bd-clean-ff\n");
    expect(existsSync(marker)).toBe(false);
  });

  it("advances an un-checked-out host branch through OID CAS", async () => {
    const fixture = await prepareLandedFixture("bd-cas");
    await execFileAsync("git", ["checkout", "-b", "scratch"], {
      cwd: fixture.repoDir,
    });
    await writeFile(join(fixture.repoDir, "scratch-wip.txt"), "keep me\n");
    const before = await captureCheckout(fixture.repoDir);
    enqueueHubCheckoutProjection({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    const outcome = await projectHubCheckoutOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.attempts[0]?.status).toBe("succeeded");
    expect(
      await gitText(fixture.repoDir, ["rev-parse", "refs/heads/main"]),
    ).toBe(fixture.candidate.candidateOid);
    expect(await captureCheckout(fixture.repoDir)).toEqual(before);
    await expect(
      readFile(join(fixture.repoDir, "scratch-wip.txt"), "utf8"),
    ).resolves.toBe("keep me\n");
    await expect(
      readFile(join(fixture.repoDir, "feature.txt"), "utf8"),
    ).rejects.toBeTruthy();
  });

  it("fast-forwards only the owning worktree when the host branch is checked out there", async () => {
    const fixture = await prepareLandedFixture("bd-owner-wt");
    await execFileAsync("git", ["checkout", "-b", "scratch"], {
      cwd: fixture.repoDir,
    });
    const ownerDir = join(fixture.root, "main-wt");
    await execFileAsync("git", ["worktree", "add", ownerDir, "main"], {
      cwd: fixture.repoDir,
    });
    enqueueHubCheckoutProjection({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    const outcome = await projectHubCheckoutOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.attempts[0]?.status).toBe("succeeded");
    expect(await gitText(ownerDir, ["rev-parse", "HEAD"])).toBe(
      fixture.candidate.candidateOid,
    );
    expect(await gitText(fixture.repoDir, ["branch", "--show-current"])).toBe(
      "scratch",
    );
    await expect(
      readFile(join(ownerDir, "feature.txt"), "utf8"),
    ).resolves.toBe("bd-owner-wt\n");
    await expect(
      readFile(join(fixture.repoDir, "feature.txt"), "utf8"),
    ).rejects.toBeTruthy();
  });

  it("retains pending when the host branch is checked out in multiple worktrees", async () => {
    const fixture = await prepareLandedFixture("bd-multi-wt");
    const extraDir = join(fixture.root, "main-wt-2");
    try {
      await execFileAsync(
        "git",
        ["worktree", "add", "--force", extraDir, "main"],
        { cwd: fixture.repoDir },
      );
    } catch {
      await execFileAsync(
        "git",
        ["worktree", "add", "-b", "tmp-multi", extraDir],
        { cwd: fixture.repoDir },
      );
      const gitDir = await gitText(extraDir, [
        "rev-parse",
        "--absolute-git-dir",
      ]);
      await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    }
    const beforeMain = await captureCheckout(fixture.repoDir);
    const beforeExtra = await captureCheckout(extraDir);
    enqueueHubCheckoutProjection({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    const outcome = await projectHubCheckoutOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.attempts[0]?.pendingReason).toBe("multiple_worktrees");
    expect(await captureCheckout(fixture.repoDir)).toEqual(beforeMain);
    expect(await captureCheckout(extraDir)).toEqual(beforeExtra);
    expect(await gitText(fixture.repoDir, ["rev-parse", "HEAD"])).not.toBe(
      fixture.candidate.candidateOid,
    );
    await expect(
      readFile(join(fixture.repoDir, "feature.txt"), "utf8"),
    ).rejects.toBeTruthy();
  });

  it("persists exact untracked blocking paths on the durable checkout outbox", async () => {
    const fixture = await prepareLandedFixture("bd-untracked-paths");
    await writeFile(join(fixture.repoDir, "notes.txt"), "local notes\n");
    const before = await captureCheckout(fixture.repoDir);
    enqueueHubCheckoutProjection({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    const outcome = await projectHubCheckoutOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.attempts[0]?.status).toBe("pending");
    expect(outcome.attempts[0]?.pendingReason).toBe("untracked_paths");
    expect(outcome.attempts[0]?.blockingPaths).toEqual(["notes.txt"]);
    expect(outcome.attempts[0]?.item.blockingPaths).toEqual(["notes.txt"]);
    expect(outcome.message).toContain("notes.txt");
    expect(outcome.message).toContain("commit or stash");
    expect(outcome.message).not.toMatch(/tasks recover/);
    const stored = inspectHubCheckoutOutbox({
      hubProjectDir: fixture.hubProjectDir,
    });
    expect(stored.items[0]?.blockingPaths).toEqual(["notes.txt"]);
    expect(stored.nextAction).toContain("Commit or stash");
    const raw = JSON.parse(
      await readFile(
        join(
          fixture.hubProjectDir,
          "landing",
          "checkout-outbox",
          `${stored.items[0]!.id}.json`,
        ),
        "utf8",
      ),
    ) as { blockingPaths?: unknown };
    expect(raw.blockingPaths).toEqual(["notes.txt"]);
    expect(await captureCheckout(fixture.repoDir)).toEqual(before);
    expect(
      deriveHubLandingShipped({
        publishPolicy: "off",
        taskClosed: true,
        transactionId: fixture.candidate.transactionId,
        closedTransactionId: fixture.candidate.transactionId,
        candidateOid: fixture.candidate.candidateOid,
        closedCandidateOid: fixture.candidate.candidateOid,
        publishTargetOid: fixture.candidate.candidateOid,
      }).shipped,
    ).toBe(true);
  });

  it("retains pending for dirty non-overlap, overlap, staged, untracked, and rename/delete without touching state", async () => {
    const cases: {
      readonly label: string;
      readonly reason: string | readonly string[];
      readonly blockingPaths: readonly string[];
      readonly setup: (repoDir: string) => Promise<void>;
      readonly readback: (repoDir: string) => Promise<void>;
    }[] = [
      {
        label: "nonoverlap",
        reason: "untracked_paths",
        blockingPaths: ["notes.txt"],
        setup: async (repoDir) => {
          await writeFile(join(repoDir, "notes.txt"), "local notes\n");
        },
        readback: async (repoDir) => {
          await expect(readFile(join(repoDir, "notes.txt"), "utf8")).resolves.toBe(
            "local notes\n",
          );
          await expect(
            readFile(join(repoDir, "feature.txt"), "utf8"),
          ).rejects.toBeTruthy();
        },
      },
      {
        label: "overlap",
        reason: ["unstaged_changes", "staged_changes"],
        blockingPaths: ["hello.txt"],
        setup: async (repoDir) => {
          await writeFile(join(repoDir, "hello.txt"), "dirty hello\n");
        },
        readback: async (repoDir) => {
          await expect(readFile(join(repoDir, "hello.txt"), "utf8")).resolves.toBe(
            "dirty hello\n",
          );
        },
      },
      {
        label: "staged",
        reason: "staged_changes",
        blockingPaths: ["staged.txt"],
        setup: async (repoDir) => {
          await writeFile(join(repoDir, "staged.txt"), "staged\n");
          await execFileAsync("git", ["add", "staged.txt"], { cwd: repoDir });
        },
        readback: async (repoDir) => {
          expect(await gitText(repoDir, ["show", ":staged.txt"])).toBe("staged");
        },
      },
      {
        label: "mixed",
        reason: ["untracked_paths", "staged_changes", "unstaged_changes"],
        blockingPaths: ["hello.txt", "staged.txt", "notes.txt"],
        setup: async (repoDir) => {
          await writeFile(join(repoDir, "hello.txt"), "dirty hello\n");
          await writeFile(join(repoDir, "staged.txt"), "staged\n");
          await execFileAsync("git", ["add", "staged.txt"], { cwd: repoDir });
          await writeFile(join(repoDir, "notes.txt"), "local notes\n");
        },
        readback: async (repoDir) => {
          await expect(readFile(join(repoDir, "hello.txt"), "utf8")).resolves.toBe(
            "dirty hello\n",
          );
          expect(await gitText(repoDir, ["show", ":staged.txt"])).toBe("staged");
          await expect(readFile(join(repoDir, "notes.txt"), "utf8")).resolves.toBe(
            "local notes\n",
          );
        },
      },
      {
        label: "rename",
        reason: "rename_or_delete",
        blockingPaths: ["hello.txt", "hello-renamed.txt"],
        setup: async (repoDir) => {
          await execFileAsync("git", ["mv", "hello.txt", "hello-renamed.txt"], {
            cwd: repoDir,
          });
        },
        readback: async (repoDir) => {
          expect(await gitText(repoDir, ["status", "--porcelain=v1"])).toContain(
            "hello-renamed.txt",
          );
        },
      },
      {
        label: "delete",
        reason: "rename_or_delete",
        blockingPaths: ["hello.txt"],
        setup: async (repoDir) => {
          await execFileAsync("git", ["rm", "hello.txt"], { cwd: repoDir });
        },
        readback: async (repoDir) => {
          expect(existsSync(join(repoDir, "hello.txt"))).toBe(false);
        },
      },
      {
        label: "delete-mixed",
        reason: "rename_or_delete",
        blockingPaths: ["hello.txt", "notes.txt"],
        setup: async (repoDir) => {
          await execFileAsync("git", ["rm", "hello.txt"], { cwd: repoDir });
          await writeFile(join(repoDir, "notes.txt"), "local notes\n");
        },
        readback: async (repoDir) => {
          expect(existsSync(join(repoDir, "hello.txt"))).toBe(false);
          await expect(readFile(join(repoDir, "notes.txt"), "utf8")).resolves.toBe(
            "local notes\n",
          );
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = await prepareLandedFixture(`bd-${testCase.label}`);
      await testCase.setup(fixture.repoDir);
      const before = await captureCheckout(fixture.repoDir);
      enqueueHubCheckoutProjection({
        repoRoot: fixture.repoDir,
        hubProjectDir: fixture.hubProjectDir,
        candidate: fixture.candidate,
        candidateOid: fixture.candidate.candidateOid,
      });
      const outcome = await projectHubCheckoutOutbox({
        repoRoot: fixture.repoDir,
        hubProjectDir: fixture.hubProjectDir,
      });
      expect(outcome.pendingCount, testCase.label).toBe(1);
      expect(
        Array.isArray(testCase.reason)
          ? testCase.reason
          : [testCase.reason],
        testCase.label,
      ).toContain(outcome.attempts[0]?.pendingReason);
      expect(
        [...(outcome.attempts[0]?.blockingPaths ?? [])].sort(),
        testCase.label,
      ).toEqual([...testCase.blockingPaths].sort());
      expect(outcome.message, testCase.label).toContain("Checkout sync pending");
      for (const path of testCase.blockingPaths) {
        expect(outcome.message, testCase.label).toContain(path);
      }
      expect(outcome.message, testCase.label).not.toMatch(/tasks recover/);
      const stored = inspectHubCheckoutOutbox({
        hubProjectDir: fixture.hubProjectDir,
      });
      expect(
        [...(stored.items[0]?.blockingPaths ?? [])].sort(),
        testCase.label,
      ).toEqual([...testCase.blockingPaths].sort());
      const raw = JSON.parse(
        await readFile(
          join(
            fixture.hubProjectDir,
            "landing",
            "checkout-outbox",
            `${stored.items[0]!.id}.json`,
          ),
          "utf8",
        ),
      ) as { blockingPaths?: unknown; status?: unknown };
      expect(raw.status, testCase.label).toBe("pending");
      expect(
        [...((raw.blockingPaths as string[] | undefined) ?? [])].sort(),
        testCase.label,
      ).toEqual([...testCase.blockingPaths].sort());
      expect(await captureCheckout(fixture.repoDir), testCase.label).toEqual(
        before,
      );
      await testCase.readback(fixture.repoDir);
      expect(
        deriveHubLandingShipped({
          publishPolicy: "off",
          taskClosed: true,
          transactionId: fixture.candidate.transactionId,
          closedTransactionId: fixture.candidate.transactionId,
          candidateOid: fixture.candidate.candidateOid,
          closedCandidateOid: fixture.candidate.candidateOid,
          publishTargetOid: fixture.candidate.candidateOid,
        }).shipped,
        testCase.label,
      ).toBe(true);
    }
  });

  it("retains pending for merge, rebase, cherry-pick, and bisect operation state", async () => {
    const operations: {
      readonly label: string;
      readonly setup: (repoDir: string) => Promise<void>;
    }[] = [
      {
        label: "merge",
        setup: async (repoDir) => {
          await execFileAsync(
            "git",
            ["merge", "--no-ff", "--no-commit", "archloop/bd-merge-op"],
            { cwd: repoDir },
          ).catch(() => undefined);
          if (!(await gitOk(repoDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]))) {
            await writeFile(
              join(repoDir, ".git", "MERGE_HEAD"),
              `${await gitText(repoDir, ["rev-parse", "HEAD"])}\n`,
            );
          }
        },
      },
      {
        label: "rebase",
        setup: async (repoDir) => {
          await mkdir(join(repoDir, ".git", "rebase-merge"), { recursive: true });
          await writeFile(join(repoDir, ".git", "rebase-merge", "head-name"), "main\n");
        },
      },
      {
        label: "cherry",
        setup: async (repoDir) => {
          const oid = await gitText(repoDir, ["rev-parse", "HEAD"]);
          await writeFile(join(repoDir, ".git", "CHERRY_PICK_HEAD"), `${oid}\n`);
        },
      },
      {
        label: "bisect",
        setup: async (repoDir) => {
          await execFileAsync("git", ["bisect", "start"], { cwd: repoDir });
        },
      },
    ];

    for (const operation of operations) {
      const fixture = await prepareLandedFixture(`bd-${operation.label}-op`);
      await operation.setup(fixture.repoDir);
      const before = await captureCheckout(fixture.repoDir);
      enqueueHubCheckoutProjection({
        repoRoot: fixture.repoDir,
        hubProjectDir: fixture.hubProjectDir,
        candidate: fixture.candidate,
        candidateOid: fixture.candidate.candidateOid,
      });
      const outcome = await projectHubCheckoutOutbox({
        repoRoot: fixture.repoDir,
        hubProjectDir: fixture.hubProjectDir,
      });
      expect(outcome.attempts[0]?.status, operation.label).toBe("pending");
      expect(outcome.attempts[0]?.pendingReason, operation.label).toBe(
        "operation_in_progress",
      );
      expect(await captureCheckout(fixture.repoDir), operation.label).toEqual(
        before,
      );
    }
  });

  it("retains pending for sparse-checkout, submodules, and diverged host branches", async () => {
    const fixtureSparse = await prepareLandedFixture("bd-sparse");
    await execFileAsync("git", ["sparse-checkout", "init", "--cone"], {
      cwd: fixtureSparse.repoDir,
    });
    enqueueHubCheckoutProjection({
      repoRoot: fixtureSparse.repoDir,
      hubProjectDir: fixtureSparse.hubProjectDir,
      candidate: fixtureSparse.candidate,
      candidateOid: fixtureSparse.candidate.candidateOid,
    });
    const sparse = await projectHubCheckoutOutbox({
      repoRoot: fixtureSparse.repoDir,
      hubProjectDir: fixtureSparse.hubProjectDir,
    });
    expect(sparse.attempts[0]?.pendingReason).toBe("sparse_checkout");

    const fixtureSub = await prepareLandedFixture("bd-sub");
    const gitlinkOid = await gitText(fixtureSub.repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync(
      "git",
      ["update-index", "--add", "--cacheinfo", `160000,${gitlinkOid},vendor/lib`],
      { cwd: fixtureSub.repoDir },
    );
    const beforeSub = await captureCheckout(fixtureSub.repoDir);
    enqueueHubCheckoutProjection({
      repoRoot: fixtureSub.repoDir,
      hubProjectDir: fixtureSub.hubProjectDir,
      candidate: fixtureSub.candidate,
      candidateOid: fixtureSub.candidate.candidateOid,
    });
    const sub = await projectHubCheckoutOutbox({
      repoRoot: fixtureSub.repoDir,
      hubProjectDir: fixtureSub.hubProjectDir,
    });
    expect(sub.attempts[0]?.pendingReason).toBe("submodule");
    expect(await captureCheckout(fixtureSub.repoDir)).toEqual(beforeSub);

    const fixtureDiverged = await prepareLandedFixture("bd-diverged");
    await commitFile(fixtureDiverged.repoDir, "other.txt", "other\n", "diverge");
    const hostOid = await gitText(fixtureDiverged.repoDir, ["rev-parse", "HEAD"]);
    const publishOid = await gitText(fixtureDiverged.repoDir, [
      "rev-parse",
      fixtureDiverged.policy.publishTargetRef,
    ]);
    enqueueHubCheckoutProjection({
      repoRoot: fixtureDiverged.repoDir,
      hubProjectDir: fixtureDiverged.hubProjectDir,
      candidate: fixtureDiverged.candidate,
      candidateOid: fixtureDiverged.candidate.candidateOid,
    });
    const diverged = await projectHubCheckoutOutbox({
      repoRoot: fixtureDiverged.repoDir,
      hubProjectDir: fixtureDiverged.hubProjectDir,
    });
    expect(diverged.attempts[0]?.pendingReason).toBe("branch_diverged");
    expect(diverged.attempts[0]?.branchRelation).toBe("diverged");
    expect(diverged.attempts[0]?.observedHostBranchOid).toBe(hostOid);
    expect(diverged.attempts[0]?.expectedPublishBranchOid).toBe(publishOid);
    expect(diverged.message).toContain("will not stash, reset, force-update");
    expect(diverged.message).toContain("reconcile them manually");
    expect(diverged.message).not.toMatch(/tasks recover/);
    expect(
      inspectHubCheckoutOutbox({
        hubProjectDir: fixtureDiverged.hubProjectDir,
      }).nextAction,
    ).toContain("will not stash, reset, force-update");
    expect(await gitText(fixtureDiverged.repoDir, ["rev-parse", "HEAD"])).not.toBe(
      fixtureDiverged.candidate.candidateOid,
    );
  });

  it("persists branch-relation diagnostics for ahead, behind, diverged, and missing cases", async () => {
    const behindFixture = await prepareLandedFixture("bd-rel-behind");
    await writeFile(join(behindFixture.repoDir, "notes.txt"), "local notes\n");
    enqueueHubCheckoutProjection({
      repoRoot: behindFixture.repoDir,
      hubProjectDir: behindFixture.hubProjectDir,
      candidate: behindFixture.candidate,
      candidateOid: behindFixture.candidate.candidateOid,
    });
    const behind = await projectHubCheckoutOutbox({
      repoRoot: behindFixture.repoDir,
      hubProjectDir: behindFixture.hubProjectDir,
    });
    expect(behind.attempts[0]?.pendingReason).toBe("untracked_paths");
    expect(behind.attempts[0]?.branchRelation).toBe("behind");
    expect(behind.attempts[0]?.expectedPublishBranchOid).toBe(
      behindFixture.candidate.candidateOid,
    );

    const aheadFixture = await prepareLandedFixture("bd-rel-ahead");
    await execFileAsync(
      "git",
      ["merge", "--ff-only", aheadFixture.candidate.candidateOid],
      { cwd: aheadFixture.repoDir },
    );
    await commitFile(aheadFixture.repoDir, "ahead.txt", "ahead\n", "ahead");
    const aheadHostOid = await gitText(aheadFixture.repoDir, [
      "rev-parse",
      "refs/heads/main",
    ]);
    const aheadPublishOid = await gitText(aheadFixture.repoDir, [
      "rev-parse",
      aheadFixture.policy.publishTargetRef,
    ]);
    expect(
      classifyHostPublishBranchRelation(
        aheadFixture.repoDir,
        aheadHostOid,
        aheadPublishOid,
      ),
    ).toBe("ahead");

    const missingFixture = await prepareLandedFixture("bd-rel-missing");
    await execFileAsync("git", ["checkout", "-b", "keep"], {
      cwd: missingFixture.repoDir,
    });
    await execFileAsync("git", ["branch", "-D", "main"], {
      cwd: missingFixture.repoDir,
    });
    enqueueHubCheckoutProjection({
      repoRoot: missingFixture.repoDir,
      hubProjectDir: missingFixture.hubProjectDir,
      candidate: missingFixture.candidate,
      candidateOid: missingFixture.candidate.candidateOid,
    });
    const missing = await projectHubCheckoutOutbox({
      repoRoot: missingFixture.repoDir,
      hubProjectDir: missingFixture.hubProjectDir,
    });
    expect(missing.attempts[0]?.pendingReason).toBe("branch_diverged");
    expect(missing.attempts[0]?.branchRelation).toBe("missing");
    expect(missing.attempts[0]?.observedHostBranchOid).toBeUndefined();
    expect(missing.attempts[0]?.expectedPublishBranchOid).toBe(
      missingFixture.candidate.candidateOid,
    );

    const divergedFixture = await prepareLandedFixture("bd-rel-diverged");
    await commitFile(divergedFixture.repoDir, "other.txt", "other\n", "diverge");
    enqueueHubCheckoutProjection({
      repoRoot: divergedFixture.repoDir,
      hubProjectDir: divergedFixture.hubProjectDir,
      candidate: divergedFixture.candidate,
      candidateOid: divergedFixture.candidate.candidateOid,
    });
    const diverged = await projectHubCheckoutOutbox({
      repoRoot: divergedFixture.repoDir,
      hubProjectDir: divergedFixture.hubProjectDir,
    });
    expect(diverged.attempts[0]?.branchRelation).toBe("diverged");
    const stored = inspectHubCheckoutOutbox({
      hubProjectDir: divergedFixture.hubProjectDir,
    });
    const raw = JSON.parse(
      await readFile(
        join(
          divergedFixture.hubProjectDir,
          "landing",
          "checkout-outbox",
          `${stored.items[0]!.id}.json`,
        ),
        "utf8",
      ),
    ) as {
      observedHostBranchOid?: string;
      expectedPublishBranchOid?: string;
      branchRelation?: string;
      candidateOid?: string;
    };
    expect(raw.branchRelation).toBe("diverged");
    expect(raw.expectedPublishBranchOid).toBe(
      diverged.attempts[0]?.expectedPublishBranchOid,
    );
    expect(raw.candidateOid).toBe(divergedFixture.candidate.candidateOid);
    expect(raw.observedHostBranchOid).toBe(
      diverged.attempts[0]?.observedHostBranchOid,
    );
  });

  it("keeps indefinite WIP pending and retries the same outbox item after the checkout is cleaned", async () => {
    const fixture = await prepareLandedFixture("bd-retry");
    await writeFile(join(fixture.repoDir, "wip.txt"), "still working\n");
    enqueueHubCheckoutProjection({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });
    const first = await projectHubCheckoutOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });
    expect(first.pendingCount).toBe(1);
    const id = first.attempts[0]?.item.id;
    await execFileAsync("git", ["clean", "-fd"], { cwd: fixture.repoDir });
    const second = await projectHubCheckoutOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });
    expect(second.pendingCount).toBe(0);
    expect(second.attempts[0]?.item.id).toBe(id);
    expect(second.attempts[0]?.status).toBe("succeeded");
    expect(await gitText(fixture.repoDir, ["rev-parse", "HEAD"])).toBe(
      fixture.candidate.candidateOid,
    );
  });

  it("reconciles a crash before or after branch advancement without repeating unsafe work", async () => {
    const beforeFixture = await prepareLandedFixture("bd-crash-before");
    enqueueHubCheckoutProjection({
      repoRoot: beforeFixture.repoDir,
      hubProjectDir: beforeFixture.hubProjectDir,
      candidate: beforeFixture.candidate,
      candidateOid: beforeFixture.candidate.candidateOid,
    });
    await expect(
      projectHubCheckoutOutbox({
        repoRoot: beforeFixture.repoDir,
        hubProjectDir: beforeFixture.hubProjectDir,
        faultInjection: { crashBefore: "checkout_projection" },
      }),
    ).rejects.toBeInstanceOf(HubLandingCrash);
    expect(await gitText(beforeFixture.repoDir, ["rev-parse", "HEAD"])).not.toBe(
      beforeFixture.candidate.candidateOid,
    );
    const recoveredBefore = await projectHubCheckoutOutbox({
      repoRoot: beforeFixture.repoDir,
      hubProjectDir: beforeFixture.hubProjectDir,
    });
    expect(recoveredBefore.attempts[0]?.status).toBe("succeeded");

    const afterFixture = await prepareLandedFixture("bd-crash-after");
    const marker = join(afterFixture.root, "hooks.log");
    await installHook(afterFixture.repoDir, "post-merge", marker);
    enqueueHubCheckoutProjection({
      repoRoot: afterFixture.repoDir,
      hubProjectDir: afterFixture.hubProjectDir,
      candidate: afterFixture.candidate,
      candidateOid: afterFixture.candidate.candidateOid,
    });
    await expect(
      projectHubCheckoutOutbox({
        repoRoot: afterFixture.repoDir,
        hubProjectDir: afterFixture.hubProjectDir,
        faultInjection: { crashAfter: "checkout_projection" },
      }),
    ).rejects.toBeInstanceOf(HubLandingCrash);
    expect(await gitText(afterFixture.repoDir, ["rev-parse", "HEAD"])).toBe(
      afterFixture.candidate.candidateOid,
    );
    expect(
      inspectHubCheckoutOutbox({ hubProjectDir: afterFixture.hubProjectDir })
        .pendingCount,
    ).toBe(1);
    const recoveredAfter = await projectHubCheckoutOutbox({
      repoRoot: afterFixture.repoDir,
      hubProjectDir: afterFixture.hubProjectDir,
    });
    expect(recoveredAfter.attempts[0]?.status).toBe("succeeded");
    expect(listHubCheckoutOutboxItems(afterFixture.hubProjectDir)).toHaveLength(
      1,
    );
    expect(existsSync(marker)).toBe(false);
  });
});
