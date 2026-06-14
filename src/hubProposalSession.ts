import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { extractStructuredOutput } from "./extractStructuredOutput.js";
import { createHubRunContext } from "./hubExecution.js";
import {
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveSandcastleUserDataDir,
} from "./projectStatus.js";
import type { OutputObjectDefinition } from "./Output.js";

export type ProposalSessionPhase = "draft" | "refinement" | "finalization";

export interface ProposalTranscriptTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
  readonly phase: ProposalSessionPhase;
}

export interface ProposalAgentInvokeInput {
  readonly phase: ProposalSessionPhase;
  readonly prompt: string;
  readonly transcript: readonly ProposalTranscriptTurn[];
  readonly preparedContext: Readonly<Record<string, unknown>>;
  readonly flowId: string;
  readonly runDir: string;
}

export interface ProposalAgentInvokeResult {
  readonly assistantMessage: string;
}

export type ProposalAgentInvoker = (
  input: ProposalAgentInvokeInput,
) => Promise<ProposalAgentInvokeResult>;

export interface ProposalSessionInteraction {
  readonly requestRefinement?: () => Promise<string | null>;
  readonly requestApproval?: () => Promise<boolean>;
}

export interface RunProposalSessionInput<T> {
  readonly flowId: string;
  readonly cwd?: string;
  readonly hubProjectDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly startedAt?: Date;
  readonly preparedContext: Readonly<Record<string, unknown>>;
  readonly draftPrompt: string;
  readonly finalizationPrompt: string;
  readonly output: OutputObjectDefinition<T>;
  readonly agentInvoker: ProposalAgentInvoker;
  readonly interaction?: ProposalSessionInteraction;
  readonly refinements?: readonly string[];
  readonly approve?: boolean;
  readonly oneShot?: boolean;
}

export type RunProposalSessionResult<T> =
  | {
      readonly outcome: "completed";
      readonly flowId: string;
      readonly runId: string;
      readonly runDir: string;
      readonly finalProposal: T;
    }
  | {
      readonly outcome: "cancelled";
      readonly flowId: string;
      readonly runId: string;
      readonly runDir: string;
      readonly phase: "approval" | "refinement";
    }
  | {
      readonly outcome: "failed";
      readonly flowId: string;
      readonly runId: string;
      readonly runDir: string;
      readonly phase: ProposalSessionPhase;
      readonly reason: string;
    };

export interface ProposalSessionArtifactPaths {
  readonly artifactsDir: string;
  readonly preparedContextPath: string;
  readonly transcriptPath: string;
  readonly finalProposalPath: string;
  readonly applyResultPath: string;
  readonly proposalEventsPath: string;
}

type ProposalSessionEvent =
  | {
      readonly type: "session_started";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "draft_started";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "draft_succeeded";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
      readonly assistantMessage: string;
    }
  | {
      readonly type: "refinement_requested";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
      readonly userMessage: string;
    }
  | {
      readonly type: "refinement_succeeded";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
      readonly assistantMessage: string;
    }
  | {
      readonly type: "finalization_started";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "finalization_succeeded";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "finalization_failed";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
      readonly reason: string;
    }
  | {
      readonly type: "session_cancelled";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
      readonly phase: "approval" | "refinement";
    }
  | {
      readonly type: "session_completed";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "session_failed";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
      readonly phase: ProposalSessionPhase;
      readonly reason: string;
    };

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const appendProposalEvent = (
  paths: ProposalSessionArtifactPaths,
  event: ProposalSessionEvent,
): void => {
  mkdirSync(join(paths.artifactsDir, "..", "events"), { recursive: true });
  writeFileSync(paths.proposalEventsPath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
};

export const resolveProposalSessionArtifactPaths = (
  runDir: string,
): ProposalSessionArtifactPaths => {
  const artifactsDir = join(runDir, "artifacts");
  const eventsDir = join(runDir, "events");
  return {
    artifactsDir,
    preparedContextPath: join(artifactsDir, "prepared-context.json"),
    transcriptPath: join(artifactsDir, "transcript.json"),
    finalProposalPath: join(artifactsDir, "final-proposal.json"),
    applyResultPath: join(artifactsDir, "apply-result.json"),
    proposalEventsPath: join(eventsDir, "proposal.jsonl"),
  };
};

const persistPreparedContext = (
  paths: ProposalSessionArtifactPaths,
  preparedContext: Readonly<Record<string, unknown>>,
): void => {
  mkdirSync(paths.artifactsDir, { recursive: true });
  writeJson(paths.preparedContextPath, preparedContext);
};

const persistTranscript = (
  paths: ProposalSessionArtifactPaths,
  transcript: readonly ProposalTranscriptTurn[],
): void => {
  mkdirSync(paths.artifactsDir, { recursive: true });
  writeJson(paths.transcriptPath, transcript);
};

const formatTranscriptForPrompt = (
  transcript: readonly ProposalTranscriptTurn[],
): string =>
  transcript
    .map((turn) => {
      const speaker = turn.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${turn.content}`;
    })
    .join("\n\n");

const buildRefinementPrompt = (
  transcript: readonly ProposalTranscriptTurn[],
): string =>
  [
    "Conversation transcript:",
    formatTranscriptForPrompt(transcript),
    "",
    "Respond to the user's latest refinement request.",
  ].join("\n");

const buildFinalizationPrompt = (
  finalizationPrompt: string,
  transcript: readonly ProposalTranscriptTurn[],
  tag: string,
): string =>
  [
    finalizationPrompt,
    "",
    "Conversation transcript:",
    formatTranscriptForPrompt(transcript),
    "",
    `Emit the final approved task proposal as JSON inside <${tag}>...</${tag}>.`,
  ].join("\n");

const createTranscriptTurn = (
  role: ProposalTranscriptTurn["role"],
  content: string,
  phase: ProposalSessionPhase,
): ProposalTranscriptTurn => ({
  role,
  content,
  createdAt: new Date().toISOString(),
  phase,
});

const invokeAgentTurn = async (input: {
  readonly phase: ProposalSessionPhase;
  readonly prompt: string;
  readonly transcript: readonly ProposalTranscriptTurn[];
  readonly preparedContext: Readonly<Record<string, unknown>>;
  readonly flowId: string;
  readonly runDir: string;
  readonly agentInvoker: ProposalAgentInvoker;
}): Promise<ProposalAgentInvokeResult> =>
  input.agentInvoker({
    phase: input.phase,
    prompt: input.prompt,
    transcript: input.transcript,
    preparedContext: input.preparedContext,
    flowId: input.flowId,
    runDir: input.runDir,
  });

const requestNextRefinement = async (input: {
  readonly interaction?: ProposalSessionInteraction;
  readonly refinements?: readonly string[];
  readonly refinementIndex: number;
}): Promise<string | null> => {
  if (input.refinements) {
    return input.refinements[input.refinementIndex] ?? null;
  }

  if (input.interaction?.requestRefinement) {
    return input.interaction.requestRefinement();
  }

  return null;
};

const requestApprovalDecision = async (input: {
  readonly interaction?: ProposalSessionInteraction;
  readonly approve?: boolean;
}): Promise<boolean> => {
  if (input.approve !== undefined) {
    return input.approve;
  }

  if (input.interaction?.requestApproval) {
    return input.interaction.requestApproval();
  }

  return false;
};

const failSession = <T>(
  input: {
    readonly flowId: string;
    readonly runId: string;
    readonly runDir: string;
    readonly paths: ProposalSessionArtifactPaths;
  },
  phase: ProposalSessionPhase,
  reason: string,
): RunProposalSessionResult<T> => {
  appendProposalEvent(input.paths, {
    type: "session_failed",
    flowId: input.flowId,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    phase,
    reason,
  });
  return {
    outcome: "failed",
    flowId: input.flowId,
    runId: input.runId,
    runDir: input.runDir,
    phase,
    reason,
  };
};

export const runProposalSession = async <T>(
  input: RunProposalSessionInput<T>,
): Promise<RunProposalSessionResult<T>> => {
  const cwd = input.cwd ?? process.cwd();
  const repoRoot = resolveGitRepoRoot(cwd);
  const startedAt = input.startedAt ?? new Date();
  const context = createHubRunContext({
    cwd: repoRoot,
    hubProjectDir:
      input.hubProjectDir ??
      resolveHubProjectDir(resolveSandcastleUserDataDir(input.env), repoRoot),
    branch: `proposal/${input.flowId}`,
    startedAt,
    env: input.env,
  });
  const paths = resolveProposalSessionArtifactPaths(context.runDir);
  const transcript: ProposalTranscriptTurn[] = [];

  persistPreparedContext(paths, input.preparedContext);
  persistTranscript(paths, transcript);

  appendProposalEvent(paths, {
    type: "session_started",
    flowId: input.flowId,
    runId: context.runId,
    createdAt: startedAt.toISOString(),
  });

  appendProposalEvent(paths, {
    type: "draft_started",
    flowId: input.flowId,
    runId: context.runId,
    createdAt: new Date().toISOString(),
  });

  let draftResult: ProposalAgentInvokeResult;
  try {
    draftResult = await invokeAgentTurn({
      phase: "draft",
      prompt: input.draftPrompt,
      transcript,
      preparedContext: input.preparedContext,
      flowId: input.flowId,
      runDir: context.runDir,
      agentInvoker: input.agentInvoker,
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Proposal draft agent failed";
    appendProposalEvent(paths, {
      type: "session_failed",
      flowId: input.flowId,
      runId: context.runId,
      createdAt: new Date().toISOString(),
      phase: "draft",
      reason,
    });
    return failSession(
      {
        flowId: input.flowId,
        runId: context.runId,
        runDir: context.runDir,
        paths,
      },
      "draft",
      reason,
    );
  }

  transcript.push(
    createTranscriptTurn("assistant", draftResult.assistantMessage, "draft"),
  );
  persistTranscript(paths, transcript);
  appendProposalEvent(paths, {
    type: "draft_succeeded",
    flowId: input.flowId,
    runId: context.runId,
    createdAt: new Date().toISOString(),
    assistantMessage: draftResult.assistantMessage,
  });

  if (!input.oneShot) {
    let refinementIndex = 0;
    while (true) {
      const userMessage = await requestNextRefinement({
        interaction: input.interaction,
        refinements: input.refinements,
        refinementIndex,
      });
      if (!userMessage) {
        break;
      }

      refinementIndex += 1;
      transcript.push(createTranscriptTurn("user", userMessage, "refinement"));
      persistTranscript(paths, transcript);
      appendProposalEvent(paths, {
        type: "refinement_requested",
        flowId: input.flowId,
        runId: context.runId,
        createdAt: new Date().toISOString(),
        userMessage,
      });

      let refinementResult: ProposalAgentInvokeResult;
      try {
        refinementResult = await invokeAgentTurn({
          phase: "refinement",
          prompt: buildRefinementPrompt(transcript),
          transcript,
          preparedContext: input.preparedContext,
          flowId: input.flowId,
          runDir: context.runDir,
          agentInvoker: input.agentInvoker,
        });
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : "Proposal refinement agent failed";
        return failSession(
          {
            flowId: input.flowId,
            runId: context.runId,
            runDir: context.runDir,
            paths,
          },
          "refinement",
          reason,
        );
      }

      transcript.push(
        createTranscriptTurn(
          "assistant",
          refinementResult.assistantMessage,
          "refinement",
        ),
      );
      persistTranscript(paths, transcript);
      appendProposalEvent(paths, {
        type: "refinement_succeeded",
        flowId: input.flowId,
        runId: context.runId,
        createdAt: new Date().toISOString(),
        assistantMessage: refinementResult.assistantMessage,
      });
    }
  }

  const approved = await requestApprovalDecision({
    interaction: input.interaction,
    approve: input.approve,
  });
  if (!approved) {
    appendProposalEvent(paths, {
      type: "session_cancelled",
      flowId: input.flowId,
      runId: context.runId,
      createdAt: new Date().toISOString(),
      phase: "approval",
    });
    return {
      outcome: "cancelled",
      flowId: input.flowId,
      runId: context.runId,
      runDir: context.runDir,
      phase: "approval",
    };
  }

  appendProposalEvent(paths, {
    type: "finalization_started",
    flowId: input.flowId,
    runId: context.runId,
    createdAt: new Date().toISOString(),
  });

  let finalizationResult: ProposalAgentInvokeResult;
  try {
    finalizationResult = await invokeAgentTurn({
      phase: "finalization",
      prompt: buildFinalizationPrompt(
        input.finalizationPrompt,
        transcript,
        input.output.tag,
      ),
      transcript,
      preparedContext: input.preparedContext,
      flowId: input.flowId,
      runDir: context.runDir,
      agentInvoker: input.agentInvoker,
    });
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : "Proposal finalization agent failed";
    appendProposalEvent(paths, {
      type: "finalization_failed",
      flowId: input.flowId,
      runId: context.runId,
      createdAt: new Date().toISOString(),
      reason,
    });
    return failSession(
      {
        flowId: input.flowId,
        runId: context.runId,
        runDir: context.runDir,
        paths,
      },
      "finalization",
      reason,
    );
  }

  let finalProposal: T;
  try {
    finalProposal = await extractStructuredOutput<T>(
      finalizationResult.assistantMessage,
      input.output,
      {
        commits: [],
        branch: `proposal/${input.flowId}`,
      },
    );
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : "Proposal finalization structured output failed";
    appendProposalEvent(paths, {
      type: "finalization_failed",
      flowId: input.flowId,
      runId: context.runId,
      createdAt: new Date().toISOString(),
      reason,
    });
    return failSession(
      {
        flowId: input.flowId,
        runId: context.runId,
        runDir: context.runDir,
        paths,
      },
      "finalization",
      reason,
    );
  }

  writeJson(paths.finalProposalPath, finalProposal);
  writeJson(paths.applyResultPath, { status: "pending" });
  appendProposalEvent(paths, {
    type: "finalization_succeeded",
    flowId: input.flowId,
    runId: context.runId,
    createdAt: new Date().toISOString(),
  });
  appendProposalEvent(paths, {
    type: "session_completed",
    flowId: input.flowId,
    runId: context.runId,
    createdAt: new Date().toISOString(),
  });

  return {
    outcome: "completed",
    flowId: input.flowId,
    runId: context.runId,
    runDir: context.runDir,
    finalProposal,
  };
};

export const readProposalSessionArtifacts = (
  runDir: string,
): {
  readonly preparedContext: Readonly<Record<string, unknown>>;
  readonly transcript: readonly ProposalTranscriptTurn[];
  readonly finalProposal?: unknown;
  readonly applyResult?: { readonly status: string };
} => {
  const paths = resolveProposalSessionArtifactPaths(runDir);
  const preparedContext = JSON.parse(
    readFileSync(paths.preparedContextPath, "utf8"),
  ) as Record<string, unknown>;
  const transcript = JSON.parse(
    readFileSync(paths.transcriptPath, "utf8"),
  ) as ProposalTranscriptTurn[];

  let finalProposal: unknown;
  try {
    finalProposal = JSON.parse(
      readFileSync(paths.finalProposalPath, "utf8"),
    ) as unknown;
  } catch {
    finalProposal = undefined;
  }

  let applyResult: { readonly status: string } | undefined;
  try {
    applyResult = JSON.parse(readFileSync(paths.applyResultPath, "utf8")) as {
      readonly status: string;
    };
  } catch {
    applyResult = undefined;
  }

  return {
    preparedContext,
    transcript,
    finalProposal,
    applyResult,
  };
};
