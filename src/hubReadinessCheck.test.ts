import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectHubReadinessChecks,
  formatHubReadinessCheckLines,
} from "./hubReadinessCheck.js";

const makeStore = async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "hub-readiness-check-"));
  const dataDir = join(homeDir, "xdg-data");
  await mkdir(dataDir, { recursive: true });
  return {
    homeDir,
    env: { ...process.env, XDG_DATA_HOME: dataDir },
  };
};

describe("hubReadinessCheck", () => {
  it("reports missing Hub agent roles with repair guidance", async () => {
    const { env } = await makeStore();

    const report = collectHubReadinessChecks({ env });
    const output = formatHubReadinessCheckLines(report).join("\n");

    expect(report.hasErrors).toBe(true);
    expect(report.hasWarnings).toBe(false);
    expect(output).toContain("Missing Hub agent role config");
    expect(output).toContain("archloop agent-config init");
    expect(output).toContain(
      "archloop agent-config set-role planning --provider <provider> --model <model>",
    );
  });
});
