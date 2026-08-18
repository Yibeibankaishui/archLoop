import { exec } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  formatInvalidHubTaskStoreRedirectMessage,
  formatStaleHubTaskSnapshotRedirectMessage,
  HUB_TASK_STORE_GIT_EXCLUDE_PATTERN,
  installHubTaskStoreRedirect,
  resolveHubTaskStore,
  resolveManagedHubTaskStoreDir,
} from "./hubTaskStoreResolver.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, "hello.txt"), "hello");
  await execAsync("git add hello.txt && git commit -m init", { cwd: dir });
};

describe("resolveHubTaskStore", () => {
  it("reports uninitialized when the repository has no Beads store", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-uninitialized-"),
    );
    await initRepo(repoDir);

    const resolution = resolveHubTaskStore({ repoRoot: repoDir });

    expect(resolution.kind).toBe("uninitialized");
    expect(resolution.redirectError).toBeUndefined();
  });

  it("reports legacy when the repository has a fully initialized local store", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-legacy-"));
    await initRepo(repoDir);
    seedHubTaskStoreMetadata(repoDir);

    const resolution = resolveHubTaskStore({ repoRoot: repoDir });

    expect(resolution.kind).toBe("legacy");
    expect(resolution.beadsDir).toBe(join(repoDir, ".beads"));
  });

  it("reports managed when the Hub project directory has the live store", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-managed-repo-"),
    );
    const hubProjectDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-managed-hub-"),
    );
    await initRepo(repoDir);
    seedHubTaskStoreMetadata(hubProjectDir);

    const resolution = resolveHubTaskStore({
      repoRoot: repoDir,
      hubProjectDir,
    });

    expect(resolution.kind).toBe("managed");
    expect(resolution.beadsDir).toBe(
      resolveManagedHubTaskStoreDir(hubProjectDir),
    );
  });

  it("reports redirect when .beads/redirect points at a managed store", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-redirect-repo-"),
    );
    const hubProjectDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-redirect-hub-"),
    );
    await initRepo(repoDir);
    seedHubTaskStoreMetadata(hubProjectDir);
    const managedBeadsDir = resolveManagedHubTaskStoreDir(hubProjectDir);
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(
      join(repoDir, ".beads", "redirect"),
      `${managedBeadsDir}\n`,
    );

    const resolution = resolveHubTaskStore({
      repoRoot: repoDir,
      hubProjectDir,
    });

    expect(resolution.kind).toBe("redirect");
    expect(resolution.beadsDir).toBe(managedBeadsDir);
    expect(resolution.redirectTarget).toBe(managedBeadsDir);
    expect(resolution.redirectError).toBeUndefined();
  });

  it("reports an actionable error when the redirect target is missing", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-invalid-"));
    await initRepo(repoDir);
    const missingTarget = join(repoDir, "missing-managed", ".beads");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(join(repoDir, ".beads", "redirect"), `${missingTarget}\n`);

    const resolution = resolveHubTaskStore({ repoRoot: repoDir });

    expect(resolution.kind).toBe("redirect");
    expect(resolution.redirectError).toBe(
      formatInvalidHubTaskStoreRedirectMessage(
        join(repoDir, ".beads", "redirect"),
        missingTarget,
      ),
    );
  });

  it("distinguishes a stale task-snapshot redirect from an uninitialized store", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-snapshot-redirect-"),
    );
    await initRepo(repoDir);
    const snapshotTarget = join(
      repoDir,
      "runs",
      "run-1",
      "task-snapshots",
      "implement",
      "arch-qti",
      "attempt-1",
    );
    await mkdir(snapshotTarget, { recursive: true });
    await writeFile(join(snapshotTarget, "snapshot.json"), "{}\n");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(join(repoDir, ".beads", "redirect"), `${snapshotTarget}\n`);

    const resolution = resolveHubTaskStore({ repoRoot: repoDir });

    expect(resolution.kind).toBe("redirect");
    expect(resolution.redirectError).toBe(
      formatStaleHubTaskSnapshotRedirectMessage(
        join(repoDir, ".beads", "redirect"),
        snapshotTarget,
      ),
    );
    expect(resolution.redirectError).toContain("task snapshot directory");
    expect(resolution.redirectError).toMatch(/Do not run `archloop tasks init`/);
    expect(resolution.redirectError).not.toMatch(
      /requires a local task store\. Run `archloop tasks init`/,
    );
  });

  it("diagnoses a cleaned-up snapshot redirect path without recommending tasks init", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-missing-snapshot-"),
    );
    await initRepo(repoDir);
    const missingSnapshot = join(
      repoDir,
      "runs",
      "run-1",
      "task-snapshots",
      "implement",
      "arch-2o3",
      "attempt-gone",
    );
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(
      join(repoDir, ".beads", "redirect"),
      `${missingSnapshot}\n`,
    );

    const resolution = resolveHubTaskStore({ repoRoot: repoDir });

    expect(resolution.redirectError).toBe(
      formatStaleHubTaskSnapshotRedirectMessage(
        join(repoDir, ".beads", "redirect"),
        missingSnapshot,
      ),
    );
    expect(resolution.redirectError).toMatch(/Do not run/);
  });

  it("does not treat a redirect-only .beads directory as a legacy store", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-redirect-only-"),
    );
    const hubProjectDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-redirect-only-hub-"),
    );
    await initRepo(repoDir);
    seedHubTaskStoreMetadata(hubProjectDir);
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(
      join(repoDir, ".beads", "redirect"),
      `${resolveManagedHubTaskStoreDir(hubProjectDir)}\n`,
    );

    const resolution = resolveHubTaskStore({
      repoRoot: repoDir,
      hubProjectDir,
    });

    expect(resolution.kind).toBe("redirect");
    expect(resolution.kind).not.toBe("legacy");
  });
});

describe("installHubTaskStoreRedirect", () => {
  it("writes a Git-ignored redirect and leaves the repository clean", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-install-"));
    const hubProjectDir = await mkdtemp(
      join(tmpdir(), "hub-task-store-install-hub-"),
    );
    await initRepo(repoDir);
    seedHubTaskStoreMetadata(hubProjectDir);
    const managedBeadsDir = resolveManagedHubTaskStoreDir(hubProjectDir);

    installHubTaskStoreRedirect(repoDir, managedBeadsDir);

    const redirectPath = join(repoDir, ".beads", "redirect");
    expect((await readFile(redirectPath, "utf8")).trim()).toBe(managedBeadsDir);

    const exclude = await readFile(
      join(repoDir, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude.split("\n")).toContain(HUB_TASK_STORE_GIT_EXCLUDE_PATTERN);

    const { stdout } = await execAsync("git status --porcelain", {
      cwd: repoDir,
    });
    expect(stdout).toBe("");
  });
});
