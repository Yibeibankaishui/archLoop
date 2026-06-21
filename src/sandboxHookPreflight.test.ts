import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  collectSandboxHookCommands,
  extractarchLoopScriptPaths,
  syncSandboxHookScriptsToWorktree,
  validateSandboxHookScripts,
} from "./sandboxHookPreflight.js";

describe("sandboxHookPreflight", () => {
  it("extracts .archloop script paths from hook commands", () => {
    expect(extractarchLoopScriptPaths("bash .archloop/bootstrap.sh")).toEqual([
      ".archloop/bootstrap.sh",
    ]);
    expect(
      extractarchLoopScriptPaths("bash ./.archloop/verify.sh && true"),
    ).toEqual([".archloop/verify.sh"]);
    expect(extractarchLoopScriptPaths("npm install")).toEqual([]);
  });

  it("collects sandbox and host onSandboxReady commands", () => {
    const commands = collectSandboxHookCommands({
      sandbox: {
        onSandboxReady: [{ command: "bash .archloop/bootstrap.sh" }],
      },
      host: {
        onSandboxReady: [{ command: "echo host" }],
      },
    });
    expect(commands).toEqual(["bash .archloop/bootstrap.sh", "echo host"]);
  });

  it("passes when referenced scripts exist in the worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archloop-hook-preflight-"));
    const scriptDir = join(dir, ".archloop");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "bootstrap.sh"), "#!/bin/bash\n");

    await Effect.runPromise(
      validateSandboxHookScripts(dir, {
        sandbox: {
          onSandboxReady: [{ command: "bash .archloop/bootstrap.sh" }],
        },
      }),
    );
  });

  it("fails with guidance when bootstrap.sh is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archloop-hook-preflight-"));

    const result = await Effect.runPromise(
      validateSandboxHookScripts(dir, {
        sandbox: {
          onSandboxReady: [{ command: "bash .archloop/bootstrap.sh" }],
        },
      }).pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("MissingSandboxHookScriptError");
      expect(result.left.message).toContain(".archloop/bootstrap.sh");
      expect(result.left.message).toContain("archloop init");
      expect(result.left.message).toContain("not be committed");
      expect(result.left.message).toContain("git stash pop");
    }
  });

  it("copies gitignored bootstrap.sh from host repo into issue worktree", async () => {
    const hostDir = mkdtempSync(join(tmpdir(), "archloop-hook-sync-host-"));
    const worktreeDir = mkdtempSync(
      join(tmpdir(), "archloop-hook-sync-worktree-"),
    );
    const scriptDir = join(hostDir, ".archloop");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, "bootstrap.sh"),
      "#!/bin/bash\necho synced\n",
    );

    await Effect.runPromise(
      syncSandboxHookScriptsToWorktree(hostDir, worktreeDir, {
        sandbox: {
          onSandboxReady: [{ command: "bash .archloop/bootstrap.sh" }],
        },
      }),
    );

    expect(existsSync(join(worktreeDir, ".archloop", "bootstrap.sh"))).toBe(
      true,
    );
  });
});
