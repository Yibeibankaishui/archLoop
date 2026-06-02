import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMiniprogramSetupActions,
  detectMiniprogramInitSnapshot,
  renderMiniprogramSetupChecklist,
  validateMiniprogramCapabilityBundle,
} from "./miniprogramScaffold.js";

const makeRepo = () => mkdtemp(join(tmpdir(), "miniprogram-scaffold-"));

describe("validateMiniprogramCapabilityBundle", () => {
  it("passes when required bundle files exist", () => {
    expect(() => validateMiniprogramCapabilityBundle()).not.toThrow();
  });
});

describe("detectMiniprogramInitSnapshot", () => {
  it("reports missing appid and miniprogram-ci when repo is empty", async () => {
    const repoDir = await makeRepo();
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    expect(snapshot.miniprogramCi.status).toBe("missing");
    expect(snapshot.appid.status).toBe("missing");
    expect(snapshot.uploadKey.status).toBe("missing");
    expect(snapshot.wxCheckScriptPresent).toBe(false);
  });

  it("reads appid from project.config.json and detects wx:check script", async () => {
    const repoDir = await makeRepo();
    await writeFile(
      join(repoDir, "project.config.json"),
      JSON.stringify({ appid: "wxtest1234567890", miniprogramRoot: "./" }),
    );
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        scripts: { "wx:check": "node scripts/check.js" },
      }),
    );
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    expect(snapshot.appid.status).toBe("project_config");
    expect(snapshot.appid.effectiveAppid).toBe("wxtest1234567890");
    expect(snapshot.wxCheckScriptPresent).toBe(true);
  });

  it("treats placeholder appid as missing", async () => {
    const repoDir = await makeRepo();
    await writeFile(
      join(repoDir, "project.config.json"),
      JSON.stringify({ appid: "touristappid" }),
    );
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    expect(snapshot.appid.status).toBe("placeholder");
  });
});

describe("miniprogram setup checklist and manifest actions", () => {
  it("includes detection results, next steps, and upload-key safety reminders", async () => {
    const repoDir = await makeRepo();
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    const checklist = renderMiniprogramSetupChecklist(snapshot);
    expect(checklist).toContain("Init-time snapshot");
    expect(checklist).toContain("miniprogram-ci");
    expect(checklist).toContain("WX_APPID");
    expect(checklist).toContain("WX_UPLOAD_KEY_PATH");
    expect(checklist).toContain("private.*.key");
    expect(checklist).toContain("IP allowlist");

    const actions = buildMiniprogramSetupActions(snapshot);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: "miniprogram-ci-install",
      status: "skipped",
      reason: "user_declined",
    });
  });

  it("records already_available when project-local miniprogram-ci resolves", async () => {
    const repoDir = await makeRepo();
    await mkdir(join(repoDir, "node_modules", "miniprogram-ci"), {
      recursive: true,
    });
    await writeFile(
      join(repoDir, "node_modules", "miniprogram-ci", "package.json"),
      JSON.stringify({ name: "miniprogram-ci", version: "2.0.0" }),
    );
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    expect(snapshot.miniprogramCi.status).toBe("available");
    const actions = buildMiniprogramSetupActions(snapshot);
    expect(actions[0]).toMatchObject({
      id: "miniprogram-ci-install",
      status: "skipped",
      reason: "already_available",
    });
  });
});
