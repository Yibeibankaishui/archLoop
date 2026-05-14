import { access } from "node:fs/promises";
import { run, claudeCode, createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Simple loop: an agent that picks open issues one by one and closes them.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

const sandboxProvider = docker({
  mounts: [],
});

const BOOTSTRAP_SCRIPT_PATH = ".sandcastle/bootstrap.sh";
const BOOTSTRAP_PROMPT_PATH = "./.sandcastle/bootstrap-prompt.md";
const bootstrapHooks = {
  sandbox: {
    onSandboxReady: [{ command: "bash .sandcastle/bootstrap.sh" }],
  },
};

const ensureBootstrapReady = async () => {
  try {
    await access(BOOTSTRAP_SCRIPT_PATH);
    return;
  } catch {
    // Missing bootstrap script: generate it once from repository context.
  }

  await run({
    name: "bootstrap-generator",
    sandbox: sandboxProvider,
    branchStrategy: { type: "merge-to-head" },
    agent: claudeCode("claude-sonnet-4-6"),
    promptFile: BOOTSTRAP_PROMPT_PATH,
    maxIterations: 1,
  });

  // Validate generated script before entering the formal task loop.
  const sandbox = await createSandbox({
    branch: `sandcastle/bootstrap-validation/${Date.now()}`,
    sandbox: sandboxProvider,
    hooks: bootstrapHooks,
  });
  await sandbox.close();
};

await ensureBootstrapReady();

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — Docker is the default runtime.
  sandbox: sandboxProvider,

  // The agent provider. Pass a model string to claudeCode() — sonnet balances
  // capability and speed for most tasks. Switch to claude-opus-4-6 for harder
  // problems, or claude-haiku-4-5-20251001 for speed.
  agent: claudeCode("claude-sonnet-4-6"),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Increase this to process more issues
  // per run, or set it to 1 for a single-shot mode.
  maxIterations: 3,

  // Branch strategy — merge-to-head creates a temporary branch for the agent
  // to work on, then merges the result back to HEAD when the run completes.
  branchStrategy: { type: "merge-to-head" },

  // Lifecycle hooks — commands grouped by where they run (host or sandbox).
  // bootstrap.sh is the repository-specific setup contract.
  hooks: bootstrapHooks,
});
