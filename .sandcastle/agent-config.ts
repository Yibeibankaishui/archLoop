import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

export const plannerAgent = sandcastle.codex("gpt-5.4", { effort: "high" });
export const implementerAgent = sandcastle.cursor("auto");
export const reviewerAgent = sandcastle.codex("gpt-5.4", { effort: "medium" });
export const mergerAgent = sandcastle.codex("gpt-5.4", { effort: "medium" });

export const sandboxProvider = docker({
  mounts: [
    {
      hostPath: ".sandcastle/auth/codex",
      sandboxPath: "/home/agent/.codex",
    },
    {
      hostPath: ".sandcastle/auth/cursor",
      sandboxPath: "/home/agent/.cursor",
    },
    {
      hostPath: ".sandcastle/auth/cursor-config",
      sandboxPath: "/home/agent/.config/cursor",
    },
    {
      hostPath: ".sandcastle/auth/gh",
      sandboxPath: "/home/agent/.config/gh",
    },
  ],
});
