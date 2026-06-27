import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  configureHubProjectDevelopmentContract,
  HUB_PROJECT_DEVELOPMENT_CONTRACT_FILE_NAME,
  ensureHubProjectDevelopmentContractState,
  resolveHubProjectDevelopmentContractPath,
  resolveHubProjectDevelopmentContractState,
} from "./hubProjectDevelopmentContract.js";

const createRepoRoot = async (prefix: string): Promise<string> => {
  return mkdtemp(join(tmpdir(), prefix));
};

describe("hubProjectDevelopmentContract", () => {
  it("creates a generic default contract when no file exists yet", async () => {
    const repoRoot = await createRepoRoot("hub-contract-default-");
    const hubProjectDir = join(repoRoot, "hub-project");

    const state = resolveHubProjectDevelopmentContractState({
      repoRoot,
      hubProjectDir,
      now: new Date("2026-06-27T10:00:00.000Z"),
    });

    expect(state.persisted).toBe(false);
    expect(state.contractPath).toBe(
      resolveHubProjectDevelopmentContractPath(hubProjectDir),
    );
    expect(state.contractPath).toBe(
      join(hubProjectDir, HUB_PROJECT_DEVELOPMENT_CONTRACT_FILE_NAME),
    );
    expect(state.contract.projectProfile).toBe("generic");
    expect(state.contract.setup[0]).toContain("no-op baseline");
    expect(state.contract.context[0]).toContain("No obvious stack signals");
    expect(state.contract.context[1]).toContain("Generic profile selected");
  });

  it("persists a generic fallback contract when ensuring a missing contract", async () => {
    const repoRoot = await createRepoRoot("hub-contract-ensure-");
    const hubProjectDir = join(repoRoot, "hub-project");

    const ensured = ensureHubProjectDevelopmentContractState({
      repoRoot,
      hubProjectDir,
      now: new Date("2026-06-27T10:00:00.000Z"),
    });

    expect(ensured.persisted).toBe(true);
    expect(ensured.createdGenericFallback).toBe(true);
    expect(ensured.contract.projectProfile).toBe("generic");
    expect(ensured.contractPath).toBe(
      resolveHubProjectDevelopmentContractPath(hubProjectDir),
    );
    expect(await readFile(ensured.contractPath, "utf8")).toContain(
      '"projectProfile": "generic"',
    );
  });

  it("writes a pretty-printed contract and preserves same-profile edits while refreshing facts", async () => {
    const repoRoot = await createRepoRoot("hub-contract-write-");
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify(
        { scripts: { test: "vitest", typecheck: "tsc -p ." } },
        null,
        2,
      ),
    );
    await writeFile(join(repoRoot, "pnpm-lock.yaml"), "lockfile\n");
    const hubProjectDir = join(repoRoot, "hub-project");
    const now = new Date("2026-06-27T10:00:00.000Z");

    const configured = configureHubProjectDevelopmentContract({
      repoRoot,
      hubProjectDir,
      projectProfileName: "node",
      now,
    });

    const contractText = await readFile(configured.contractPath, "utf8");
    expect(contractText).toContain('\n  "projectProfile": "node",\n');
    expect(contractText.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(contractText) as {
      version: number;
      projectProfile: string;
      projectFacts: { observedFiles: string[]; configuredScripts: string[] };
      setup: string[];
      verify: string[];
      context: string[];
      timestamps: { createdAt: string; updatedAt: string };
    };

    expect(parsed.version).toBe(1);
    expect(parsed.projectProfile).toBe("node");
    expect(parsed.projectFacts.observedFiles).toContain("pnpm-lock.yaml");
    expect(parsed.projectFacts.configuredScripts).toEqual([
      "test",
      "typecheck",
    ]);
    expect(parsed.verify.join("\n")).toContain("npm run typecheck");
    expect(parsed.timestamps).toEqual({
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const customContract = {
      ...parsed,
      setup: ["custom setup line"],
      verify: ["custom verify line"],
      context: ["custom context line"],
    };
    await writeFile(
      configured.contractPath,
      `${JSON.stringify(customContract, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(repoRoot, "pyproject.toml"),
      "[tool.pytest.ini_options]\n",
    );
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify(
        {
          scripts: {
            test: "vitest run",
            typecheck: "tsc -p . --noEmit",
          },
        },
        null,
        2,
      ),
    );

    const updated = configureHubProjectDevelopmentContract({
      repoRoot,
      hubProjectDir,
      projectProfileName: "node",
      now: new Date("2026-06-27T11:00:00.000Z"),
    });

    expect(updated.contract.setup).toEqual(["custom setup line"]);
    expect(updated.contract.verify).toEqual(["custom verify line"]);
    expect(updated.contract.context).toEqual(["custom context line"]);
    expect(updated.contract.projectFacts.observedFiles).toEqual(
      expect.arrayContaining([
        "package.json",
        "pnpm-lock.yaml",
        "pyproject.toml",
      ]),
    );
    expect(updated.contract.projectFacts.configuredScripts).toEqual([
      "test",
      "typecheck",
    ]);
    expect(updated.contract.timestamps.createdAt).toBe(now.toISOString());
    expect(updated.contract.timestamps.updatedAt).toBe(
      "2026-06-27T11:00:00.000Z",
    );
  });

  it("backs up the previous contract before replacing it with a different profile", async () => {
    const repoRoot = await createRepoRoot("hub-contract-backup-");
    await writeFile(join(repoRoot, "package.json"), "{}\n");
    const hubProjectDir = join(repoRoot, "hub-project");
    const initialNow = new Date("2026-06-27T10:00:00.000Z");

    const initial = configureHubProjectDevelopmentContract({
      repoRoot,
      hubProjectDir,
      projectProfileName: "node",
      now: initialNow,
    });

    const customContract = {
      ...JSON.parse(await readFile(initial.contractPath, "utf8")),
      setup: ["custom node setup"],
      verify: ["custom node verify"],
      context: ["custom node context"],
    };
    await writeFile(
      initial.contractPath,
      `${JSON.stringify(customContract, null, 2)}\n`,
      "utf8",
    );

    const changed = configureHubProjectDevelopmentContract({
      repoRoot,
      hubProjectDir,
      projectProfileName: "python",
      now: new Date("2026-06-27T11:00:00.000Z"),
    });

    expect(changed.backupPath).toBeDefined();
    expect(changed.backupPath).not.toBe(changed.contractPath);

    const backupText = await readFile(changed.backupPath!, "utf8");
    const backupContract = JSON.parse(backupText) as {
      projectProfile: string;
      setup: string[];
      verify: string[];
      context: string[];
    };
    expect(backupContract.projectProfile).toBe("node");
    expect(backupContract.setup).toEqual(["custom node setup"]);
    expect(backupContract.verify).toEqual(["custom node verify"]);
    expect(backupContract.context).toEqual(["custom node context"]);

    const changedContract = JSON.parse(
      await readFile(changed.contractPath, "utf8"),
    ) as {
      projectProfile: string;
      setup: string[];
      verify: string[];
      context: string[];
    };
    expect(changedContract.projectProfile).toBe("python");
    expect(changedContract.setup).not.toEqual(["custom node setup"]);
    expect(changedContract.verify).not.toEqual(["custom node verify"]);
    expect(changedContract.context).not.toEqual(["custom node context"]);
  });

  it("accepts existing contracts written before configuredScripts was added", async () => {
    const repoRoot = await createRepoRoot("hub-contract-compat-");
    const hubProjectDir = join(repoRoot, "hub-project");
    const contractPath = join(
      hubProjectDir,
      HUB_PROJECT_DEVELOPMENT_CONTRACT_FILE_NAME,
    );
    await mkdir(hubProjectDir, { recursive: true });
    await writeFile(
      contractPath,
      `${JSON.stringify(
        {
          version: 1,
          projectProfile: "node",
          projectFacts: { observedFiles: ["package.json"] },
          setup: ["legacy setup"],
          verify: ["legacy verify"],
          context: ["legacy context"],
          timestamps: {
            createdAt: "2026-06-27T10:00:00.000Z",
            updatedAt: "2026-06-27T10:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(repoRoot, "package.json"), "{}\n");

    const configured = configureHubProjectDevelopmentContract({
      repoRoot,
      hubProjectDir,
      projectProfileName: "node",
      now: new Date("2026-06-27T11:00:00.000Z"),
    });

    expect(configured.contract.projectFacts.configuredScripts).toEqual([]);
    expect(configured.contract.setup).toEqual(["legacy setup"]);
    expect(configured.contract.verify).toEqual(["legacy verify"]);
    expect(configured.contract.context).toEqual(["legacy context"]);
  });

  it("rejects unknown project profiles with the supported profile list", async () => {
    const repoRoot = await createRepoRoot("hub-contract-unknown-");
    const hubProjectDir = join(repoRoot, "hub-project");

    expect(() =>
      configureHubProjectDevelopmentContract({
        repoRoot,
        hubProjectDir,
        projectProfileName: "rust",
      }),
    ).toThrowError(
      'Unknown project profile "rust". Available: generic, node, python, cpp',
    );
  });
});
