import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { exec } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { cli } from "./cli.js";
import { registerHubProject, selectHubProject } from "./hubProjectRegistry.js";

const mockCollectHubReadinessChecks = vi.fn();
const mockFormatHubReadinessCheckLines = vi.fn();
const mockCollectHubProjectReadinessCheck = vi.fn();
const mockFormatHubProjectReadinessCheckLines = vi.fn();

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

vi.mock("./hubReadinessCheck.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    collectHubReadinessChecks: (...args: unknown[]) =>
      mockCollectHubReadinessChecks(...args),
    formatHubReadinessCheckLines: (...args: unknown[]) =>
      mockFormatHubReadinessCheckLines(...args),
  };
});

vi.mock("./hubProjectReadinessCheck.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    collectHubProjectReadinessCheck: (...args: unknown[]) =>
      mockCollectHubProjectReadinessCheck(...args),
    formatHubProjectReadinessCheckLines: (...args: unknown[]) =>
      mockFormatHubProjectReadinessCheckLines(...args),
  };
});

const runCli = async (
  args: string[],
): Promise<ReadonlyArray<DisplayEntry>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
      yield* cli(["node", "archloop", ...args]).pipe(
        Effect.provide(SilentDisplay.layer(ref)),
        Effect.provide(NodeContext.layer),
      );
      return yield* Ref.get(ref);
    }),
  );

describe("archloop check project readiness", () => {
  let hostDir: string;
  let dataDir: string;
  let originalXdgDataHome: string | undefined;

  beforeEach(async () => {
    hostDir = await mkdtemp(join(tmpdir(), "cli-check-project-"));
    dataDir = join(hostDir, "xdg-data");
    await mkdir(dataDir, { recursive: true });
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;

    mockCollectHubReadinessChecks.mockResolvedValue({
      sections: [{ title: "Checking Hub agent roles", findings: [] }],
      hasWarnings: false,
      hasErrors: false,
    });
    mockFormatHubReadinessCheckLines.mockReturnValue([
      "Hub readiness check",
      "",
      "Checking Hub agent roles",
      "  SUCCESS: Hub agent roles",
      "    All required Hub agent roles are configured and validated.",
      "",
      "Hub readiness check passed.",
    ]);
    mockCollectHubProjectReadinessCheck.mockResolvedValue({
      sections: [{ title: "Checking repository path", findings: [] }],
      hasWarnings: false,
      hasErrors: false,
    });
    mockFormatHubProjectReadinessCheckLines.mockImplementation(
      (project: { name: string }) => [
        `Hub project readiness check: ${project.name}`,
        "",
        "Checking repository path",
        "  SUCCESS: Repository path exists",
        "    Repository path exists.",
        "",
        "Hub project readiness check passed.",
      ],
    );
  });

  afterEach(() => {
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    vi.clearAllMocks();
  });

  it("defaults to Hub readiness plus the selected Hub project", async () => {
    const repoDir = join(hostDir, "repo-alpha");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await commitFile(
      repoDir,
      "package.json",
      JSON.stringify({ name: "alpha" }, null, 2),
      "initial commit",
    );

    registerHubProject({
      repoPath: repoDir,
      projectName: "alpha",
      env: process.env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });

    const entries = await runCli(["check"]);
    const rendered = entries
      .filter((entry): entry is Extract<DisplayEntry, { _tag: "text" }> =>
        entry._tag === "text",
      )
      .map((entry) => entry.message)
      .join("\n");

    expect(mockCollectHubReadinessChecks).toHaveBeenCalledOnce();
    expect(mockCollectHubProjectReadinessCheck).toHaveBeenCalledOnce();
    expect(rendered).toContain("Hub readiness check");
    expect(rendered).toContain("Hub project readiness check: alpha");
    expect(rendered).not.toContain("No selected Hub project exists");
  });

  it("checks an explicit project without the Hub slice", async () => {
    const repoAlpha = join(hostDir, "repo-alpha");
    const repoBeta = join(hostDir, "repo-beta");
    await mkdir(repoAlpha, { recursive: true });
    await mkdir(repoBeta, { recursive: true });
    await initRepo(repoAlpha);
    await initRepo(repoBeta);
    await commitFile(
      repoAlpha,
      "package.json",
      JSON.stringify({ name: "alpha" }, null, 2),
      "initial alpha",
    );
    await commitFile(
      repoBeta,
      "package.json",
      JSON.stringify({ name: "beta" }, null, 2),
      "initial beta",
    );

    registerHubProject({
      repoPath: repoAlpha,
      projectName: "alpha",
      env: process.env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    registerHubProject({
      repoPath: repoBeta,
      projectName: "beta",
      env: process.env,
      now: new Date("2026-07-04T12:01:00.000Z"),
    });
    selectHubProject({
      projectSelector: "beta",
      env: process.env,
      now: new Date("2026-07-04T12:02:00.000Z"),
    });

    await runCli(["check", "--project", "alpha"]);

    expect(mockCollectHubReadinessChecks).not.toHaveBeenCalled();
    expect(mockCollectHubProjectReadinessCheck).toHaveBeenCalledTimes(1);
    expect(mockCollectHubProjectReadinessCheck.mock.calls[0]?.[0]).toMatchObject({
      name: "alpha",
    });
  });

  it("checks every registered project with --all-projects", async () => {
    const repoAlpha = join(hostDir, "repo-alpha");
    const repoBeta = join(hostDir, "repo-beta");
    await mkdir(repoAlpha, { recursive: true });
    await mkdir(repoBeta, { recursive: true });
    await initRepo(repoAlpha);
    await initRepo(repoBeta);
    await commitFile(
      repoAlpha,
      "package.json",
      JSON.stringify({ name: "alpha" }, null, 2),
      "initial alpha",
    );
    await commitFile(
      repoBeta,
      "package.json",
      JSON.stringify({ name: "beta" }, null, 2),
      "initial beta",
    );

    registerHubProject({
      repoPath: repoAlpha,
      projectName: "alpha",
      env: process.env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    registerHubProject({
      repoPath: repoBeta,
      projectName: "beta",
      env: process.env,
      now: new Date("2026-07-04T12:01:00.000Z"),
    });

    await runCli(["check", "--all-projects"]);

    expect(mockCollectHubReadinessChecks).not.toHaveBeenCalled();
    expect(mockCollectHubProjectReadinessCheck).toHaveBeenCalledTimes(2);
    expect(mockCollectHubProjectReadinessCheck.mock.calls.map((call) => call[0].name)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("warns when no selected project exists and still runs Hub checks", async () => {
    const entries = await runCli(["check"]);
    const rendered = entries
      .filter(
        (entry): entry is Extract<DisplayEntry, { _tag: "status" }> =>
          entry._tag === "status",
      )
      .map((entry) => entry.message)
      .join("\n");

    expect(mockCollectHubReadinessChecks).toHaveBeenCalledOnce();
    expect(mockCollectHubProjectReadinessCheck).not.toHaveBeenCalled();
    expect(rendered).toContain(
      "No selected Hub project exists. Run `archloop project add` to register one, `archloop project select <name>` to choose one, or pass `--project <name>`.",
    );
  });
});
