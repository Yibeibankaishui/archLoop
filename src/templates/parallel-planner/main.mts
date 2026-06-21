// Parallel Planner — three-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):    An opus agent analyzes open issues, builds a dependency
//                      graph, and outputs a <plan> JSON listing unblocked issues.
//                      Branch names are derived deterministically from issue ids.
//   Phase 2 (Execute): N sonnet agents run in parallel via Promise.allSettled,
//                      each working a single issue on its own branch.
//   Phase 3 (Merge):   A sonnet agent merges all branches that produced commits.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npm run sandcastle
// Or directly: tsx .sandcastle/main.mts

import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const execAsync = promisify(exec);

type PlannedIssue = { id: string; title: string; branch: string };

const LIST_TASKS_COMMAND = `{{LIST_TASKS_COMMAND}}`;

async function listReadyIssuesJson(): Promise<string> {
  const { stdout } = await execAsync(LIST_TASKS_COMMAND, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim() || "[]";
}

function extractAllowedIssueIds(issuesJson: string): Set<string> {
  const parsed = JSON.parse(issuesJson) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Ready issue list did not contain a JSON array.");
  }

  return new Set(
    parsed
      .map((issue) => {
        if (!issue || typeof issue !== "object") return undefined;
        const record = issue as { id?: unknown; number?: unknown };
        const id = record.id ?? record.number;
        return id === undefined || id === null ? undefined : String(id);
      })
      .filter((id): id is string => id !== undefined),
  );
}

function assertPlanUsesAllowedIssues(
  issues: PlannedIssue[],
  allowedIssueIds: Set<string>,
): void {
  const outOfScope = issues.filter(
    (issue) => !allowedIssueIds.has(String(issue.id)),
  );
  if (outOfScope.length > 0) {
    throw new Error(
      `Planner selected issue(s) outside this run's ready queue: ${outOfScope
        .map((issue) => issue.id)
        .join(", ")}`,
    );
  }
}

/** Stable per-issue branch; ignores any slug the planner may emit. */
function canonicalizeIssueBranch(issueId: string): string {
  const id = String(issueId).trim();
  if (!id) {
    throw new Error("Cannot canonicalize branch: issue id is empty.");
  }
  return `sandcastle/issue-${id}`;
}

function canonicalizePlannedIssues(
  issues: Array<{ id: string; title: string; branch?: string }>,
): PlannedIssue[] {
  return issues.map((issue) => ({
    id: String(issue.id),
    title: issue.title,
    branch: canonicalizeIssueBranch(issue.id),
  }));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Per-role idle-timeout defaults (seconds). Planner is short and API-bound:
// a stall almost always means an upstream model hiccup, so use a tight window
// plus one automatic retry. Implementers can legitimately go quiet for many
// minutes while a test suite runs, so give them a much longer window. Both
// fall back to SANDCASTLE_IDLE_TIMEOUT when set, so a single env var can
// still tune both at once. See sandcastle issue #97.
const FALLBACK_IDLE_TIMEOUT_SECONDS = parseIntEnv(
  "SANDCASTLE_IDLE_TIMEOUT",
  undefined,
);
const PLANNER_IDLE_TIMEOUT_SECONDS = parseIntEnv(
  "SANDCASTLE_PLANNER_IDLE_TIMEOUT",
  FALLBACK_IDLE_TIMEOUT_SECONDS ?? 300,
);
const IMPLEMENTER_IDLE_TIMEOUT_SECONDS = parseIntEnv(
  "SANDCASTLE_IMPLEMENTER_IDLE_TIMEOUT",
  FALLBACK_IDLE_TIMEOUT_SECONDS ?? 1500,
);

// Planner auto-retries once on AgentIdleTimeoutError. Implementers do NOT
// auto-retry because their work may be partially committed and re-running
// would duplicate effort. Set SANDCASTLE_NO_PLANNER_RETRY=1 to opt out.
const PLANNER_RETRY_ON_IDLE =
  process.env.SANDCASTLE_NO_PLANNER_RETRY !== "1" &&
  process.env.SANDCASTLE_NO_PLANNER_RETRY !== "true";

function parseIntEnv(name: string, fallback: number): number;
function parseIntEnv(name: string, fallback: undefined): number | undefined;
function parseIntEnv(
  name: string,
  fallback: number | undefined,
): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    console.warn(
      `Ignoring ${name}=${raw}: expected a positive integer (seconds).`,
    );
    return fallback;
  }
  return n;
}

// Hooks run inside the sandbox before the agent starts each iteration.
// bootstrap.sh defines repository-specific setup (generated by init).
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command: "bash .sandcastle/bootstrap.sh",
        timeoutMs: 300_000,
      },
    ],
  },
};

const sandboxProvider = docker({
  mounts: [],
});

// Run the planner with a single retry on AgentIdleTimeoutError. Any other
// failure rethrows so the caller's outer catch can decide what to do. Unlike
// implementers, the planner is stateless across iterations — a single retry
// after an idle stall safely absorbs transient API hiccups.
async function runPlanner(
  readyIssuesJson: string,
): Promise<Awaited<ReturnType<typeof sandcastle.run>>> {
  const attempt = (): Promise<Awaited<ReturnType<typeof sandcastle.run>>> =>
    sandcastle.run({
      hooks,
      sandbox: sandboxProvider,
      name: "planner",
      // One iteration is enough: the planner just needs to read and reason,
      // not write code.
      maxIterations: 1,
      // Opus for planning: dependency analysis benefits from deeper reasoning.
      agent: sandcastle.claudeCode("claude-opus-4-6"),
      promptFile: "./.sandcastle/plan-prompt.md",
      promptArgs: {
        ISSUES_JSON: readyIssuesJson,
      },
      idleTimeoutSeconds: PLANNER_IDLE_TIMEOUT_SECONDS,
    });

  try {
    return await attempt();
  } catch (err) {
    if (PLANNER_RETRY_ON_IDLE && sandcastle.isAgentIdleTimeoutError(err)) {
      console.warn(
        `[planner] Idle timeout after ${PLANNER_IDLE_TIMEOUT_SECONDS}s — retrying once.`,
      );
      return await attempt();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — we parse that to drive Phase 2.
  //
  // A planner failure (including AgentIdleTimeoutError after retry) is logged
  // and the iteration is skipped, mirroring how implementer failures are
  // already handled below. This prevents a single planner stall from killing
  // the whole multi-iteration run. See sandcastle issue #97.
  // -------------------------------------------------------------------------
  const readyIssuesJson = await listReadyIssuesJson();
  const allowedIssueIds = extractAllowedIssueIds(readyIssuesJson);

  let plan: Awaited<ReturnType<typeof sandcastle.run>>;
  try {
    plan = await runPlanner(readyIssuesJson);
  } catch (err) {
    if (sandcastle.isAgentIdleTimeoutError(err)) {
      console.error(
        `  ✗ planner failed: AgentIdleTimeoutError after ${PLANNER_IDLE_TIMEOUT_SECONDS}s${PLANNER_RETRY_ON_IDLE ? " (and one retry)" : ""}. Skipping iteration ${iteration}.`,
      );
    } else {
      console.error(`  ✗ planner failed: ${err}`);
    }
    continue;
  }

  // Extract the <plan>…</plan> block from the agent's stdout.
  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    console.error(
      `  ✗ planner produced no <plan> tag. Skipping iteration ${iteration}.\n\n${plan.stdout}`,
    );
    continue;
  }

  // The plan JSON lists unblocked issues (id + title). Branch names are derived
  // deterministically below so slug drift across planner iterations cannot spawn
  // orphan worktrees.
  const { issues: rawIssues } = JSON.parse(planMatch[1]!) as {
    issues: Array<{ id: string; title: string; branch?: string }>;
  };
  const issues = canonicalizePlannedIssues(rawIssues);
  assertPlanUsesAllowedIssues(issues, allowedIssueIds);

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute
  //
  // Spawn one sonnet agent per issue, all running concurrently.
  // Each agent works on its own branch so there are no conflicts during
  // execution — merging happens in Phase 3.
  //
  // Promise.allSettled means one failing agent doesn't cancel the others.
  // -------------------------------------------------------------------------
  const settled = await Promise.allSettled(
    issues.map((issue) =>
      sandcastle.run({
        hooks,
        // Each agent starts on its own branch via branchStrategy on run().
        sandbox: sandboxProvider,
        branchStrategy: { type: "branch", branch: issue.branch },
        name: "implementer",
        // Give each agent plenty of room to implement and iterate on tests.
        maxIterations: 100,
        // Sonnet for execution: fast and capable enough for typical issue work.
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        promptFile: "./.sandcastle/implement-prompt.md",
        // Prompt arguments substitute {{TASK_ID}}, {{ISSUE_TITLE}},
        // and {{BRANCH}} placeholders in implement-prompt.md before the
        // agent sees the prompt.
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
        idleTimeoutSeconds: IMPLEMENTER_IDLE_TIMEOUT_SECONDS,
      }),
    ),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (
        entry,
      ): entry is {
        outcome: PromiseFulfilledResult<
          Awaited<ReturnType<typeof sandcastle.run>>
        >;
        issue: (typeof issues)[number];
      } =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One sonnet agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything still works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: sandboxProvider,
    name: "merger",
    maxIterations: 1,
    // Sonnet is sufficient for merge conflict resolution.
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
