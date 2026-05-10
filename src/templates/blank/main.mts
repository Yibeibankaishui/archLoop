import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

const sandboxProvider = docker({
  mounts: [
    { hostPath: ".sandcastle/auth/codex", sandboxPath: "/home/agent/.codex" },
    { hostPath: ".sandcastle/auth/cursor", sandboxPath: "/home/agent/.cursor" },
    {
      hostPath: ".sandcastle/auth/cursor-config",
      sandboxPath: "/home/agent/.config/cursor",
    },
    { hostPath: ".sandcastle/auth/gh", sandboxPath: "/home/agent/.config/gh" },
  ],
});

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: sandboxProvider,
  promptFile: "./.sandcastle/prompt.md",
});
