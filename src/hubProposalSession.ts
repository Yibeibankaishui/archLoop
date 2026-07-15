import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { extractStructuredOutput } from "./extractStructuredOutput.js";
import { isProposalPromptCancelledError } from "./errors.js";
import {
  captureProposalFlowStateSnapshot,
  detectProposalFlowMutations,
  formatProposalFlowMutationReason,
  type ProposalFlowStateSnapshot,
} from "./hubProposalMutation.js";
import {
  createHubRunContext,
  resolveHubRunEventsDirectory,
} from "./hubExecution.js";
import {
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveArchloopUserDataDir,
} from "./projectStatus.js";
import type { OutputObjectDefinition } from "./Output.js";

export type ProposalSessionPhase = "draft" | "refinement" | "finalization";

export type HubProposalPresentationPhase =
  | "input_preparation"
  | "draft"
  | "refinement"
  | "finalization"
  | "approval"
  | "validation"
  | "mutation_detection"
  | "apply";

export type HubProposalPresentationStatus =
  | "started"
  | "completed"
  | "cancelled"
  | "failed"
  | "no_change";

export interface HubProposalPresentationEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly runId: string;
  readonly runDir: string;
  readonly flowId: string;
  readonly phase: HubProposalPresentationPhase;
  readonly status: HubProposalPresentationStatus;
  readonly diagnostic?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export const createHubProposalPresentationEvent = (input: {
  readonly runId: string;
  readonly runDir: string;
  readonly flowId: string;
  readonly sequence: number;
  readonly phase: HubProposalPresentationPhase;
  readonly status: HubProposalPresentationStatus;
  readonly diagnostic?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}): HubProposalPresentationEvent => ({
  eventId: `${input.runId}:proposal:${input.sequence}`,
  sequence: input.sequence,
  createdAt: new Date().toISOString(),
  runId: input.runId,
  runDir: input.runDir,
  flowId: input.flowId,
  phase: input.phase,
  status: input.status,
  ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
  ...(input.data ? { data: input.data } : {}),
});

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

export interface ProposalSessionInteraction<T = unknown> {
  readonly onAssistantMessage?: (input: {
    readonly phase: ProposalSessionPhase;
    readonly message: string;
    readonly flowId: string;
    readonly runId: string;
    readonly runDir: string;
  }) => void | Promise<void>;
  readonly requestRefinement?: () => Promise<string | null>;
  readonly requestApproval?: (proposal: T) => Promise<boolean>;
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
  readonly interaction?: ProposalSessionInteraction<T>;
  readonly refinements?: readonly string[];
  readonly approve?: boolean;
  readonly oneShot?: boolean;
  readonly onPresentationEvent?: (event: HubProposalPresentationEvent) => void;
  readonly signal?: AbortSignal;
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
    }
  | {
      readonly type: "mutation_detected";
      readonly flowId: string;
      readonly runId: string;
      readonly createdAt: string;
      readonly reason: string;
    };

interface ProposalSessionState {
  readonly flowId: string;
  readonly runId: string;
  readonly runDir: string;
  readonly paths: ProposalSessionArtifactPaths;
  readonly onPresentationEvent?: (event: HubProposalPresentationEvent) => void;
  presentationSequence: number;
}

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const readOptionalJsonFile = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const proposalAgentErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const appendProposalEvent = (
  runDir: string,
  event: ProposalSessionEvent,
): void => {
  const eventsDir = resolveHubRunEventsDirectory(runDir);
  mkdirSync(eventsDir, { recursive: true });
  writeFileSync(
    join(eventsDir, "proposal.jsonl"),
    `${JSON.stringify(event)}\n`,
    {
      encoding: "utf8",
      flag: "a",
    },
  );
};

const proposalEventBase = (state: ProposalSessionState) => ({
  flowId: state.flowId,
  runId: state.runId,
  createdAt: new Date().toISOString(),
});

const emitPresentationEvent = (
  state: ProposalSessionState,
  phase: HubProposalPresentationPhase,
  status: HubProposalPresentationStatus,
  details: Pick<HubProposalPresentationEvent, "diagnostic" | "data"> = {},
): void => {
  state.presentationSequence += 1;
  state.onPresentationEvent?.(
    createHubProposalPresentationEvent({
      runId: state.runId,
      runDir: state.runDir,
      flowId: state.flowId,
      sequence: state.presentationSequence,
      phase,
      status,
      ...details,
    }),
  );
};

export const writeProposalSessionApplyResult = (
  runDir: string,
  value: Record<string, unknown>,
): void => {
  writeJson(resolveProposalSessionArtifactPaths(runDir).applyResultPath, value);
};

export const resolveProposalSessionArtifactPaths = (
  runDir: string,
): ProposalSessionArtifactPaths => {
  const artifactsDir = join(runDir, "artifacts");
  const eventsDir = resolveHubRunEventsDirectory(runDir);
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

const invokeProposalAgent = (
  state: ProposalSessionState,
  input: {
    readonly preparedContext: Readonly<Record<string, unknown>>;
    readonly agentInvoker: ProposalAgentInvoker;
  },
  phase: ProposalSessionPhase,
  prompt: string,
  transcript: readonly ProposalTranscriptTurn[],
): Promise<ProposalAgentInvokeResult> =>
  input.agentInvoker({
    phase,
    prompt,
    transcript,
    preparedContext: input.preparedContext,
    flowId: state.flowId,
    runDir: state.runDir,
  });

const notifyAssistantMessage = async <T>(
  input: ProposalSessionInteraction<T> | undefined,
  state: ProposalSessionState,
  phase: ProposalSessionPhase,
  message: string,
): Promise<void> => {
  if (!input?.onAssistantMessage) {
    return;
  }
  await input.onAssistantMessage({
    phase,
    message,
    flowId: state.flowId,
    runId: state.runId,
    runDir: state.runDir,
  });
};

const requestNextRefinement = async <T>(input: {
  readonly interaction?: ProposalSessionInteraction<T>;
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

const requestApprovalDecision = async <T>(input: {
  readonly interaction?: ProposalSessionInteraction<T>;
  readonly approve?: boolean;
  readonly proposal: T;
}): Promise<boolean> => {
  if (input.approve !== undefined) {
    return input.approve;
  }

  if (input.interaction?.requestApproval) {
    return input.interaction.requestApproval(input.proposal);
  }

  return false;
};

const failSession = <T>(
  state: ProposalSessionState,
  phase: ProposalSessionPhase,
  reason: string,
  emitPhaseFailure = true,
): RunProposalSessionResult<T> => {
  appendProposalEvent(state.runDir, {
    type: "session_failed",
    ...proposalEventBase(state),
    phase,
    reason,
  });
  if (emitPhaseFailure) {
    emitPresentationEvent(state, phase, "failed", { diagnostic: reason });
  }
  return {
    outcome: "failed",
    flowId: state.flowId,
    runId: state.runId,
    runDir: state.runDir,
    phase,
    reason,
  };
};

const cancelSession = <T>(
  state: ProposalSessionState,
  phase: "approval" | "refinement",
): RunProposalSessionResult<T> => {
  appendProposalEvent(state.runDir, {
    type: "session_cancelled",
    ...proposalEventBase(state),
    phase,
  });
  emitPresentationEvent(state, phase, "cancelled");
  return {
    outcome: "cancelled",
    flowId: state.flowId,
    runId: state.runId,
    runDir: state.runDir,
    phase,
  };
};

const failFinalization = <T>(
  state: ProposalSessionState,
  reason: string,
): RunProposalSessionResult<T> => {
  appendProposalEvent(state.runDir, {
    type: "finalization_failed",
    ...proposalEventBase(state),
    reason,
  });
  return failSession(state, "finalization", reason);
};

const failOnProposalFlowMutations = <T>(
  state: ProposalSessionState,
  input: {
    readonly repoRoot: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly beforeSnapshot: ProposalFlowStateSnapshot;
  },
): RunProposalSessionResult<T> | undefined => {
  const afterSnapshot = captureProposalFlowStateSnapshot({
    cwd: input.repoRoot,
    env: input.env,
  });
  const mutationReport = detectProposalFlowMutations(
    input.beforeSnapshot,
    afterSnapshot,
  );
  if (!mutationReport.hasMutations) {
    emitPresentationEvent(state, "mutation_detection", "completed");
    return undefined;
  }

  const reason = formatProposalFlowMutationReason(mutationReport);
  writeJson(state.paths.applyResultPath, {
    status: "blocked_mutations",
    reason,
  });
  appendProposalEvent(state.runDir, {
    type: "mutation_detected",
    ...proposalEventBase(state),
    reason,
  });
  emitPresentationEvent(state, "mutation_detection", "failed", {
    diagnostic: reason,
  });
  return failSession(state, "finalization", reason, false);
};

export const runProposalSession = async <T>(
  input: RunProposalSessionInput<T>,
): Promise<RunProposalSessionResult<T>> => {
  input.signal?.throwIfAborted();
  const cwd = input.cwd ?? process.cwd();
  const repoRoot = resolveGitRepoRoot(cwd);
  const startedAt = input.startedAt ?? new Date();
  const context = createHubRunContext({
    cwd: repoRoot,
    hubProjectDir:
      input.hubProjectDir ??
      resolveHubProjectDir(resolveArchloopUserDataDir(input.env), repoRoot),
    branch: `proposal/${input.flowId}`,
    startedAt,
    env: input.env,
  });
  const state: ProposalSessionState = {
    flowId: input.flowId,
    runId: context.runId,
    runDir: context.runDir,
    paths: resolveProposalSessionArtifactPaths(context.runDir),
    onPresentationEvent: input.onPresentationEvent,
    presentationSequence: 0,
  };
  const transcript: ProposalTranscriptTurn[] = [];
  const mutationBeforeSnapshot = captureProposalFlowStateSnapshot({
    cwd: repoRoot,
    env: input.env,
  });

  persistPreparedContext(state.paths, input.preparedContext);
  persistTranscript(state.paths, transcript);
  emitPresentationEvent(state, "input_preparation", "completed");

  appendProposalEvent(state.runDir, {
    type: "session_started",
    flowId: state.flowId,
    runId: state.runId,
    createdAt: startedAt.toISOString(),
  });
  emitPresentationEvent(state, "draft", "started");

  appendProposalEvent(state.runDir, {
    type: "draft_started",
    ...proposalEventBase(state),
  });

  let draftResult: ProposalAgentInvokeResult;
  try {
    draftResult = await invokeProposalAgent(
      state,
      input,
      "draft",
      input.draftPrompt,
      transcript,
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    return failSession(
      state,
      "draft",
      proposalAgentErrorMessage(error, "Proposal draft agent failed"),
    );
  }

  transcript.push(
    createTranscriptTurn("assistant", draftResult.assistantMessage, "draft"),
  );
  persistTranscript(state.paths, transcript);
  appendProposalEvent(state.runDir, {
    type: "draft_succeeded",
    ...proposalEventBase(state),
    assistantMessage: draftResult.assistantMessage,
  });
  emitPresentationEvent(state, "draft", "completed");
  await notifyAssistantMessage(
    input.interaction,
    state,
    "draft",
    draftResult.assistantMessage,
  );

  if (!input.oneShot) {
    let refinementIndex = 0;
    while (true) {
      let userMessage: string | null;
      try {
        userMessage = await requestNextRefinement({
          interaction: input.interaction,
          refinements: input.refinements,
          refinementIndex,
        });
      } catch (error) {
        if (isProposalPromptCancelledError(error)) {
          return cancelSession(state, "refinement");
        }
        throw error;
      }
      if (!userMessage) {
        break;
      }

      refinementIndex += 1;
      transcript.push(createTranscriptTurn("user", userMessage, "refinement"));
      persistTranscript(state.paths, transcript);
      appendProposalEvent(state.runDir, {
        type: "refinement_requested",
        ...proposalEventBase(state),
        userMessage,
      });
      emitPresentationEvent(state, "refinement", "started");

      let refinementResult: ProposalAgentInvokeResult;
      try {
        refinementResult = await invokeProposalAgent(
          state,
          input,
          "refinement",
          buildRefinementPrompt(transcript),
          transcript,
        );
      } catch (error) {
        input.signal?.throwIfAborted();
        return failSession(
          state,
          "refinement",
          proposalAgentErrorMessage(error, "Proposal refinement agent failed"),
        );
      }

      transcript.push(
        createTranscriptTurn(
          "assistant",
          refinementResult.assistantMessage,
          "refinement",
        ),
      );
      persistTranscript(state.paths, transcript);
      appendProposalEvent(state.runDir, {
        type: "refinement_succeeded",
        ...proposalEventBase(state),
        assistantMessage: refinementResult.assistantMessage,
      });
      emitPresentationEvent(state, "refinement", "completed");
      await notifyAssistantMessage(
        input.interaction,
        state,
        "refinement",
        refinementResult.assistantMessage,
      );
    }
  }

  appendProposalEvent(state.runDir, {
    type: "finalization_started",
    ...proposalEventBase(state),
  });
  emitPresentationEvent(state, "finalization", "started");

  let finalizationResult: ProposalAgentInvokeResult;
  try {
    finalizationResult = await invokeProposalAgent(
      state,
      input,
      "finalization",
      buildFinalizationPrompt(
        input.finalizationPrompt,
        transcript,
        input.output.tag,
      ),
      transcript,
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    return failFinalization(
      state,
      proposalAgentErrorMessage(error, "Proposal finalization agent failed"),
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
    return failFinalization(
      state,
      proposalAgentErrorMessage(
        error,
        "Proposal finalization structured output failed",
      ),
    );
  }

  writeJson(state.paths.finalProposalPath, finalProposal);
  emitPresentationEvent(state, "finalization", "completed");

  emitPresentationEvent(state, "mutation_detection", "started");
  const mutationFailure = failOnProposalFlowMutations<T>(state, {
    repoRoot,
    env: input.env,
    beforeSnapshot: mutationBeforeSnapshot,
  });
  if (mutationFailure) {
    return mutationFailure;
  }

  emitPresentationEvent(state, "approval", "started");
  let approved: boolean;
  try {
    approved = await requestApprovalDecision({
      interaction: input.interaction,
      approve: input.approve,
      proposal: finalProposal,
    });
  } catch (error) {
    if (isProposalPromptCancelledError(error)) {
      return cancelSession(state, "approval");
    }
    throw error;
  }
  if (!approved) {
    return cancelSession(state, "approval");
  }

  writeJson(state.paths.applyResultPath, { status: "pending" });
  emitPresentationEvent(state, "approval", "completed");
  appendProposalEvent(state.runDir, {
    type: "finalization_succeeded",
    ...proposalEventBase(state),
  });
  appendProposalEvent(state.runDir, {
    type: "session_completed",
    ...proposalEventBase(state),
  });

  return {
    outcome: "completed",
    flowId: state.flowId,
    runId: state.runId,
    runDir: state.runDir,
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

  return {
    preparedContext,
    transcript,
    finalProposal: readOptionalJsonFile(paths.finalProposalPath),
    applyResult: readOptionalJsonFile<{ readonly status: string }>(
      paths.applyResultPath,
    ),
  };
};
