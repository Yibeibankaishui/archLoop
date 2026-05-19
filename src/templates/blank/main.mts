import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npm exec --yes --package tsx -- tsx .sandcastle/main.mts
// Or add to package.json scripts:
//   "sandcastle": "npm exec --yes --package tsx -- tsx .sandcastle/main.mts"

const sandboxProvider = docker({
  mounts: [],
});

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: sandboxProvider,
  promptFile: "./.sandcastle/prompt.md",
});
