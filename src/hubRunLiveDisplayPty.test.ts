import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptExecutable = "/usr/bin/script";
const fixturePath = fileURLToPath(
  new URL("../test-fixtures/hubRunLiveDisplayPty.mts", import.meta.url),
);
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const runInPty = async (
  mode: "complete" | "signal",
): Promise<{ readonly exitCode: number | null; readonly output: string }> => {
  const fixtureCommand = [
    process.execPath,
    "--import",
    "tsx",
    fixturePath,
    mode,
  ];
  const command =
    mode === "signal"
      ? [
          "/bin/sh",
          "-c",
          `${fixtureCommand.map(shellQuote).join(" ")}; status=$?; stty -a; exit $status`,
        ]
      : fixtureCommand;
  const args =
    process.platform === "darwin"
      ? ["-q", "-e", "/dev/null", ...command]
      : ["-q", "-e", "-c", command.map(shellQuote).join(" "), "/dev/null"];

  return new Promise((resolveResult, reject) => {
    const child = spawn(scriptExecutable, args, {
      cwd: process.cwd(),
      env: { ...process.env, CI: undefined, TERM: "xterm-256color" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveResult({ exitCode, output }));
  });
};

describe.skipIf(process.platform === "win32" || !existsSync(scriptExecutable))(
  "hub run live display PTY process",
  () => {
    it("enters and leaves alt-screen, restores the cursor, and dumps a scrollback summary on completion", async () => {
      const result = await runInPty("complete");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("PTY_READY tty=true");
      // Alt-screen enter + leave both present
      expect(result.output).toContain("\x1b[?1049h");
      expect(result.output).toContain("\x1b[?1049l");
      // Cursor hidden then restored
      expect(result.output).toContain("\x1b[?25l");
      expect(result.output).toContain("\x1b[?25h");
      expect(result.output.indexOf("\x1b[?1049l")).toBeGreaterThan(
        result.output.indexOf("\x1b[?1049h"),
      );
      // Frame contents rendered inside alt-screen (header text)
      expect(result.output).toContain("archLoop");
      // Scrollback summary lands AFTER the FIRST leave sequence (the
      // belt-and-suspenders exit handler writes a second leave on process
      // exit, so use indexOf rather than lastIndexOf).
      const leaveIdx = result.output.indexOf("\x1b[?1049l");
      const summaryIdx = result.output.indexOf("archLoop", leaveIdx);
      expect(summaryIdx).toBeGreaterThan(leaveIdx);
    });

    it("restores the cursor when a real PTY process handles SIGINT", async () => {
      const result = await runInPty("signal");

      expect([0, 130]).toContain(result.exitCode);
      expect(result.output).toContain("PTY_READY tty=true");
      expect(result.output).toContain("PTY_SIGNAL_HANDLED");
      expect(result.output).toContain("\x1b[?25h");
      // Alt-screen entered
      expect(result.output).toContain("\x1b[?1049h");
      expect(result.output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(
        result.output.indexOf("PTY_SIGNAL_HANDLED"),
      );
      expect(result.output).toMatch(/(?:^|[\s;])icanon(?:[\s;]|$)/);
      expect(result.output).not.toMatch(/(?:^|[\s;])-icanon(?:[\s;]|$)/);
      expect(result.output).toMatch(/(?:^|[\s;])echo(?:[\s;]|$)/);
    });
  },
);
