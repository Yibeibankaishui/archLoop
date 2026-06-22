import { Effect, Layer, Ref } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { WorktreeError } from "./errors.js";
import {
  acquireWorktreeLease,
  leaseLockPath,
  leaseNameFromBranch,
  releaseWorktreeLease,
} from "./WorktreeLease.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import type { BranchStrategy } from "./SandboxProvider.js";
import * as WorktreeManager from "./WorktreeManager.js";
import {
  SandboxConfig,
  SandboxFactory,
  WorktreeDockerSandboxFactory,
} from "./SandboxFactory.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const lockExists = async (repoDir: string, branch: string): Promise<boolean> => {
  try {
    await access(leaseLockPath(repoDir, leaseNameFromBranch(branch)));
    return true;
  } catch {
    return false;
  }
};

describe("one-shot worktree leases via SandboxFactory", () => {
  let hostRepoDir: string;
  const tempDirs: string[] = [];

  const makeLayer = (branchStrategy: BranchStrategy) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          sandboxProvider: noSandbox(),
          branchStrategy,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

  beforeEach(async () => {
    hostRepoDir = await mkdtemp(join(tmpdir(), "wt-lease-oneshot-"));
    tempDirs.push(hostRepoDir);
    await initRepo(hostRepoDir);
    await commitFile(hostRepoDir, "hello.txt", "hello", "initial commit");
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("acquires and releases a lease for merge-to-head non-head execution", async () => {
    let observedWorktreePath = "";

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.sync(() => {
            observedWorktreePath = info.hostWorktreePath ?? "";
          }),
        );
      }).pipe(Effect.provide(makeLayer({ type: "merge-to-head" }))),
    );

    expect(observedWorktreePath).toContain(
      join(hostRepoDir, ".archloop", "worktrees"),
    );
    expect(observedWorktreePath.length).toBeGreaterThan(0);
  });

  it("acquires and releases a lease for explicit branch strategy", async () => {
    const branch = "feature/lease-branch";
    await execAsync(`git checkout -b ${branch}`, { cwd: hostRepoDir });
    await commitFile(hostRepoDir, "branch.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: hostRepoDir });

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer({ type: "branch", branch }))),
    );

    expect(await lockExists(hostRepoDir, branch)).toBe(false);
    const lockPath = leaseLockPath(hostRepoDir, leaseNameFromBranch(branch));
    await expect(readFile(lockPath, "utf-8")).rejects.toThrow();
  });

  it("does not create a lease for head branch strategy", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer({ type: "head" }))),
    );

    await expect(
      access(join(hostRepoDir, ".archloop", "locks")),
    ).rejects.toThrow();
  });

  it("fails fast when a second live caller targets the same active branch worktree", async () => {
    const branch = "feature/active-conflict";
    await execAsync(`git checkout -b ${branch}`, { cwd: hostRepoDir });
    await commitFile(hostRepoDir, "branch.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: hostRepoDir });

    await Effect.runPromise(
      WorktreeManager.create(hostRepoDir, { branch }).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );
    await Effect.runPromise(
      acquireWorktreeLease(hostRepoDir, { branch }).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );

    const layer = makeLayer({ type: "branch", branch });
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox(() => Effect.void).pipe(Effect.flip);
      }).pipe(Effect.provide(layer)),
    ).catch((error) => error);

    expect(second).toBeInstanceOf(WorktreeError);
    expect((second as WorktreeError).message).toContain("in use");
    expect((second as WorktreeError).message).toContain(branch);
    expect((second as WorktreeError).message).toMatch(/next action/i);

    await Effect.runPromise(
      releaseWorktreeLease(hostRepoDir, branch).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  });
});
