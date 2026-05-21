import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = join(import.meta.dirname, "..", "README.md");

describe("Project profile init documentation", () => {
  it("README documents Project profile initialization behavior", async () => {
    const readme = await readFile(readmePath, "utf-8");

    expect(readme).toMatch(/Project profile/i);
    expect(readme).toContain("--project-profile");
    expect(readme).toContain("generic");
    expect(readme).toContain("node");
    expect(readme).toContain("python");
    expect(readme).toContain("cpp");
    expect(readme).toMatch(/default.*generic|generic.*default/i);
    expect(readme).toMatch(/not.*auto-detect/i);
    expect(readme).toContain("bootstrap.sh");
    expect(readme).toMatch(/Dockerfile|Containerfile/);
    expect(readme).toMatch(/onSandboxReady/);
    expect(readme).toMatch(/timeoutMs:\s*300_000/);
    expect(readme).toMatch(/60\s*s|60 second/i);
    expect(readme).toMatch(/worktree.*mount|mount.*worktree/i);
    expect(readme).toMatch(/not.*image build|image build.*not/i);
    expect(readme).toMatch(/not.*run.*validate|does not run or validate/i);
    expect(readme).toMatch(/user-editable|editable scaffold/i);
    expect(readme).toMatch(/\.env\.example/);
    expect(readme).toMatch(/copy-to-worktree|copyToWorktree/);
    expect(readme).toMatch(/public runtime|run\(\)|runtime APIs/i);
    expect(readme).toMatch(/AI-generated|auto.?detect/i);
  });
});
