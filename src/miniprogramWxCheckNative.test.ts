import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
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
};

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
      appid: "wxabcdef1234567890",
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
