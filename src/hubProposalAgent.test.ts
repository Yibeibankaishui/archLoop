import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHubProposalAgentInvoker } from "./hubProposalAgent.js";

describe("createHubProposalAgentInvoker", () => {
  it("fails fast with sandcastle env guidance when credentials are missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-proposal-preflight-"));
    const invoker = createHubProposalAgentInvoker({
      cwd,
      roleEntry: {
        provider: "cursor",
        model: "auto",
      },
    });

    await expect(
      invoker({
        flowId: "test-flow",
        phase: "draft",
        prompt: "test prompt",
        transcript: [],
        preparedContext: {},
        runDir: cwd,
      }),
    ).rejects.toThrow(/sandcastle env init/);
  });
});
