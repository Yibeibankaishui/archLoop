import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  configureHubProjectDevelopmentContract,
  HUB_PROJECT_DEVELOPMENT_CONTRACT_FILE_NAME,
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

  it("writes a pretty-printed contract and preserves same-profile edits", async () => {
    const repoRoot = await createRepoRoot("hub-contract-write-");
    await writeFile(join(repoRoot, "package.json"), "{}\n");
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
      projectFacts: { observedFiles: string[] };
      setup: string[];
      verify: string[];
      context: string[];
      timestamps: { createdAt: string; updatedAt: string };
    };

    expect(parsed.version).toBe(1);
    expect(parsed.projectProfile).toBe("node");
    expect(parsed.projectFacts.observedFiles).toContain("pnpm-lock.yaml");
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

    const updated = configureHubProjectDevelopmentContract({
      repoRoot,
      hubProjectDir,
      projectProfileName: "node",
      now: new Date("2026-06-27T11:00:00.000Z"),
    });

    expect(updated.contract.setup).toEqual(["custom setup line"]);
    expect(updated.contract.verify).toEqual(["custom verify line"]);
    expect(updated.contract.context).toEqual(["custom context line"]);
    expect(updated.contract.timestamps.createdAt).toBe(now.toISOString());
    expect(updated.contract.timestamps.updatedAt).toBe(
      "2026-06-27T11:00:00.000Z",
    );
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
