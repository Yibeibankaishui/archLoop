import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isScaffoldAuthMountHostPath,
  resolveUserMounts,
} from "./mountUtils.js";

describe("isScaffoldAuthMountHostPath", () => {
  it("matches relative sandcastle auth mount paths", () => {
    expect(isScaffoldAuthMountHostPath(".sandcastle/auth/codex")).toBe(true);
    expect(isScaffoldAuthMountHostPath(".sandcastle/auth/gh")).toBe(true);
  });

  it("matches absolute sandcastle auth mount paths", () => {
    expect(
      isScaffoldAuthMountHostPath("/home/user/proj/.sandcastle/auth/codex"),
    ).toBe(true);
  });

  it("does not match arbitrary missing mount paths", () => {
    expect(isScaffoldAuthMountHostPath("nonexistent_dir_xyz")).toBe(false);
    expect(isScaffoldAuthMountHostPath("/mnt/cache")).toBe(false);
    expect(isScaffoldAuthMountHostPath(".sandcastle/auth")).toBe(false);
  });
});

describe("resolveUserMounts scaffold auth host directories", () => {
  let repoDir: string;
  let previousCwd: string;

  beforeEach(async () => {
    previousCwd = process.cwd();
    repoDir = await mkdtemp(join(tmpdir(), "scaffold-auth-mount-"));
    await mkdir(join(repoDir, ".sandcastle"), { recursive: true });
    process.chdir(repoDir);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await rm(repoDir, { recursive: true, force: true });
  });

  it("creates a missing .sandcastle/auth/codex host directory", async () => {
    const authDir = join(repoDir, ".sandcastle/auth/codex");

    const result = resolveUserMounts(
      [
        {
          hostPath: ".sandcastle/auth/codex",
          sandboxPath: "/home/agent/.codex",
        },
      ],
      "/home/agent",
    );

    await access(authDir);
    const resolvedAuthDir = await realpath(authDir);
    expect(result).toEqual([
      {
        hostPath: resolvedAuthDir,
        sandboxPath: "/home/agent/.codex",
      },
    ]);
  });

  it("still throws for missing non-scaffold mount paths", () => {
    expect(() =>
      resolveUserMounts([
        { hostPath: "nonexistent_dir_xyz", sandboxPath: "/mnt/data" },
      ]),
    ).toThrow("Mount hostPath does not exist");
  });
});
