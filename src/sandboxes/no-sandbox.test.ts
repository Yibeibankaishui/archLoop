import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { noSandbox } from "./no-sandbox.js";

describe("noSandbox", () => {
  it("returns a provider with tag 'none'", () => {
    const provider = noSandbox();
    expect(provider.tag).toBe("none");
    expect(provider.name).toBe("no-sandbox");
    expect(provider.env).toEqual({});
  });

  it("merges env from options", () => {
    const provider = noSandbox({ env: { FOO: "bar" } });
    expect(provider.env).toEqual({ FOO: "bar" });
  });

  describe("handle", () => {
    it("exec runs a command on the host and returns output", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec('echo "hello world"');
      expect(result.stdout).toContain("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("exec returns non-zero exit code on failure", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    it("exec supports onLine streaming callback", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const lines: string[] = [];
      const result = await handle.exec('echo "line1"; echo "line2"', {
        onLine: (line) => lines.push(line),
      });

      expect(lines).toEqual(["line1", "line2"]);
      expect(result.stdout).toContain("line1");
      expect(result.exitCode).toBe(0);
    });

    it("exec respects cwd option", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: "/tmp",
        env: {},
      });

      const result = await handle.exec("pwd", { cwd: "/tmp" });
      expect(result.stdout.trim()).toBe(realpathSync("/tmp"));
    });

    it("exec ignores sudo option (no-op)", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      // sudo is a no-op — the command should still run successfully
      const result = await handle.exec('echo "test"', { sudo: true });
      expect(result.stdout).toContain("test");
      expect(result.exitCode).toBe(0);
    });

    it("exec passes env vars to spawned processes", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: { MY_TEST_VAR: "archloop_test_value" },
      });

      const result = await handle.exec("echo $MY_TEST_VAR");
      expect(result.stdout.trim()).toBe("archloop_test_value");
    });

    it("exec terminates the spawned process when aborted", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });
      const controller = new AbortController();

      const execPromise = handle.exec("sleep 30", {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error("stop")), 50);

      const result = await execPromise;
      expect(result.exitCode).toBe(130);
    });

    it("isolates git global config per handle", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "archloop-no-sandbox-test-"));
      const sourceGitConfig = join(tmpDir, ".gitconfig");
      writeFileSync(sourceGitConfig, "[user]\n\temail = source@example.com\n");

      const provider = noSandbox();
      const first = await provider.create({
        worktreePath: process.cwd(),
        env: { GIT_CONFIG_GLOBAL: sourceGitConfig },
      });
      const second = await provider.create({
        worktreePath: process.cwd(),
        env: { GIT_CONFIG_GLOBAL: sourceGitConfig },
      });

      try {
        const firstPath = (await first.exec('printf "%s" "$GIT_CONFIG_GLOBAL"'))
          .stdout;
        const secondPath = (
          await second.exec('printf "%s" "$GIT_CONFIG_GLOBAL"')
        ).stdout;

        expect(firstPath).not.toBe(sourceGitConfig);
        expect(secondPath).not.toBe(sourceGitConfig);
        expect(firstPath).not.toBe(secondPath);

        await first.exec('git config --global user.name "First Agent"');
        await second.exec('git config --global user.name "Second Agent"');

        expect(readFileSync(sourceGitConfig, "utf8")).toBe(
          "[user]\n\temail = source@example.com\n",
        );
        expect(readFileSync(firstPath, "utf8")).toContain("First Agent");
        expect(readFileSync(secondPath, "utf8")).toContain("Second Agent");

        await first.close();
        await second.close();

        expect(existsSync(firstPath)).toBe(false);
        expect(existsSync(secondPath)).toBe(false);
      } finally {
        await first.close();
        await second.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("interactiveExec spawns process and returns exit code", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.interactiveExec(["sh", "-c", "exit 0"], {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
      });

      expect(result.exitCode).toBe(0);
    });

    it("close is a no-op and does not throw", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      await expect(handle.close()).resolves.toBeUndefined();
    });
  });
});
