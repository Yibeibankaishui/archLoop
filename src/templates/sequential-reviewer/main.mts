// Sequential Reviewer — implement-then-review loop
//
// This template drives a two-phase workflow per issue:
//   Phase 1 (Implement): A sonnet agent picks an open issue, works on it
//                        on a dedicated branch, commits the changes, and signals
//                        completion.
//   Phase 2 (Review):    A second sonnet agent reviews the branch diff and either
//                        approves it or makes corrections directly on the branch.
//
// Both phases share a single sandbox created via createSandbox(), so the
// implementer and reviewer work on the same explicit branch.
//
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration. This is a middle-complexity option between the simple-loop (no review
// gate) and the parallel-planner (concurrent execution with a planning phase).
//
// Usage:
//   npm exec --yes --package tsx -- tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npm exec --yes --package tsx -- tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { access } from "node:fs/promises";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue. Raise this to process more issues per run.
const MAX_ITERATIONS = 10;

const BOOTSTRAP_SCRIPT_PATH = ".sandcastle/bootstrap.sh";
const BOOTSTRAP_PROMPT_PATH = "./.sandcastle/bootstrap-prompt.md";

// Hooks run inside the sandbox before the agent starts each iteration.
// bootstrap.sh defines repository-specific setup.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "bash .sandcastle/bootstrap.sh" }] },
};

const sandboxProvider = docker({
  mounts: [],
});

const ensureBootstrapReady = async () => {
  try {
    await access(BOOTSTRAP_SCRIPT_PATH);
    return;
  } catch {
    // Missing bootstrap script: generate it once from repository context.
  }

  await sandcastle.run({
    name: "bootstrap-generator",
    sandbox: sandboxProvider,
    branchStrategy: { type: "merge-to-head" },
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: BOOTSTRAP_PROMPT_PATH,
    maxIterations: 1,
  });

  // Validate generated script before entering the formal task loop.
  const sandbox = await sandcastle.createSandbox({
    branch: `sandcastle/bootstrap-validation/${Date.now()}`,
    sandbox: sandboxProvider,
    hooks,
  });
  await sandbox.close();
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

await ensureBootstrapReady();

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Generate a unique branch name for this iteration.
  const branch = `sandcastle/sequential-reviewer/${Date.now()}`;

  // Create a single sandbox that both the implementer and reviewer share.
  // This gives both agents a real, named branch that persists across phases.
  const sandbox = await sandcastle.createSandbox({
    branch,
    sandbox: sandboxProvider,
    hooks,
  });

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Implement
    //
    // A sonnet agent picks the next open issue, writes the
    // implementation (using RGR: Red → Green → Repeat → Refactor), and
    // commits the result.
    //
    // The agent signals completion via <promise>COMPLETE</promise> when done.
    // -----------------------------------------------------------------------
    const implement = await sandbox.run({
      name: "implementer",
      maxIterations: 100,
      agent: sandcastle.claudeCode("claude-sonnet-4-6"),
      promptFile: "./.sandcastle/implement-prompt.md",
    });

    if (!implement.commits.length) {
      console.log("Implementation agent made no commits. Skipping review.");
      continue;
    }

    console.log(`\nImplementation complete on branch: ${branch}`);
    console.log(`Commits: ${implement.commits.length}`);

    // -----------------------------------------------------------------------
    // Phase 2: Review
    //
    // A second sonnet agent reviews the diff of the branch produced by
    // Phase 1. It uses the {{BRANCH}} prompt argument to inspect the right
    // branch, and either approves or makes corrections directly on the branch.
    // -----------------------------------------------------------------------
    await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-sonnet-4-6"),
      promptFile: "./.sandcastle/review-prompt.md",
      promptArgs: {
        BRANCH: branch,
      },
    });

    console.log("\nReview complete.");
  } finally {
    await sandbox.close();
  }
}

console.log("\nAll done.");
