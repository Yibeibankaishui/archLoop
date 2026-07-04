import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPassword = vi.fn();
const mockLogInfo = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    password: (...args: unknown[]) => mockPassword(...args),
    log: {
      ...(actual.log as Record<string, unknown>),
      info: (...args: unknown[]) => mockLogInfo(...args),
    },
  };
});

import { promptInitHubEnv, promptInitializeHubEnv } from "./hubEnvPrompt.js";

describe("promptInitHubEnv", () => {
  let homeDir: string;
  let dataDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    homeDir = join(tmpdir(), `hub-env-prompt-${Date.now()}`);
    dataDir = join(homeDir, "xdg-data");
    await mkdir(dataDir, { recursive: true });
    env = { ...process.env, XDG_DATA_HOME: dataDir };
    mockPassword.mockResolvedValue("");
    mockLogInfo.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows provider-specific guidance before each key prompt", async () => {
    await promptInitHubEnv({ env });

    const infoMessages = mockLogInfo.mock.calls.map((call) => String(call[0]));
    expect(infoMessages.join("\n")).toContain(
      "https://platform.openai.com/api-keys",
    );
    expect(infoMessages.join("\n")).toContain(
      "https://cursor.com/docs/cli/reference/authentication",
    );
    expect(infoMessages.join("\n")).toMatch(
      /Leave blank to keep the existing value/i,
    );

    const passwordMessages = mockPassword.mock.calls.map(
      (call) => (call[0] as { message: string }).message,
    );
    expect(passwordMessages[0]).toMatch(
      /Leave blank to keep the existing value/i,
    );
  });

  it("skips already-saved env keys when re-running the initialize helper", async () => {
    await mkdir(join(dataDir, "archloop"), { recursive: true });
    await writeFile(
      join(dataDir, "archloop", ".env"),
      "OPENAI_KEY=keep-me\nGH_TOKEN=keep-me\n",
      "utf8",
    );

    await promptInitializeHubEnv({ env });

    const passwordMessages = mockPassword.mock.calls.map(
      (call) => (call[0] as { message: string }).message,
    );
    expect(passwordMessages.join("\n")).not.toContain("OPENAI_KEY");
    expect(passwordMessages.join("\n")).not.toContain("GH_TOKEN");
    expect(passwordMessages.join("\n")).toContain("CURSOR_API_KEY");
    expect(passwordMessages).toHaveLength(3);
  });
});
