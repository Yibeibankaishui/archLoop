import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMiniprogramCiInstallCommand,
  detectMiniprogramInitSnapshot,
  executeMiniprogramCiInstallSetup,
  renderMiniprogramSetupChecklist,
  resolveMiniprogramInstallPackageManager,
  runMiniprogramCiInstall,
  setDetectGlobalMiniprogramCiCliForTests,
  setMiniprogramCiInstallRunnerForTests,
  shouldScaffoldMiniprogramRuntimeDebug,
  validateMiniprogramCapabilityBundle,
} from "./miniprogramScaffold.js";
import {
  RUNTIME_DEBUG_ADDON_ID,
  resolveCapabilityInitOptions,
} from "./capabilityPacks.js";

afterEach(() => {
  setMiniprogramCiInstallRunnerForTests(undefined);
  setDetectGlobalMiniprogramCiCliForTests(undefined);
});

const makeRepo = () => mkdtemp(join(tmpdir(), "miniprogram-scaffold-"));

const writeValidMiniprogramCiPackage = async (repoDir: string) => {
  const pkgDir = join(repoDir, "node_modules", "miniprogram-ci");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "index.cjs"),
    `module.exports = {
  Project: function Project() {},
  preview: function preview() {},
  packNpm: function packNpm() {},
};`,
  );
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "miniprogram-ci",
      version: "2.0.0",
      main: "index.cjs",
    }),
  );
};

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

  it("sets globalCliAvailable when mocked global CLI is on PATH", async () => {
    const repoDir = await makeRepo();
    setDetectGlobalMiniprogramCiCliForTests(() => true);
    expect(detectMiniprogramInitSnapshot(repoDir).globalCliAvailable).toBe(
      true,
    );
  });

  it("clears globalCliAvailable when mocked global CLI is absent", async () => {
    const repoDir = await makeRepo();
    setDetectGlobalMiniprogramCiCliForTests(() => false);
    expect(detectMiniprogramInitSnapshot(repoDir).globalCliAvailable).toBe(
      false,
    );
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

  it("treats package without Node API members as detected_but_unusable", async () => {
    const repoDir = await makeRepo();
    await mkdir(join(repoDir, "node_modules", "miniprogram-ci"), {
      recursive: true,
    });
    await writeFile(
      join(repoDir, "node_modules", "miniprogram-ci", "package.json"),
      JSON.stringify({
        name: "miniprogram-ci",
        version: "2.0.0",
        main: "missing.js",
      }),
    );
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    expect(snapshot.miniprogramCi.status).toBe("detected_but_unusable");
  });

  it("records already_available when project-local miniprogram-ci exposes Node API", async () => {
    const repoDir = await makeRepo();
    await writeValidMiniprogramCiPackage(repoDir);
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    expect(snapshot.miniprogramCi.status).toBe("available");
    expect(snapshot.miniprogramCi.version).toBe("2.0.0");
  });
});

describe("resolveMiniprogramInstallPackageManager", () => {
  it("prefers package.json packageManager over lockfiles", async () => {
    const repoDir = await makeRepo();
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    );
    await writeFile(join(repoDir, "yarn.lock"), "");
    expect(resolveMiniprogramInstallPackageManager(repoDir)).toBe("pnpm");
  });

  it("chooses pnpm, yarn, or npm from lockfiles when packageManager is absent", async () => {
    const pnpmRepo = await makeRepo();
    await writeFile(join(pnpmRepo, "package.json"), "{}");
    await writeFile(join(pnpmRepo, "pnpm-lock.yaml"), "lockfileVersion: 6.0\n");
    expect(resolveMiniprogramInstallPackageManager(pnpmRepo)).toBe("pnpm");

    const yarnRepo = await makeRepo();
    await writeFile(join(yarnRepo, "package.json"), "{}");
    await writeFile(join(yarnRepo, "yarn.lock"), "");
    expect(resolveMiniprogramInstallPackageManager(yarnRepo)).toBe("yarn");

    const npmRepo = await makeRepo();
    await writeFile(join(npmRepo, "package.json"), "{}");
    expect(resolveMiniprogramInstallPackageManager(npmRepo)).toBe("npm");
  });
});

describe("buildMiniprogramCiInstallCommand", () => {
  it("maps package managers to documented install commands", () => {
    expect(buildMiniprogramCiInstallCommand("pnpm")).toBe(
      "pnpm add -D miniprogram-ci",
    );
    expect(buildMiniprogramCiInstallCommand("yarn")).toBe(
      "yarn add -D miniprogram-ci",
    );
    expect(buildMiniprogramCiInstallCommand("npm")).toBe(
      "npm install -D miniprogram-ci",
    );
  });
});

describe("renderMiniprogramSetupChecklist", () => {
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
  });

  it("warns that global CLI does not satisfy managed verification when detected", async () => {
    const repoDir = await makeRepo();
    setDetectGlobalMiniprogramCiCliForTests(() => true);
    const checklist = renderMiniprogramSetupChecklist(
      detectMiniprogramInitSnapshot(repoDir),
    );
    expect(checklist).toContain("global CLI was detected");
    expect(checklist).toContain("project-local");
  });
});

describe("executeMiniprogramCiInstallSetup", () => {
  it("records user_declined when install is not approved", async () => {
    const repoDir = await makeRepo();
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    const action = executeMiniprogramCiInstallSetup({
      repoDir,
      snapshot,
    });
    expect(action).toMatchObject({
      id: "miniprogram-ci-install",
      status: "skipped",
      reason: "user_declined",
    });
  });

  it("records global CLI guidance when user declines install on a host with global CLI", async () => {
    const repoDir = await makeRepo();
    setDetectGlobalMiniprogramCiCliForTests(() => true);
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    const action = executeMiniprogramCiInstallSetup({ repoDir, snapshot });
    expect(action.summary).toContain("global CLI was detected");
    expect(action.summary).toContain("project-local");
  });

  it("records already_available when project-local miniprogram-ci resolves", async () => {
    const repoDir = await makeRepo();
    await writeValidMiniprogramCiPackage(repoDir);
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    const action = executeMiniprogramCiInstallSetup({ repoDir, snapshot });
    expect(action).toMatchObject({
      id: "miniprogram-ci-install",
      status: "skipped",
      reason: "already_available",
    });
  });

  it("records no_package_json when user approves install without package.json", async () => {
    const repoDir = await makeRepo();
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    const action = executeMiniprogramCiInstallSetup({
      repoDir,
      snapshot,
      userApprovedInstall: true,
    });
    expect(action).toMatchObject({
      status: "skipped",
      reason: "no_package_json",
    });
  });

  it("records install_command_failed without storing full stderr", async () => {
    const repoDir = await makeRepo();
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "wx-app" }),
    );
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    setMiniprogramCiInstallRunnerForTests(() => ({
      ok: false,
      stderrSummary: "line one line two line three line four",
    }));

    const action = executeMiniprogramCiInstallSetup({
      repoDir,
      snapshot,
      userApprovedInstall: true,
    });

    expect(action).toMatchObject({
      status: "failed",
      reason: "install_command_failed",
      packageManager: "npm",
      command: "npm install -D miniprogram-ci",
    });
    expect(action.summary?.split("\n")).toHaveLength(1);
    expect(action.summary?.length).toBeLessThanOrEqual(240);
  });

  it("records installed when user-approved install succeeds", async () => {
    const repoDir = await makeRepo();
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "wx-app", packageManager: "pnpm@9.0.0" }),
    );
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    setMiniprogramCiInstallRunnerForTests(() => ({ ok: true }));

    const action = executeMiniprogramCiInstallSetup({
      repoDir,
      snapshot,
      userApprovedInstall: true,
    });

    expect(action).toMatchObject({
      status: "succeeded",
      reason: "installed",
      packageManager: "pnpm",
      command: "pnpm add -D miniprogram-ci",
    });
  });
});

describe("runMiniprogramCiInstall", () => {
  it("returns ok when the install runner succeeds", async () => {
    const repoDir = await makeRepo();
    setMiniprogramCiInstallRunnerForTests(() => ({ ok: true }));
    expect(runMiniprogramCiInstall(repoDir, "npm").ok).toBe(true);
  });
});

describe("shouldScaffoldMiniprogramRuntimeDebug", () => {
  it("is false without explicit miniprogram init or runtime-debug add-on", () => {
    expect(shouldScaffoldMiniprogramRuntimeDebug(undefined)).toBe(false);
    expect(
      shouldScaffoldMiniprogramRuntimeDebug(
        resolveCapabilityInitOptions({ capabilityId: "miniprogram" }),
      ),
    ).toBe(false);
    expect(
      shouldScaffoldMiniprogramRuntimeDebug(
        resolveCapabilityInitOptions({
          capabilityId: "miniprogram",
          addonIds: [RUNTIME_DEBUG_ADDON_ID],
          sandboxProviderName: "no-sandbox",
        }),
      ),
    ).toBe(true);
  });
});
