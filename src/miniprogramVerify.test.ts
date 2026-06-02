import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
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
  exit_code?: number;
  output?: string;
};

const parseWxCheckLog = (content: string): WxCheckLogEvent[] =>
  content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WxCheckLogEvent);

const assertCoreWxCheckFields = (events: WxCheckLogEvent[]) => {
  for (const event of events) {
    expect(typeof event.type).toBe("string");
    expect(typeof event.severity).toBe("string");
    expect(typeof event.message).toBe("string");
  }
};

const readWxCheckEvents = async (
  repoDir: string,
): Promise<WxCheckLogEvent[]> => {
  const log = await readFile(join(repoDir, "debug", "wx-check.log"), "utf-8");
  return parseWxCheckLog(log);
};

const makeRepo = () => mkdtemp(join(tmpdir(), "miniprogram-verify-"));

const installVerifyHarness = async (repoDir: string) => {
  const bundleRoot = getMiniprogramCapabilityBundlesRoot();
  const configDir = join(repoDir, ".sandcastle");
  await mkdir(configDir, { recursive: true });
  await copyFile(join(bundleRoot, "verify.sh"), join(configDir, "verify.sh"));
  await chmod(join(configDir, "verify.sh"), 0o755);
  await copyFile(
    join(bundleRoot, "wx-check-native.mjs"),
    join(configDir, "wx-check-native.mjs"),
  );
};

const runVerify = async (repoDir: string): Promise<{ exitCode: number }> => {
  try {
    await execFileAsync(join(repoDir, ".sandcastle", "verify.sh"), [], {
      cwd: repoDir,
    });
    return { exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    const code = typeof err.code === "number" ? err.code : err.status;
    return { exitCode: code ?? 1 };
  }
};

describe("miniprogram verify.sh wrapper", () => {
  it("runs npm run wx:check when present and preserves its exit code", async () => {
    const repoDir = await makeRepo();
    await installVerifyHarness(repoDir);
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        scripts: { "wx:check": 'node -e "process.exit(7)"' },
      }),
    );

    const { exitCode } = await runVerify(repoDir);
    expect(exitCode).toBe(7);

    const events = await readWxCheckEvents(repoDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "project_wx_check",
      severity: "error",
      message: "npm run wx:check completed",
      exit_code: 7,
    });
    assertCoreWxCheckFields(events);
  });

  it("falls back to wx-check-native.mjs when wx:check is absent", async () => {
    const repoDir = await makeRepo();
    await installVerifyHarness(repoDir);
    await writeFile(
      join(repoDir, "project.config.json"),
      JSON.stringify({ appid: "wxabcdef1234567890", miniprogramRoot: "./" }),
    );
    await writeFile(
      join(repoDir, "app.json"),
      JSON.stringify({
        pages: ["pages/index/index"],
        window: { navigationBarTitleText: "Test" },
      }),
    );
    const pageDir = join(repoDir, "pages", "index");
    await mkdir(pageDir, { recursive: true });
    await writeFile(join(pageDir, "index.json"), "{}");
    await writeFile(join(pageDir, "index.wxml"), "<view></view>");

    const { exitCode } = await runVerify(repoDir);
    expect(exitCode).toBe(0);

    const events = await readWxCheckEvents(repoDir);
    expect(events.some((e) => e.type === "native_check")).toBe(true);
    assertCoreWxCheckFields(events);
  });

  it("writes project_wx_check when wx:check does not write debug/wx-check.log", async () => {
    const repoDir = await makeRepo();
    await installVerifyHarness(repoDir);
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        scripts: { "wx:check": "node -e \"console.log('plain stdout')\"" },
      }),
    );

    const { exitCode } = await runVerify(repoDir);
    expect(exitCode).toBe(0);

    const events = await readWxCheckEvents(repoDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("project_wx_check");
    expect(events[0]).toMatchObject({
      severity: "info",
      message: "npm run wx:check completed",
      exit_code: 0,
    });
    expect(events[0]?.output).toContain("plain stdout");
    assertCoreWxCheckFields(events);
  });

  it("preserves project-owned JSONL log and appends a summary event", async () => {
    const repoDir = await makeRepo();
    await installVerifyHarness(repoDir);
    await mkdir(join(repoDir, "debug"), { recursive: true });
    await writeFile(
      join(repoDir, "debug", "wx-check.log"),
      `${JSON.stringify({
        type: "custom_check",
        severity: "info",
        message: "project-owned diagnostic",
      })}\n`,
    );
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        scripts: {
          "wx:check":
            "node -e \"const fs=require('fs');fs.appendFileSync('debug/wx-check.log',JSON.stringify({type:'custom_check',severity:'info',message:'from wx:check'})+'\\\\n')\"",
        },
      }),
    );

    const { exitCode } = await runVerify(repoDir);
    expect(exitCode).toBe(0);

    const events = await readWxCheckEvents(repoDir);
    expect(events[0]).toMatchObject({
      type: "custom_check",
      message: "project-owned diagnostic",
    });
    expect(events.at(-1)).toMatchObject({
      type: "project_wx_check_summary",
      severity: "info",
      message: "npm run wx:check completed (log preserved)",
      exit_code: 0,
    });
    assertCoreWxCheckFields(events);
  });
});
