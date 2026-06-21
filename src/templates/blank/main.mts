import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run with: npm run archloop
// Or directly: tsx .archloop/main.mts

const sandboxProvider = docker({
  mounts: [],
});

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: sandboxProvider,
  promptFile: "./.archloop/prompt.md",
});
