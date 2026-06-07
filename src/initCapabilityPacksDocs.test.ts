import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = join(import.meta.dirname, "..", "README.md");

describe("Capability pack init documentation", () => {
  it("README documents capability packs, Mini Program init, and verification", async () => {
    const readme = await readFile(readmePath, "utf-8");

    // Init concepts and CLI flags
    expect(readme).toMatch(/Capability pack/i);
    expect(readme).toMatch(/Project profile/i);
    expect(readme).toContain("Preset agent");
    expect(readme).toContain("Capability add-on");
    expect(readme).toMatch(/not.*auto-detect or infer/i);
    expect(readme).toContain("--capability");
    expect(readme).toContain("--capability-addons");
    expect(readme).toContain("--install-miniprogram-ci");
    expect(readme).toContain("generic");
    expect(readme).toContain("miniprogram");
    expect(readme).toContain("runtime-debug");

    // Mini Program setup and credentials
    expect(readme).toContain("miniprogram-ci");
    expect(readme).toContain("WX_APPID");
    expect(readme).toContain("WX_UPLOAD_KEY_PATH");
    expect(readme).toMatch(/upload key/i);
    expect(readme).toMatch(/IP allowlist/i);
    expect(readme).toContain(".sandcastle/context/miniprogram-setup.md");

    // Verification loop and summary
    expect(readme).toContain(".sandcastle/verify.sh");
    expect(readme).toContain("debug/wx-check.log");
    expect(readme).toContain("debug/wx-preview.jpg");
    expect(readme).toContain("platform_validation_status");
    expect(readme).toMatch(/final verification summary/i);

    // Scope boundaries
    expect(readme).toMatch(/CloudBase.*out of scope/i);
  });
});
