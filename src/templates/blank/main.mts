import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run with: npm run sandcastle
// Or directly: tsx .sandcastle/main.mts

const sandboxProvider = docker({
  mounts: [],
});

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: sandboxProvider,
  promptFile: "./.sandcastle/prompt.md",
});
