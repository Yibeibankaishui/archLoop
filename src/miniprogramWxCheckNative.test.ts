import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getMiniprogramCapabilityBundlesRoot } from "./miniprogramScaffold.js";

const execFileAsync = promisify(execFile);

type WxCheckLogEvent = {
  type: string;
  severity: string;
  message: string;
  diagnostic?: string;
  platform_validation_status?: string;
  artifact?: string;
  appid?: string;
};

const EFFECTIVE_APPID = "wxabcdef1234567890";
const OTHER_APPID = "wxotherapp123456789";

const parseWxCheckLog = (content: string): WxCheckLogEvent[] =>
  content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WxCheckLogEvent);

const readWxCheckEvents = async (
  repoDir: string,
): Promise<WxCheckLogEvent[]> => {
  const log = await readFile(join(repoDir, "debug", "wx-check.log"), "utf-8");
  return parseWxCheckLog(log);
};

const makeRepo = () => mkdtemp(join(tmpdir(), "wx-check-native-"));

const installNativeVerifier = async (repoDir: string) => {
  const bundleRoot = getMiniprogramCapabilityBundlesRoot();
  const configDir = join(repoDir, ".sandcastle");
  await mkdir(configDir, { recursive: true });
  await copyFile(
    join(bundleRoot, "wx-check-native.mjs"),
    join(configDir, "wx-check-native.mjs"),
  );
};

const runNativeCheck = async (
  repoDir: string,
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number }> => {
  try {
    await execFileAsync(
      "node",
      [join(repoDir, ".sandcastle", "wx-check-native.mjs")],
      {
        cwd: repoDir,
        env: { ...process.env, ...env },
      },
    );
    return { exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    const code = typeof err.code === "number" ? err.code : err.status;
    return { exitCode: code ?? 1 };
  }
};

const writeMinimalNativeProject = async (
  repoDir: string,
  options?: {
    projectConfig?: Record<string, unknown>;
    appJson?: Record<string, unknown>;
    miniprogramSubdir?: string;
  },
) => {
  const mpRoot = options?.miniprogramSubdir ?? ".";
  const mpDir =
    mpRoot === "." ? repoDir : join(repoDir, mpRoot.replace(/\/$/, ""));
  await mkdir(mpDir, { recursive: true });
  await writeFile(
    join(repoDir, "project.config.json"),
    JSON.stringify({
      appid: EFFECTIVE_APPID,
      miniprogramRoot: mpRoot === "." ? "./" : `${mpRoot.replace(/\/$/, "")}/`,
      ...options?.projectConfig,
    }),
  );
  await writeFile(
    join(mpDir, "app.json"),
    JSON.stringify({
      pages: ["pages/index/index"],
      window: { navigationBarTitleText: "Test" },
      ...options?.appJson,
    }),
  );
  const pageDir = join(mpDir, "pages/index");
  await mkdir(pageDir, { recursive: true });
  await writeFile(join(pageDir, "index.json"), "{}");
  await writeFile(join(pageDir, "index.wxml"), "<view></view>");
};

const lastDiagnostic = (events: WxCheckLogEvent[]) =>
  events.filter((e) => e.severity === "error").at(-1)?.diagnostic;

const platformStatus = (events: WxCheckLogEvent[]) =>
  events.find((e) => e.platform_validation_status)?.platform_validation_status;

const setupPlatformValidationRepo = async (
  repoDir: string,
  options?: {
    projectConfig?: Record<string, unknown>;
    appJson?: Record<string, unknown>;
    uploadKeyAppid?: string;
    withUploadKey?: boolean;
    withMockCi?: boolean;
  },
) => {
  await installNativeVerifier(repoDir);
  await writeMinimalNativeProject(repoDir, {
    projectConfig: options?.projectConfig,
    appJson: options?.appJson,
  });
  if (options?.withUploadKey !== false) {
    await writeUploadKey(repoDir, options?.uploadKeyAppid ?? EFFECTIVE_APPID);
  }
  if (options?.withMockCi !== false) {
    await writeMockMiniprogramCi(repoDir);
  }
  return join(repoDir, ".sandcastle", "mock-ci-state.json");
};

const writeHostPackageJson = async (repoDir: string) => {
  await writeFile(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "wx-check-test-host" }),
  );
};

const writeUploadKey = async (
  repoDir: string,
  appid: string,
  content = "fake-key",
) => {
  const keyDir = join(repoDir, ".sandcastle", "auth", "wx-upload");
  await mkdir(keyDir, { recursive: true });
  await writeFile(join(keyDir, `private.${appid}.key`), content);
};

const writeMockMiniprogramCi = async (repoDir: string) => {
  await writeHostPackageJson(repoDir);
  const pkgDir = join(repoDir, "node_modules", "miniprogram-ci");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "index.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.WX_MOCK_CI_STATE;
const readState = () =>
  statePath && fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : {};
const writeState = (patch) => {
  if (!statePath) return;
  const next = { ...readState(), ...patch };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(next));
};
module.exports = {
  Project: function Project(opts) {
    writeState({ project: opts });
    return {};
  },
  packNpm: async function packNpm() {
    writeState({ packNpmCalled: true });
    if (process.env.WX_MOCK_CI_MODE === "pack_npm_fail") {
      throw new Error("packNpm failed");
    }
  },
  preview: async function preview(opts) {
    writeState({ preview: opts });
    if (process.env.WX_MOCK_CI_MODE === "preview_fail") {
      throw new Error("preview failed");
    }
    if (process.env.WX_MOCK_CI_MODE !== "no_preview_artifact") {
      fs.mkdirSync(path.dirname(opts.qrcodeOutputDest), { recursive: true });
      fs.writeFileSync(opts.qrcodeOutputDest, "fake-jpg");
    }
  },
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

const readMockCiState = async (repoDir: string) => {
  const statePath = join(repoDir, ".sandcastle", "mock-ci-state.json");
  const content = await readFile(statePath, "utf-8");
  return JSON.parse(content) as {
    project?: Record<string, unknown>;
    preview?: Record<string, unknown>;
    packNpmCalled?: boolean;
  };
};

describe("wx-check-native.mjs static fallback verifier", () => {
  it("passes for a minimal native Mini Program project", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir);

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(0);

    const events = await readWxCheckEvents(repoDir);
    expect(events.some((e) => e.diagnostic === "native_check_passed")).toBe(
      true,
    );
  });

  it("uses WX_PROJECT_CONFIG when set", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    const appDir = join(repoDir, "apps", "demo");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "project.config.json"),
      JSON.stringify({
        appid: "wxabcdef1234567890",
        miniprogramRoot: "./",
      }),
    );
    await writeFile(
      join(appDir, "app.json"),
      JSON.stringify({
        pages: ["pages/index/index"],
        window: { navigationBarTitleText: "Demo" },
      }),
    );
    const pageDir = join(appDir, "pages", "index");
    await mkdir(pageDir, { recursive: true });
    await writeFile(join(pageDir, "index.json"), "{}");
    await writeFile(join(pageDir, "index.wxml"), "<view></view>");

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_PROJECT_CONFIG: "apps/demo/project.config.json",
    });
    expect(exitCode).toBe(0);
  });

  it("checks only repository root project.config.json when WX_PROJECT_CONFIG is absent", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir);
    await mkdir(join(repoDir, "nested-only"), { recursive: true });
    await writeFile(
      join(repoDir, "nested-only", "project.config.json"),
      JSON.stringify({ appid: "wx0000000000000000" }),
    );

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(0);
  });

  it("reports project_config_missing when no project.config.json exists", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("project_config_missing");
  });

  it("reports project_config_ambiguous for WX_PROJECT_CONFIG directory with multiple configs", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await mkdir(join(repoDir, "configs", "a"), { recursive: true });
    await mkdir(join(repoDir, "configs", "b"), { recursive: true });
    await writeFile(
      join(repoDir, "configs", "project.config.json"),
      JSON.stringify({ appid: "wxabcdef1234567890", miniprogramRoot: "./" }),
    );
    await writeFile(
      join(repoDir, "configs", "a", "project.config.json"),
      JSON.stringify({ appid: "wxabcdef1234567890", miniprogramRoot: "./" }),
    );

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_PROJECT_CONFIG: "configs",
    });
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("project_config_ambiguous");
  });

  it("reports project_config_outside_repo when WX_PROJECT_CONFIG escapes the repo", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_PROJECT_CONFIG: "../outside/project.config.json",
    });
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("project_config_outside_repo");
  });

  it("reports miniprogram_root_missing when miniprogramRoot directory is absent", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeFile(
      join(repoDir, "project.config.json"),
      JSON.stringify({
        appid: "wxabcdef1234567890",
        miniprogramRoot: "missing-miniprogram/",
      }),
    );

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("miniprogram_root_missing");
  });

  it("reports miniprogram_root_outside_repo when miniprogramRoot escapes the repo", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeFile(
      join(repoDir, "project.config.json"),
      JSON.stringify({
        appid: "wxabcdef1234567890",
        miniprogramRoot: "../",
      }),
    );

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("miniprogram_root_outside_repo");
  });

  it("rejects Taro dependency signals with unsupported_miniprogram_variant", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir);
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        dependencies: { "@tarojs/taro": "4.0.0" },
      }),
    );

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("unsupported_miniprogram_variant");
  });

  it("rejects uni-app manifest.json and pages.json signals", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir);
    await writeFile(join(repoDir, "manifest.json"), "{}");
    await writeFile(join(repoDir, "pages.json"), "{}");

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("unsupported_miniprogram_variant");
  });

  it("rejects mpvue dependency signals", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir);
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ devDependencies: { mpvue: "2.0.0" } }),
    );

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("unsupported_miniprogram_variant");
  });

  it("rejects cross-framework build output miniprogramRoot", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await mkdir(join(repoDir, "dist", "build", "mp-weixin"), {
      recursive: true,
    });
    await writeFile(
      join(repoDir, "project.config.json"),
      JSON.stringify({
        appid: "wxabcdef1234567890",
        miniprogramRoot: "dist/build/mp-weixin/",
      }),
    );
    await writeFile(
      join(repoDir, "dist", "build", "mp-weixin", "app.json"),
      JSON.stringify({ pages: ["pages/index/index"] }),
    );

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("unsupported_miniprogram_variant");
  });

  it("reports missing page JSON as a project-shape failure", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir);
    await unlink(join(repoDir, "pages", "index", "index.json"));

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("page_json_missing");
  });

  it("reports tabBar page paths not declared in app.json pages", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir, {
      appJson: {
        pages: ["pages/index/index"],
        tabBar: {
          list: [{ pagePath: "pages/other/other", text: "Other" }],
        },
      },
    });

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("tabbar_page_not_declared");
  });

  it("reports missing tabBar icon assets", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir, {
      appJson: {
        pages: ["pages/index/index"],
        tabBar: {
          list: [
            {
              pagePath: "pages/index/index",
              text: "Home",
              iconPath: "assets/home.png",
              selectedIconPath: "assets/home-active.png",
            },
          ],
        },
      },
    });

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("tabbar_icon_missing");
  });

  it("reports unresolved local usingComponents", async () => {
    const repoDir = await makeRepo();
    await installNativeVerifier(repoDir);
    await writeMinimalNativeProject(repoDir);
    await writeFile(
      join(repoDir, "pages", "index", "index.json"),
      JSON.stringify({
        usingComponents: { panel: "/components/panel/panel" },
      }),
    );

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("component_json_missing");
  });
});

describe("wx-check-native.mjs miniprogram-ci platform validation", () => {
  it("warns appid_missing and keeps not_configured when AppID is absent", async () => {
    const repoDir = await makeRepo();
    await setupPlatformValidationRepo(repoDir, {
      projectConfig: { appid: undefined },
      withUploadKey: false,
      withMockCi: false,
    });

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(0);

    const events = await readWxCheckEvents(repoDir);
    expect(events.some((e) => e.diagnostic === "appid_missing")).toBe(true);
    expect(platformStatus(events)).toBe("not_configured");
  });

  it("treats placeholder AppID as missing with not_configured", async () => {
    const repoDir = await makeRepo();
    await setupPlatformValidationRepo(repoDir, {
      projectConfig: { appid: "touristappid" },
      withUploadKey: false,
      withMockCi: false,
    });

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(0);

    const events = await readWxCheckEvents(repoDir);
    expect(events.some((e) => e.diagnostic === "appid_missing")).toBe(true);
    expect(platformStatus(events)).toBe("not_configured");
  });

  it("prefers WX_APPID over project.config.json appid", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir, {
      projectConfig: { appid: OTHER_APPID },
    });

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_APPID: EFFECTIVE_APPID,
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(0);

    const state = await readMockCiState(repoDir);
    expect(state.project?.appid).toBe(EFFECTIVE_APPID);
  });

  it("prefers WX_UPLOAD_KEY_PATH over repository-local key", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir);
    const externalKey = join(repoDir, "keys", "upload.key");
    await mkdir(join(repoDir, "keys"), { recursive: true });
    await writeFile(externalKey, "external-key");
    await writeUploadKey(repoDir, EFFECTIVE_APPID, "repo-local-key");

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_UPLOAD_KEY_PATH: externalKey,
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(0);

    const state = await readMockCiState(repoDir);
    expect(state.project?.privateKeyPath).toBe(externalKey);
  });

  it("warns upload_key_appid_mismatch for other local keys", async () => {
    const repoDir = await makeRepo();
    await setupPlatformValidationRepo(repoDir, {
      uploadKeyAppid: OTHER_APPID,
      withMockCi: false,
    });

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(0);

    const events = await readWxCheckEvents(repoDir);
    expect(
      events.some((e) => e.diagnostic === "upload_key_appid_mismatch"),
    ).toBe(true);
    expect(platformStatus(events)).toBe("not_configured");
  });

  it("reports configured_missing_tool when miniprogram-ci is unavailable", async () => {
    const repoDir = await makeRepo();
    await setupPlatformValidationRepo(repoDir, { withMockCi: false });

    const { exitCode } = await runNativeCheck(repoDir);
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(platformStatus(events)).toBe("configured_missing_tool");
  });

  it("runs preview and records passed with QR artifact", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir);

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(0);

    const events = await readWxCheckEvents(repoDir);
    expect(platformStatus(events)).toBe("passed");
    expect(
      events.some(
        (e) => e.artifact === "debug/wx-preview.jpg" && e.severity === "info",
      ),
    ).toBe(true);
    await stat(join(repoDir, "debug", "wx-preview.jpg"));

    const state = await readMockCiState(repoDir);
    expect(state.project).toMatchObject({
      appid: EFFECTIVE_APPID,
      type: "miniProgram",
      projectPath: repoDir,
      privateKeyPath: join(
        repoDir,
        ".sandcastle",
        "auth",
        "wx-upload",
        `private.${EFFECTIVE_APPID}.key`,
      ),
    });
    expect(state.preview).toMatchObject({
      qrcodeFormat: "image",
      qrcodeOutputDest: join(repoDir, "debug", "wx-preview.jpg"),
    });
  });

  it("reports configured_invalid when preview fails", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir);

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_MOCK_CI_MODE: "preview_fail",
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(platformStatus(events)).toBe("configured_invalid");
  });

  it("reports preview_artifact_write_failed when preview omits QR file", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir);

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_MOCK_CI_MODE: "no_preview_artifact",
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("preview_artifact_write_failed");
    expect(platformStatus(events)).toBe("configured_invalid");
  });

  it("forces packNpm when WX_PACK_NPM=1", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir);

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_PACK_NPM: "1",
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(0);

    const state = await readMockCiState(repoDir);
    expect(state.packNpmCalled).toBe(true);
  });

  it("skips packNpm when WX_PACK_NPM=0", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir);
    await writeHostPackageJson(repoDir);
    await writeFile(
      join(repoDir, "pages", "index", "index.json"),
      JSON.stringify({ usingComponents: { ui: "weui/button" } }),
    );

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_PACK_NPM: "0",
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(0);

    const state = await readMockCiState(repoDir);
    expect(state.packNpmCalled).toBeUndefined();
  });

  it("runs packNpm for miniprogramRoot package.json when WX_PACK_NPM is unset", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir);
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "mp-inner", dependencies: {} }),
    );

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(0);

    const state = await readMockCiState(repoDir);
    expect(state.packNpmCalled).toBe(true);
  });

  it("reports pack_npm_failed when packNpm fails", async () => {
    const repoDir = await makeRepo();
    const mockState = await setupPlatformValidationRepo(repoDir);

    const { exitCode } = await runNativeCheck(repoDir, {
      WX_PACK_NPM: "1",
      WX_MOCK_CI_MODE: "pack_npm_fail",
      WX_MOCK_CI_STATE: mockState,
    });
    expect(exitCode).toBe(1);

    const events = await readWxCheckEvents(repoDir);
    expect(lastDiagnostic(events)).toBe("pack_npm_failed");
    expect(platformStatus(events)).toBe("configured_invalid");
  });
});
