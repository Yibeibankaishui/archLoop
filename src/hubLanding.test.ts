import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  bindHubLandingVerification,
  cleanupHubLandingCandidate,
  commitHubLandingTarget,
  computeHubVerifierFingerprint,
  createHubLandingCandidate,
  recordHubLandingTaskClosed,
} from "./hubLanding.js";
import { ensureHubLandingPolicy } from "./hubLandingPolicy.js";
import {
  deriveHubLandingShipped,
  loadHubLandingTransaction,
  resolveHubLandingJournalPath,
} from "./hubLandingTransaction.js";
import { listHubCheckoutOutboxItems } from "./hubCheckoutProjection.js";

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

const captureCheckout = async (repoDir: string) => {
  const head = await gitText(repoDir, ["rev-parse", "HEAD"]);
  const branch = await gitText(repoDir, ["branch", "--show-current"]);
  const status = await gitText(repoDir, ["status", "--porcelain=v1"]);
  const index = await gitText(repoDir, ["ls-files", "-s"]);
  return { head, branch, status, index };
};

describe("Hub fenced local landing", () => {
  it("ships one local-only task without touching checkout, remote, or recover", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-e2e-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "https://example.test/repo.git"],
      { cwd: repoDir },
    );

    const branch = "archloop/bd-land";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(join(repoDir, ".beads", "issues.jsonl"), '{"id":"staged"}\n');
    await execFileAsync("git", ["add", ".beads/issues.jsonl"], { cwd: repoDir });
    await writeFile(join(repoDir, "wip.txt"), "uncommitted wip\n");
    await writeFile(join(repoDir, "hello.txt"), "dirty hello\n");

    const before = await captureCheckout(repoDir);
    expect(before.status).toContain("A  .beads/issues.jsonl");
    expect(before.status).toContain(" M hello.txt");
    expect(before.status).toContain("?? wip.txt");

    const policy = ensureHubLandingPolicy({
      repoRoot: repoDir,
      hubProjectDir,
    }).policy;
    expect(policy.publishPolicy).toBe("off");

    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-land",
      branch,
    });
    expect(candidate.worktreeDir).toContain(hubProjectDir);
    expect(await readFile(join(candidate.worktreeDir, "feature.txt"), "utf8")).toBe(
      "feature\n",
    );

    const fingerprint = computeHubVerifierFingerprint(repoDir);
    bindHubLandingVerification({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: "bd-land",
      candidateOid: candidate.candidateOid,
      verifierFingerprint: fingerprint,
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
    recordHubLandingTaskClosed({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: "bd-land",
      candidateOid: candidate.candidateOid,
    });

    expect(await gitText(repoDir, ["rev-parse", policy.publishTargetRef])).toBe(
      candidate.candidateOid,
    );
    expect(await gitText(repoDir, ["rev-parse", landed.receiptRef])).toBe(
      landed.receiptOid,
    );
    expect(await gitText(repoDir, ["rev-parse", policy.fenceRef])).toBe(
      landed.fenceOid,
    );
    expect(
      await gitText(repoDir, [
        "ls-tree",
        "-r",
        "--name-only",
        candidate.candidateOid,
      ]),
    ).toContain("feature.txt");

    const after = await captureCheckout(repoDir);
    expect(after).toEqual(before);
    await expect(readFile(join(repoDir, "hello.txt"), "utf8")).resolves.toBe(
      "dirty hello\n",
    );
    await expect(readFile(join(repoDir, "wip.txt"), "utf8")).resolves.toBe(
      "uncommitted wip\n",
    );
    expect(
      await gitText(repoDir, ["show", `:${".beads/issues.jsonl"}`]),
    ).toBe('{"id":"staged"}');
    await expect(
      readFile(join(repoDir, "feature.txt"), "utf8"),
    ).rejects.toBeTruthy();

    const shipped = deriveHubLandingShipped({
      publishPolicy: policy.publishPolicy,
      taskClosed: true,
      transactionId: candidate.transactionId,
      closedTransactionId: candidate.transactionId,
      candidateOid: candidate.candidateOid,
      closedCandidateOid: candidate.candidateOid,
      publishTargetOid: await gitText(repoDir, [
        "rev-parse",
        policy.publishTargetRef,
      ]),
    });
    expect(shipped).toMatchObject({
      shipped: true,
      reason: "verified_landing_and_matching_closure",
    });
    expect(
      loadHubLandingTransaction(hubProjectDir, candidate.transactionId)
        ?.checkpoint,
    ).toBe("cleaned");
    expect(listHubCheckoutOutboxItems(hubProjectDir)).toEqual([
      expect.objectContaining({
        transactionId: candidate.transactionId,
        candidateOid: candidate.candidateOid,
        status: "pending",
      }),
    ]);
  });

  it("refuses to land an unverified or stale candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-stale-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    const branch = "archloop/bd-stale";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

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

    bindHubLandingVerification({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: "bd-stale",
      candidateOid: candidate.candidateOid,
      verifierFingerprint: fingerprint,
    });
    await expect(
      commitHubLandingTarget({
        repoRoot: repoDir,
        hubProjectDir,
        candidate: {
          ...candidate,
          candidateOid: await gitText(repoDir, ["rev-parse", "HEAD"]),
        },
        verifierFingerprint: fingerprint,
      }),
    ).rejects.toThrow(/Stale verification artifact/);
  });

  it("fails CAS when the fence or publish target OID has changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-cas-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    const branch = "archloop/bd-cas";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-cas",
      branch,
    });
    const fingerprint = computeHubVerifierFingerprint(repoDir);
    bindHubLandingVerification({
      hubProjectDir,
      transactionId: candidate.transactionId,
      taskId: "bd-cas",
      candidateOid: candidate.candidateOid,
      verifierFingerprint: fingerprint,
    });

    await commitFile(repoDir, "drift.txt", "drift\n", "host drift");
    await execFileAsync(
      "git",
      [
        "update-ref",
        candidate.policy.publishTargetRef,
        await gitText(repoDir, ["rev-parse", "HEAD"]),
      ],
      { cwd: repoDir },
    );

    await expect(
      commitHubLandingTarget({
        repoRoot: repoDir,
        hubProjectDir,
        candidate,
        verifierFingerprint: fingerprint,
      }),
    ).rejects.toThrow(/publish target drifted|CAS failed/);
  });

  it("binds verification to the exact candidate and verify.sh fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-verify-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    await mkdir(join(repoDir, ".archloop"), { recursive: true });
    await writeFile(join(repoDir, ".archloop", "verify.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(repoDir, ".archloop", "verify.sh"), 0o755);
    const first = computeHubVerifierFingerprint(repoDir);
    await writeFile(
      join(repoDir, ".archloop", "verify.sh"),
      "#!/bin/sh\necho changed\nexit 0\n",
    );
    const second = computeHubVerifierFingerprint(repoDir);
    expect(first).not.toBe(second);
  });

  it("reuses the exact candidate ref after a crash before the checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-reuse-cand-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    const branch = "archloop/bd-reuse";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    const first = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-reuse",
      branch,
    });
    const journalPath = resolveHubLandingJournalPath(
      hubProjectDir,
      first.transactionId,
    );
    const journal = await readFile(journalPath, "utf8");
    await writeFile(
      journalPath,
      journal
        .split("\n")
        .filter((line) => !line.includes('"candidate_created"'))
        .join("\n"),
    );
    expect(
      loadHubLandingTransaction(hubProjectDir, first.transactionId)?.candidateOid,
    ).toBeUndefined();

    let mergeCalls = 0;
    const second = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-reuse",
      branch,
      merge: async () => {
        mergeCalls += 1;
      },
    });
    expect(mergeCalls).toBe(0);
    expect(second.candidateOid).toBe(first.candidateOid);
    expect(second.candidateRef).toBe(first.candidateRef);
    expect(await gitText(repoDir, ["rev-parse", first.candidateRef])).toBe(
      first.candidateOid,
    );
  });

  it("strips allowlisted Beads runtime files from the candidate without rewriting the source branch or checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-beads-runtime-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");

    const branch = "archloop/bd-runtime";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await commitFile(
      repoDir,
      ".beads/issues.jsonl",
      '{"id":"branch-export"}\n',
      "legacy beads export",
    );
    const sourceOid = await gitText(repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(join(repoDir, ".beads", "redirect"), "/tmp/managed-beads\n");
    await writeFile(join(repoDir, "wip.txt"), "uncommitted wip\n");
    const before = await captureCheckout(repoDir);

    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-runtime",
      branch,
    });
    const candidateTree = await gitText(repoDir, [
      "ls-tree",
      "-r",
      "--name-only",
      candidate.candidateOid,
    ]);

    expect(candidateTree.split("\n")).toEqual(
      expect.arrayContaining(["feature.txt", "hello.txt"]),
    );
    expect(candidateTree.split("\n")).not.toContain(".beads/issues.jsonl");
    expect(candidate.filteredBeadsRuntimePaths).toEqual([
      ".beads/issues.jsonl",
    ]);
    expect(await gitText(repoDir, ["rev-parse", `${branch}^{commit}`])).toBe(
      sourceOid,
    );
    expect(
      await gitText(repoDir, ["show", `${branch}:.beads/issues.jsonl`]),
    ).toBe('{"id":"branch-export"}');
    expect(await captureCheckout(repoDir)).toEqual(before);
    await expect(
      readFile(join(repoDir, ".beads", "redirect"), "utf8"),
    ).resolves.toBe("/tmp/managed-beads\n");
  });

  it("keeps Beads config, docs, hooks, and unknown .beads paths in the candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-beads-keep-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");

    const branch = "archloop/bd-keep-beads";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await mkdir(join(repoDir, ".beads", "hooks"), { recursive: true });
    await commitFile(
      repoDir,
      ".beads/config.yaml",
      "prefix: demo\n",
      "beads config",
    );
    await commitFile(repoDir, ".beads/README.md", "# Beads\n", "beads docs");
    await commitFile(
      repoDir,
      ".beads/hooks/pre-commit",
      "#!/bin/sh\nexit 0\n",
      "beads hook",
    );
    await commitFile(
      repoDir,
      ".beads/mystery.jsonl",
      '{"id":"unknown"}\n',
      "unknown beads path",
    );
    await commitFile(
      repoDir,
      ".beads/issues.jsonl",
      '{"id":"runtime"}\n',
      "runtime export",
    );
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-keep-beads",
      branch,
    });
    const candidateTree = (
      await gitText(repoDir, [
        "ls-tree",
        "-r",
        "--name-only",
        candidate.candidateOid,
      ])
    ).split("\n");

    expect(candidateTree).toEqual(
      expect.arrayContaining([
        "feature.txt",
        ".beads/config.yaml",
        ".beads/README.md",
        ".beads/hooks/pre-commit",
        ".beads/mystery.jsonl",
      ]),
    );
    expect(candidateTree).not.toContain(".beads/issues.jsonl");
    expect(candidate.filteredBeadsRuntimePaths).toEqual([
      ".beads/issues.jsonl",
    ]);
    expect(
      await gitText(repoDir, ["show", `${candidate.candidateOid}:.beads/mystery.jsonl`]),
    ).toBe('{"id":"unknown"}');
  });

  it("restores allowlisted Beads runtime files from the base instead of taking branch edits or deletes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-beads-restore-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await commitFile(
      repoDir,
      ".beads/issues.jsonl",
      '{"id":"base-export"}\n',
      "base beads export",
    );
    await commitFile(
      repoDir,
      ".beads/interactions.jsonl",
      '{"id":"base-interactions"}\n',
      "base interactions",
    );

    const branch = "archloop/bd-restore";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await commitFile(
      repoDir,
      ".beads/issues.jsonl",
      '{"id":"branch-export"}\n',
      "edit beads export",
    );
    await execFileAsync(
      "git",
      ["rm", ".beads/interactions.jsonl"],
      { cwd: repoDir },
    );
    await execFileAsync("git", ["commit", "-m", "drop interactions"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-restore",
      branch,
    });

    expect(
      await gitText(repoDir, [
        "show",
        `${candidate.candidateOid}:.beads/issues.jsonl`,
      ]),
    ).toBe('{"id":"base-export"}');
    expect(
      await gitText(repoDir, [
        "show",
        `${candidate.candidateOid}:.beads/interactions.jsonl`,
      ]),
    ).toBe('{"id":"base-interactions"}');
    expect(
      await gitText(repoDir, [
        "show",
        `${candidate.candidateOid}:feature.txt`,
      ]),
    ).toBe("feature");
    expect(candidate.filteredBeadsRuntimePaths).toEqual([
      ".beads/interactions.jsonl",
      ".beads/issues.jsonl",
    ]);
  });

  it("does not silently discard a renamed unknown Beads path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-beads-rename-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await commitFile(
      repoDir,
      ".beads/issues.jsonl",
      '{"id":"base-export"}\n',
      "base beads export",
    );

    const branch = "archloop/bd-rename";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await execFileAsync(
      "git",
      ["mv", ".beads/issues.jsonl", ".beads/mystery.jsonl"],
      { cwd: repoDir },
    );
    await execFileAsync("git", ["commit", "-m", "rename export"], {
      cwd: repoDir,
    });
    const sourceOid = await gitText(repoDir, ["rev-parse", "HEAD"]);
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-rename",
      branch,
    });
    const candidateTree = (
      await gitText(repoDir, [
        "ls-tree",
        "-r",
        "--name-only",
        candidate.candidateOid,
      ])
    ).split("\n");

    expect(candidateTree).toEqual(
      expect.arrayContaining([
        "feature.txt",
        ".beads/issues.jsonl",
        ".beads/mystery.jsonl",
      ]),
    );
    expect(
      await gitText(repoDir, [
        "show",
        `${candidate.candidateOid}:.beads/issues.jsonl`,
      ]),
    ).toBe('{"id":"base-export"}');
    expect(
      await gitText(repoDir, [
        "show",
        `${candidate.candidateOid}:.beads/mystery.jsonl`,
      ]),
    ).toBe('{"id":"base-export"}');
    expect(await gitText(repoDir, ["rev-parse", `${branch}^{commit}`])).toBe(
      sourceOid,
    );
  });

  it("restores allowlisted Beads runtime file mode from the base", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-beads-mode-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await commitFile(
      repoDir,
      ".beads/issues.jsonl",
      '{"id":"base-export"}\n',
      "base beads export",
    );
    const baseMode = (
      await gitText(repoDir, ["ls-tree", "HEAD", ".beads/issues.jsonl"])
    ).split(" ")[0];

    const branch = "archloop/bd-mode";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await chmod(join(repoDir, ".beads", "issues.jsonl"), 0o755);
    await execFileAsync("git", ["add", ".beads/issues.jsonl"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "chmod export"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-mode",
      branch,
    });
    const candidateMode = (
      await gitText(repoDir, [
        "ls-tree",
        candidate.candidateOid,
        ".beads/issues.jsonl",
      ])
    ).split(" ")[0];
    expect(candidateMode).toBe(baseMode);
    expect(candidate.filteredBeadsRuntimePaths).toEqual([
      ".beads/issues.jsonl",
    ]);
  });

  it("records filtered Beads runtime paths in the candidate manifest and transaction journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-beads-diag-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "init");
    const branch = "archloop/bd-diag";
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await commitFile(
      repoDir,
      ".beads/issues.jsonl",
      '{"id":"branch-export"}\n',
      "legacy beads export",
    );
    await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

    const candidate = await createHubLandingCandidate({
      repoRoot: repoDir,
      hubProjectDir,
      taskId: "bd-diag",
      branch,
    });
    const manifest = JSON.parse(
      await readFile(
        join(
          hubProjectDir,
          "landing",
          "transactions",
          candidate.transactionId,
          "candidate.json",
        ),
        "utf8",
      ),
    ) as { filteredBeadsRuntimePaths?: string[]; candidateOid: string };
    const state = loadHubLandingTransaction(
      hubProjectDir,
      candidate.transactionId,
    );

    expect(manifest.candidateOid).toBe(candidate.candidateOid);
    expect(manifest.filteredBeadsRuntimePaths).toEqual([
      ".beads/issues.jsonl",
    ]);
    expect(state?.filteredBeadsRuntimePaths).toEqual([".beads/issues.jsonl"]);
    expect(state?.candidateOid).toBe(candidate.candidateOid);
  });
});
