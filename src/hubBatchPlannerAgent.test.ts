import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setHubAgentRole } from "./hubAgentConfig.js";
import { createHubBatchPlannerInvoker } from "./hubBatchPlannerAgent.js";

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock("./run.js", () => ({ run: runMock }));

describe("createHubBatchPlannerInvoker", () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it("suppresses direct startup output from the batch planner run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-batch-planner-startup-"));
    const homeDir = await mkdtemp(join(tmpdir(), "hub-batch-planner-home-"));
    const env = {
      ...process.env,
      XDG_DATA_HOME: "",
      CURSOR_API_KEY: "test-key",
    };
    setHubAgentRole(
      "planning",
      { provider: "cursor", model: "auto" },
      { env, homeDir },
    );
    runMock.mockResolvedValue({ stdout: "batch plan" });
    const abortController = new AbortController();
    const invoker = createHubBatchPlannerInvoker({
      env,
      homeDir,
      signal: abortController.signal,
    });

    await invoker({
      flowId: "no-review",
      cwd,
      runDir: cwd,
      maxTasks: 1,
      candidates: [],
      env,
      homeDir,
    });

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: abortController.signal,
        logging: expect.objectContaining({
          type: "file",
          showStartup: false,
        }),
      }),
    );
  });
});
