import * as archloop from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

export const plannerAgent = archloop.codex("gpt-5.4", { effort: "medium" });
export const implementerAgent = archloop.cursor("auto");
export const reviewerAgent = archloop.codex("gpt-5.4", { effort: "medium" });
export const mergerAgent = archloop.codex("gpt-5.4", { effort: "medium" });

export const sandboxProvider = docker({
  mounts: [
    {
      hostPath: ".archloop/auth/codex",
      sandboxPath: "/home/agent/.codex",
    },
    {
      hostPath: ".archloop/auth/cursor",
      sandboxPath: "/home/agent/.cursor",
    },
    {
      hostPath: ".archloop/auth/cursor-config",
      sandboxPath: "/home/agent/.config/cursor",
    },
    {
      hostPath: ".archloop/auth/gh",
      sandboxPath: "/home/agent/.config/gh",
    },
  ],
});
