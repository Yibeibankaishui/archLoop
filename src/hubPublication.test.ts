import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import {
  configureHubLandingPolicy,
  ensureHubLandingPolicy,
} from "./hubLandingPolicy.js";
import { deriveHubLandingShipped } from "./hubLandingTransaction.js";
import {
  GIT_ZERO_OID,
  enqueueHubPublication,
  inspectHubPublicationOutbox,
  listHubPublicationOutboxItems,
  projectHubPublicationOutbox,
  resolveHubPublicationId,
} from "./hubPublication.js";

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

const prepareLandedFixture = async (
  label: string,
  options?: {
    readonly publishPolicy?: "off" | "best_effort" | "required";
    readonly remoteTarget?: string | null;
    readonly withBareRemote?: boolean;
  },
) => {
  const root = await mkdtemp(join(tmpdir(), `hub-pub-${label}-`));
  const repoDir = join(root, "repo");
  const hubProjectDir = join(root, "hub-project");
  const bareDir = join(root, "remote.git");
  await mkdir(repoDir, { recursive: true });
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello\n", "init");

  if (options?.withBareRemote) {
    await execFileAsync("git", ["clone", "--bare", repoDir, bareDir]);
    await execFileAsync("git", ["remote", "add", "origin", bareDir], {
      cwd: repoDir,
    });
  }

  const branch = `archloop/${label}`;
  await execFileAsync("git", ["checkout", "-b", branch], { cwd: repoDir });
  await commitFile(repoDir, "feature.txt", `${label}\n`, "feature");
  await execFileAsync("git", ["checkout", "main"], { cwd: repoDir });

  ensureHubLandingPolicy({ repoRoot: repoDir, hubProjectDir });
  if (
    options?.publishPolicy !== undefined ||
    options?.remoteTarget !== undefined
  ) {
    configureHubLandingPolicy({
      repoRoot: repoDir,
      hubProjectDir,
      ...(options.publishPolicy ? { publishPolicy: options.publishPolicy } : {}),
      ...(options.remoteTarget !== undefined
        ? { remoteTarget: options.remoteTarget }
        : {}),
    });
  }
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
    bareDir,
    policy,
    candidate,
    landed,
    taskId: label,
  };
};

const shippedProof = (fixture: {
  readonly policy: { readonly publishPolicy: "off" | "best_effort" | "required" };
  readonly candidate: {
    readonly transactionId: string;
    readonly candidateOid: string;
  };
}) =>
  deriveHubLandingShipped({
    publishPolicy: fixture.policy.publishPolicy,
    taskClosed: true,
    transactionId: fixture.candidate.transactionId,
    closedTransactionId: fixture.candidate.transactionId,
    candidateOid: fixture.candidate.candidateOid,
    closedCandidateOid: fixture.candidate.candidateOid,
    publishTargetOid: fixture.candidate.candidateOid,
  });

describe("Hub publication outbox", () => {
  it("does not enqueue when publication policy is off even if origin exists", async () => {
    const fixture = await prepareLandedFixture("bd-off", {
      withBareRemote: true,
      publishPolicy: "off",
    });
    expect(shippedProof(fixture).shipped).toBe(true);

    const enqueued = enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    expect(enqueued).toBeUndefined();
    expect(listHubPublicationOutboxItems(fixture.hubProjectDir)).toEqual([]);
  });

  it("enqueues an idempotent best-effort outbox item keyed by transaction remote ref candidate and expected OID", async () => {
    const fixture = await prepareLandedFixture("bd-enqueue", {
      withBareRemote: true,
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });
    expect(shippedProof(fixture).shipped).toBe(true);
    const expectedRemoteOid = await gitText(fixture.repoDir, [
      "rev-parse",
      "main",
    ]);

    const first = enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });
    const second = enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    expect(first).toBeDefined();
    expect(second?.id).toBe(first!.id);
    expect(first!.id).toBe(
      resolveHubPublicationId({
        transactionId: fixture.candidate.transactionId,
        remoteName: "origin",
        remoteRef: "refs/heads/main",
        candidateOid: fixture.candidate.candidateOid,
        expectedRemoteOid,
      }),
    );
    expect(first!.status).toBe("pending");
    expect(first!.remoteTarget).toBe("origin/main");
    expect(first!.expectedRemoteOid).toBe(expectedRemoteOid);
    expect(first!.candidateOid).toBe(fixture.candidate.candidateOid);
    expect(shippedProof(fixture).shipped).toBe(true);
  });

  it("keeps best-effort publication pending without a configured remote", async () => {
    const fixture = await prepareLandedFixture("bd-no-remote", {
      publishPolicy: "best_effort",
    });
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "https://example.test/never-auto.git"],
      { cwd: fixture.repoDir },
    );

    const enqueued = enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });
    expect(enqueued?.pendingReason).toBe("no_remote_configured");

    const outcome = await projectHubPublicationOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });
    expect(outcome.pendingCount).toBe(1);
    expect(outcome.attempts[0]?.pendingReason).toBe("no_remote_configured");
    expect(shippedProof(fixture).shipped).toBe(true);
  });

  it("publishes with exact force-with-lease semantics to an explicit remote", async () => {
    const fixture = await prepareLandedFixture("bd-push", {
      withBareRemote: true,
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });
    enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    const outcome = await projectHubPublicationOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.pendingCount).toBe(0);
    expect(outcome.attempts[0]?.status).toBe("succeeded");
    expect(
      await gitText(fixture.bareDir, ["rev-parse", "refs/heads/main"]),
    ).toBe(fixture.candidate.candidateOid);
    expect(shippedProof(fixture).shipped).toBe(true);
  });

  it("leaves target_publish_pending on network loss without undoing shipped", async () => {
    const fixture = await prepareLandedFixture("bd-network", {
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "git://127.0.0.1:1/archloop.git"],
      { cwd: fixture.repoDir },
    );
    enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    const outcome = await projectHubPublicationOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.pendingCount).toBe(1);
    expect(outcome.attempts[0]?.pendingReason).toBe("network_error");
    expect(outcome.message).toContain("Code publication pending");
    expect(outcome.message).toContain("separate from GitHub task sync");
    expect(outcome.message).not.toMatch(/issue push|sync_conflict/i);
    expect(shippedProof(fixture).shipped).toBe(true);
  });

  it("classifies credential rejection as pending publication", async () => {
    const fixture = await prepareLandedFixture("bd-cred", {
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });
    await execFileAsync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://127.0.0.1:1/private.git",
      ],
      { cwd: fixture.repoDir },
    );
    // Seed an outbox item as if observation succeeded earlier.
    const id = resolveHubPublicationId({
      transactionId: fixture.candidate.transactionId,
      remoteName: "origin",
      remoteRef: "refs/heads/main",
      candidateOid: fixture.candidate.candidateOid,
      expectedRemoteOid: GIT_ZERO_OID,
    });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(fixture.hubProjectDir, "landing", "publication-outbox"), {
      recursive: true,
    });
    writeFileSync(
      join(
        fixture.hubProjectDir,
        "landing",
        "publication-outbox",
        `${id}.json`,
      ),
      `${JSON.stringify(
        {
          version: 1,
          id,
          transactionId: fixture.candidate.transactionId,
          taskId: fixture.taskId,
          remoteName: "origin",
          remoteRef: "refs/heads/main",
          remoteTarget: "origin/main",
          candidateOid: fixture.candidate.candidateOid,
          expectedRemoteOid: GIT_ZERO_OID,
          publishTargetRef: fixture.policy.publishTargetRef,
          status: "pending",
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );

    const outcome = await projectHubPublicationOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.pendingCount).toBe(1);
    expect(["credential_rejected", "network_error", "transient_remote_error"]).toContain(
      outcome.attempts[0]?.pendingReason,
    );
    expect(shippedProof(fixture).shipped).toBe(true);
  });

  it("keeps protected-branch rejection pending without overwriting the remote", async () => {
    const fixture = await prepareLandedFixture("bd-protect", {
      withBareRemote: true,
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });
    const hooksDir = join(fixture.bareDir, "hooks");
    await writeFile(
      join(hooksDir, "pre-receive"),
      "#!/bin/sh\necho protected branch >&2\nexit 1\n",
      { mode: 0o755 },
    );
    enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });
    const before = await gitText(fixture.bareDir, ["rev-parse", "refs/heads/main"]);

    const outcome = await projectHubPublicationOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.pendingCount).toBe(1);
    expect(outcome.attempts[0]?.pendingReason).toBe("protected_branch");
    expect(
      await gitText(fixture.bareDir, ["rev-parse", "refs/heads/main"]),
    ).toBe(before);
    expect(shippedProof(fixture).shipped).toBe(true);
  });

  it("resolves an unknown successful push by observing remote ancestry before retry", async () => {
    const fixture = await prepareLandedFixture("bd-unknown", {
      withBareRemote: true,
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });
    enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    await expect(
      projectHubPublicationOutbox({
        repoRoot: fixture.repoDir,
        hubProjectDir: fixture.hubProjectDir,
        faultInjection: { crashAfter: "publication" },
      }),
    ).rejects.toBeInstanceOf(HubLandingCrash);

    expect(
      await gitText(fixture.bareDir, ["rev-parse", "refs/heads/main"]),
    ).toBe(fixture.candidate.candidateOid);
    expect(
      inspectHubPublicationOutbox({ hubProjectDir: fixture.hubProjectDir })
        .pendingCount,
    ).toBe(1);

    const recovered = await projectHubPublicationOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });
    expect(recovered.pendingCount).toBe(0);
    expect(recovered.attempts[0]?.status).toBe("succeeded");
    expect(shippedProof(fixture).shipped).toBe(true);
  });

  it("retries after a crash before push without duplicating publication", async () => {
    const fixture = await prepareLandedFixture("bd-restart", {
      withBareRemote: true,
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });
    enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    await expect(
      projectHubPublicationOutbox({
        repoRoot: fixture.repoDir,
        hubProjectDir: fixture.hubProjectDir,
        faultInjection: { crashBefore: "publication" },
      }),
    ).rejects.toBeInstanceOf(HubLandingCrash);

    const before = await gitText(fixture.bareDir, ["rev-parse", "refs/heads/main"]);
    expect(before).not.toBe(fixture.candidate.candidateOid);

    const recovered = await projectHubPublicationOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });
    expect(recovered.pendingCount).toBe(0);
    expect(
      await gitText(fixture.bareDir, ["rev-parse", "refs/heads/main"]),
    ).toBe(fixture.candidate.candidateOid);
  });

  it("requires fresh reconciliation when the remote diverges instead of force-overwriting", async () => {
    const fixture = await prepareLandedFixture("bd-diverge", {
      withBareRemote: true,
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });
    enqueueHubPublication({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
      candidate: fixture.candidate,
      candidateOid: fixture.candidate.candidateOid,
    });

    const remoteWork = join(fixture.root, "remote-work");
    await execFileAsync("git", ["clone", fixture.bareDir, remoteWork]);
    await execFileAsync("git", ["config", "user.email", "test@test.com"], {
      cwd: remoteWork,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: remoteWork,
    });
    await commitFile(remoteWork, "other.txt", "other\n", "unrelated remote");
    await execFileAsync("git", ["push", "origin", "main"], { cwd: remoteWork });
    const divergedTip = await gitText(fixture.bareDir, [
      "rev-parse",
      "refs/heads/main",
    ]);

    const outcome = await projectHubPublicationOutbox({
      repoRoot: fixture.repoDir,
      hubProjectDir: fixture.hubProjectDir,
    });

    expect(outcome.pendingCount).toBe(1);
    expect(outcome.attempts[0]?.pendingReason).toBe("remote_diverged");
    expect(
      await gitText(fixture.bareDir, ["rev-parse", "refs/heads/main"]),
    ).toBe(divergedTip);
    expect(divergedTip).not.toBe(fixture.candidate.candidateOid);
    expect(shippedProof(fixture).shipped).toBe(true);
  });
});
