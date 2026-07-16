import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAgentCredentialsConfigured,
  detectAgentAuthFailure,
  enrichAgentFailureDetail,
  formatAgentAuthFailureMessage,
  formatMissingAgentCredentialsMessage,
} from "./agentAuthGuidance.js";

describe("detectAgentAuthFailure", () => {
  it("detects cursor auth failure from agent login message", () => {
    const result = detectAgentAuthFailure(
      "cursor",
      "Please run `agent login` first, or set `CURSOR_API_KEY`",
    );
    expect(result).toEqual({
      envKey: "CURSOR_API_KEY",
      label: "Cursor",
    });
  });

  it("does not misclassify cursor ECONNRESET as auth failure", () => {
    expect(
      detectAgentAuthFailure("cursor", "T: [aborted] read ECONNRESET"),
    ).toBeUndefined();
  });

  it("does not misclassify cursor HTTP/2 keepalive as auth failure", () => {
    expect(
      detectAgentAuthFailure(
        "cursor",
        "T: [internal] HTTP/2 keepalive ping timed out after 5000ms",
      ),
    ).toBeUndefined();
  });

  it("detects codex invalid api key", () => {
    const result = detectAgentAuthFailure(
      "codex",
      "Error: invalid api key provided",
    );
    expect(result).toEqual({
      envKey: "OPENAI_KEY",
      label: "Codex",
      authEnvKeys: ["CODEX_HOME"],
    });
  });

  it("detects claude-code auth failure", () => {
    const result = detectAgentAuthFailure(
      "claude-code",
      "Authentication error: ANTHROPIC_API_KEY is missing",
    );
    expect(result).toEqual({
      envKey: "ANTHROPIC_API_KEY",
      label: "Claude Code",
      authEnvKeys: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
    });
  });

  it("detects claude-code auth failure from CLAUDE_CODE_OAUTH_TOKEN mention", () => {
    const result = detectAgentAuthFailure(
      "claude-code",
      "CLAUDE_CODE_OAUTH_TOKEN expired",
    );
    expect(result).toEqual({
      envKey: "ANTHROPIC_API_KEY",
      label: "Claude Code",
      authEnvKeys: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
    });
  });

  it("detects opencode auth failure", () => {
    const result = detectAgentAuthFailure(
      "opencode",
      "OPENCODE_API_KEY is not set",
    );
    expect(result).toEqual({
      envKey: "OPENCODE_API_KEY",
      label: "OpenCode",
    });
  });
});

describe("formatAgentAuthFailureMessage", () => {
  it("leads with archloop env commands and includes original error", () => {
    const message = formatAgentAuthFailureMessage({
      providerName: "cursor",
      envKey: "CURSOR_API_KEY",
      label: "Cursor",
      originalDetail: "Please run `agent login` first",
    });

    expect(message).toContain("archloop env init");
    expect(message).toContain("archloop env set CURSOR_API_KEY");
    expect(message).toContain("archloop env show");
    expect(message).toContain(".archloop/.env");
    expect(message).toMatch(/not rely on host-global provider login state/i);
    expect(message).toContain("Original error: Please run `agent login` first");
  });

  it("includes codex sandbox login guidance for codex provider", () => {
    const message = formatAgentAuthFailureMessage({
      providerName: "codex",
      envKey: "OPENAI_KEY",
      label: "Codex",
      originalDetail: "not logged in",
    });

    expect(message).toContain("archloop auth login codex");
    expect(message).toContain("Original error: not logged in");
  });
});

describe("formatMissingAgentCredentialsMessage", () => {
  it("omits original error line for preflight", () => {
    const message = formatMissingAgentCredentialsMessage({
      providerName: "cursor",
      envKey: "CURSOR_API_KEY",
      label: "Cursor",
    });

    expect(message).toContain("archloop env init");
    expect(message).not.toContain("Original error:");
  });
});

describe("enrichAgentFailureDetail", () => {
  it("enriches cursor auth stderr with archloop guidance", () => {
    const enriched = enrichAgentFailureDetail(
      "cursor",
      "Please run `agent login` first, or set `CURSOR_API_KEY`",
    );
    expect(enriched).toContain("archloop env init");
    expect(enriched).toContain("Original error:");
  });

  it("passes through non-auth cursor transport errors unchanged", () => {
    const detail = "T: [aborted] read ECONNRESET";
    expect(enrichAgentFailureDetail("cursor", detail)).toBe(detail);
  });
});

describe("assertAgentCredentialsConfigured", () => {
  const makeDir = () => mkdtemp(join(tmpdir(), "agent-auth-preflight-"));

  it("throws with archloop env guidance when credentials are missing", async () => {
    const dir = await makeDir();
    const dataDir = join(dir, "xdg-data");
    const origXdgDataHome = process.env.XDG_DATA_HOME;
    const origCursorApiKey = process.env.CURSOR_API_KEY;

    try {
      process.env.XDG_DATA_HOME = dataDir;
      process.env.CURSOR_API_KEY = "";
      await expect(
        assertAgentCredentialsConfigured({
          providerName: "cursor",
          cwd: dir,
        }),
      ).rejects.toThrow(/archloop env init/);
    } finally {
      if (origXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdgDataHome;
      if (origCursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = origCursorApiKey;
    }
  });

  it("passes when hub env file has the required key", async () => {
    const dir = await makeDir();
    const dataDir = join(dir, "xdg-data");
    await mkdir(join(dataDir, "archloop"), { recursive: true });
    await writeFile(
      join(dataDir, "archloop", ".env"),
      "CURSOR_API_KEY=hub-key\n",
    );

    const orig = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = dataDir;
      await assertAgentCredentialsConfigured({
        providerName: "cursor",
        cwd: dir,
      });
    } finally {
      if (orig === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = orig;
    }
  });

  it("passes when project .archloop/.env has the required key", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(
      join(dir, ".archloop", ".env"),
      "CURSOR_API_KEY=project-key\n",
    );

    await assertAgentCredentialsConfigured({
      providerName: "cursor",
      cwd: dir,
    });
  });

  it("passes for Codex when a Hub auth session exists without OPENAI_KEY", async () => {
    const dir = await makeDir();
    const dataDir = join(dir, "xdg-data");
    const codexDir = join(dataDir, "archloop", "hub", "auth", "codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "auth.json"), "{}\n");

    const origXdgDataHome = process.env.XDG_DATA_HOME;
    const origOpenAiKey = process.env.OPENAI_KEY;
    const origCodexHome = process.env.CODEX_HOME;
    try {
      process.env.XDG_DATA_HOME = dataDir;
      delete process.env.OPENAI_KEY;
      delete process.env.CODEX_HOME;
      await assertAgentCredentialsConfigured({
        providerName: "codex",
        cwd: dir,
      });
    } finally {
      if (origXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdgDataHome;
      if (origOpenAiKey === undefined) delete process.env.OPENAI_KEY;
      else process.env.OPENAI_KEY = origOpenAiKey;
      if (origCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = origCodexHome;
    }
  });

  it("passes for claude-code when CLAUDE_CODE_OAUTH_TOKEN is set without ANTHROPIC_API_KEY", async () => {
    const dir = await makeDir();
    await assertAgentCredentialsConfigured({
      providerName: "claude-code",
      cwd: dir,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
    });
  });

  it("passes for claude-code when ANTHROPIC_AUTH_TOKEN (gateway) is set without ANTHROPIC_API_KEY", async () => {
    const dir = await makeDir();
    await assertAgentCredentialsConfigured({
      providerName: "claude-code",
      cwd: dir,
      env: {
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
        ANTHROPIC_BASE_URL: "https://gateway.example/v1",
      },
    });
  });

  it("passes for claude-code via project .archloop/.env CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(
      join(dir, ".archloop", ".env"),
      "CLAUDE_CODE_OAUTH_TOKEN=project-token\n",
    );

    await assertAgentCredentialsConfigured({
      providerName: "claude-code",
      cwd: dir,
      env: {},
    });
  });

  it("skips preflight for claude-code regardless of env (CLI handles its own auth)", async () => {
    const dir = await makeDir();
    await assertAgentCredentialsConfigured({
      providerName: "claude-code",
      cwd: dir,
      env: {},
    });
  });

  it("skips preflight for pi regardless of env", async () => {
    const dir = await makeDir();
    await assertAgentCredentialsConfigured({
      providerName: "pi",
      cwd: dir,
      env: {},
    });
  });

  it("missing claude-code credentials message mentions CLAUDE_CODE_OAUTH_TOKEN fallback", () => {
    const message = formatMissingAgentCredentialsMessage({
      providerName: "claude-code",
      envKey: "ANTHROPIC_API_KEY",
      label: "Claude Code",
    });
    expect(message).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
