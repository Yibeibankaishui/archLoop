import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  commitHubLandingTarget,
  computeHubVerifierFingerprint,
  createHubLandingCandidate,
  snapshotHubLandingCandidateGeneration,
} from "./hubLanding.js";
import {
  computeHubLandingMergeInputFingerprint,
  isTransientHubLandingError,
  recordHubLandingRepairAttempt,
  remainingHubLandingRepairAttempts,
} from "./hubLandingRepair.js";
import { ensureHubLandingPolicy } from "./hubLandingPolicy.js";

const execFileAsync = promisify(execFile);

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

describe("Hub landing repair budget", () => {
  it("keeps merge-input fingerprint stable for the same source and base OIDs", () => {
    const sourceOid = "a".repeat(40);
    const baseOid = "b".repeat(40);
    expect(
      computeHubLandingMergeInputFingerprint({ sourceOid, baseOid }),
    ).toBe(computeHubLandingMergeInputFingerprint({ sourceOid, baseOid }));
    expect(
      computeHubLandingMergeInputFingerprint({ sourceOid, baseOid }),
    ).not.toBe(
      computeHubLandingMergeInputFingerprint({
        sourceOid,
        baseOid: "c".repeat(40),
      }),
    );
  });

  it("does not reset remaining attempts when the target OID drifts", async () => {
    const hubProjectDir = await mkdtemp(join(tmpdir(), "hub-repair-drift-"));
    const sourceOid = "a".repeat(40);
    recordHubLandingRepairAttempt({
      hubProjectDir,
      taskId: "bd-drift",
      sourceOid,
      kind: "merge_conflict",
      fingerprint: computeHubLandingMergeInputFingerprint({
        sourceOid,
        baseOid: "b".repeat(40),
      }),
    });
    recordHubLandingRepairAttempt({
      hubProjectDir,
      taskId: "bd-drift",
      sourceOid,
      kind: "merge_conflict",
      fingerprint: computeHubLandingMergeInputFingerprint({
        sourceOid,
        baseOid: "d".repeat(40),
      }),
    });
    expect(
      remainingHubLandingRepairAttempts({
        hubProjectDir,
        taskId: "bd-drift",
        sourceOid,
        kind: "merge_conflict",
        fingerprint: computeHubLandingMergeInputFingerprint({
          sourceOid,
          baseOid: "e".repeat(40),
        }),
      }),
    ).toBe(0);
  });

  it("classifies git lock and I/O errors as transient", () => {
    expect(
      isTransientHubLandingError({
        message: "Unable to create '.git/index.lock': File exists",
      }),
    ).toBe(true);
    expect(
      isTransientHubLandingError({
        code: "EAGAIN",
        message: "Resource temporarily unavailable",
      }),
    ).toBe(true);
    expect(
      isTransientHubLandingError({
        message: "fatal: refusing to merge unrelated histories",
      }),
    ).toBe(false);
  });
});

describe("Hub landing repair real git", () => {
  it("refuses to land an unverified or stale candidate OID", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-repair-oid-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    const branch = "archloop/bd-stale";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    ensureHubLandingPolicy({ repoRoot: repoDir, hubProjectDir });
    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-stale",
      branch,
    });
    const fingerprint = computeHubVerifierFingerprint(repoDir);
    await expect(
      commitHubLandingTarget({
        repoRoot: repoDir,
        hubProjectDir,
        candidate,
        verifierFingerprint: fingerprint,
      }),
    ).rejects.toThrow(/Unverified landing candidate/);

    await writeFile(join(candidate.worktreeDir, "feature.txt"), "repaired\n");
    await execFileAsync("git", ["add", "feature.txt"], {
      cwd: candidate.worktreeDir,
    });
    await execFileAsync("git", ["commit", "-m", "repair generation"], {
      cwd: candidate.worktreeDir,
    });
    const repaired = await snapshotHubLandingCandidateGeneration({
      repoRoot: repoDir,
      hubProjectDir,
      candidate,
    });
    expect(repaired.candidateOid).not.toBe(candidate.candidateOid);
    await expect(
      commitHubLandingTarget({
        repoRoot: repoDir,
        hubProjectDir,
        candidate: repaired,
        verifierFingerprint: fingerprint,
      }),
    ).rejects.toThrow(/Unverified landing candidate/);
  });
});
