import type {
  HubProposalPresentationEvent,
  HubProposalPresentationPhase,
  HubProposalPresentationStatus,
} from "./hubProposalSession.js";

export interface HubProposalRunDisplayState {
  readonly hubProjectName: string;
  readonly flowId: string;
  readonly runId?: string;
  readonly runDir?: string;
  readonly activePhase?: HubProposalPresentationPhase;
  readonly phases: Readonly<
    Partial<
      Record<
        HubProposalPresentationPhase,
        {
          readonly status: HubProposalPresentationStatus;
          readonly diagnostic?: string;
          readonly data?: Readonly<Record<string, unknown>>;
        }
      >
    >
  >;
  readonly seenEventIds: ReadonlySet<string>;
  readonly phaseSequences: Readonly<
    Partial<Record<HubProposalPresentationPhase, number>>
  >;
  readonly sequence: number;
}

export const createHubProposalRunDisplayState = (input: {
  readonly hubProjectName: string;
  readonly flowId: string;
}): HubProposalRunDisplayState => ({
  ...input,
  phases: {},
  seenEventIds: new Set(),
  phaseSequences: {},
  sequence: 0,
});

export const acceptsHubProposalPresentationEvent = (
  state: HubProposalRunDisplayState,
  event: HubProposalPresentationEvent,
): boolean =>
  !state.seenEventIds.has(event.eventId) &&
  event.sequence > (state.phaseSequences[event.phase] ?? 0);

export const reduceHubProposalRunDisplayState = (
  state: HubProposalRunDisplayState,
  event: HubProposalPresentationEvent,
): HubProposalRunDisplayState => {
  if (!acceptsHubProposalPresentationEvent(state, event)) {
    return state;
  }
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(event.eventId);
  const isNewestEvent = event.sequence > state.sequence;

  return {
    ...state,
    runId: event.runId,
    runDir: event.runDir,
    activePhase: isNewestEvent
      ? event.status === "started"
        ? event.phase
        : undefined
      : state.activePhase,
    phases: {
      ...state.phases,
      [event.phase]: {
        status: event.status,
        ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
        ...(event.data ? { data: event.data } : {}),
      },
    },
    seenEventIds,
    phaseSequences: {
      ...state.phaseSequences,
      [event.phase]: event.sequence,
    },
    sequence: Math.max(state.sequence, event.sequence),
  };
};

const textField = (name: string, value: string): string =>
  `${name}=${JSON.stringify(value)}`;

const numericProposalDataFields = (
  data: Readonly<Record<string, unknown>> | undefined,
): readonly string[] =>
  ["applied", "skipped", "dependencies"].flatMap((key) =>
    typeof data?.[key] === "number" ? [`${key}=${data[key]}`] : [],
  );

export const formatPlainHubProposalEvent = (
  event: HubProposalPresentationEvent,
  hubProjectName: string,
): string =>
  [
    "event=proposal_phase",
    textField("hub_project", hubProjectName),
    textField("flow", event.flowId),
    textField("phase", event.phase),
    textField("status", event.status),
    textField("run_id", event.runId),
    ...numericProposalDataFields(event.data),
    ...(event.diagnostic
      ? [textField("diagnostic", event.diagnostic.split(/\r?\n/, 1)[0] ?? "")]
      : []),
    textField("logs", event.runDir),
  ].join(" ");

export interface HubProposalRunJsonRenderer {
  readonly event: (event: HubProposalPresentationEvent) => string;
  readonly outcome: (
    state: HubProposalRunDisplayState,
    outcome: HubProposalRunOutcomeProjection,
  ) => string;
  readonly failure: (
    state: HubProposalRunDisplayState,
    error: unknown,
  ) => string;
}

export const createHubProposalRunJsonRenderer = (input: {
  readonly hubProjectName: string;
  readonly flowId: string;
  readonly now?: () => Date;
}): HubProposalRunJsonRenderer => {
  let outputSequence = 0;
  const serialize = (
    runId: string,
    timestamp: string,
    type: string,
    fields: Readonly<Record<string, unknown>>,
  ): string => {
    outputSequence += 1;
    return JSON.stringify({
      schemaVersion: 1,
      eventId: `${runId}:output:${outputSequence}`,
      sequence: outputSequence,
      timestamp,
      type,
      runId,
      flowId: input.flowId,
      hubProject: input.hubProjectName,
      ...fields,
    });
  };
  return {
    event: (event) => {
      const numericData = Object.fromEntries(
        ["applied", "skipped", "dependencies"].flatMap((key) =>
          typeof event.data?.[key] === "number"
            ? [[key, event.data[key]] as const]
            : [],
        ),
      );
      return serialize(event.runId, event.createdAt, "proposal_phase", {
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        phase: event.phase,
        status: event.status,
        ...numericData,
        ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
        logs: event.runDir,
      });
    },
    outcome: (state, outcome) =>
      serialize(
        state.runId ?? "unknown",
        (input.now ?? (() => new Date()))().toISOString(),
        "run_completed",
        {
          outcome: outcome.outcome,
          summary: outcome.summary,
          counts: outcome.counts,
          ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
          ...(outcome.recoveryCommand
            ? { recoveryCommand: outcome.recoveryCommand }
            : {}),
          exitCode: outcome.exitCode,
          logs: outcome.logs,
        },
      ),
    failure: (state, error) => {
      const outcome = projectHubProposalRunFailure(state, error);
      return serialize(
        state.runId ?? "unknown",
        (input.now ?? (() => new Date()))().toISOString(),
        "run_failed",
        {
          outcome: outcome.outcome,
          summary: outcome.summary,
          diagnostic: outcome.diagnostic,
          recoveryCommand: outcome.recoveryCommand,
          exitCode: outcome.exitCode,
          logs: outcome.logs,
        },
      );
    },
  };
};

export type HubProposalRunOutcome =
  | "applied"
  | "no_change"
  | "cancelled"
  | "validation_failed"
  | "mutation_failed"
  | "failed";

export interface HubProposalRunOutcomeProjection {
  readonly outcome: HubProposalRunOutcome;
  readonly summary: string;
  readonly counts: {
    readonly applied: number;
    readonly skipped: number;
    readonly dependencies: number;
  };
  readonly diagnostic?: string;
  readonly recoveryCommand?: string;
  readonly exitCode: number;
  readonly logs: string;
}

const outcomeCounts = (
  state: HubProposalRunDisplayState,
): HubProposalRunOutcomeProjection["counts"] => {
  const data = state.phases.apply?.data;
  return {
    applied: typeof data?.applied === "number" ? data.applied : 0,
    skipped: typeof data?.skipped === "number" ? data.skipped : 0,
    dependencies:
      typeof data?.dependencies === "number" ? data.dependencies : 0,
  };
};

const conciseDiagnostic = (value: string | undefined): string | undefined =>
  value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 240);

export const projectHubProposalRunFailure = (
  state: HubProposalRunDisplayState,
  error: unknown,
): HubProposalRunOutcomeProjection => ({
  outcome: "failed",
  summary: "Proposal flow failed",
  counts: outcomeCounts(state),
  diagnostic:
    conciseDiagnostic(error instanceof Error ? error.message : String(error)) ??
    "Proposal flow failed.",
  recoveryCommand: `archloop run --flow ${state.flowId}`,
  exitCode: 1,
  logs: state.runDir ?? "",
});

export const projectHubProposalRunOutcome = (
  state: HubProposalRunDisplayState,
): HubProposalRunOutcomeProjection => {
  const mutation = state.phases.mutation_detection;
  const validation = state.phases.validation;
  const apply = state.phases.apply;
  const cancelledPhase = Object.values(state.phases).find(
    ({ status }) => status === "cancelled",
  );
  const failedPhase = Object.values(state.phases).find(
    ({ status }) => status === "failed",
  );
  const base = {
    counts: outcomeCounts(state),
    logs: state.runDir ?? "",
  };

  if (mutation?.status === "failed") {
    return {
      ...base,
      outcome: "mutation_failed",
      summary: "Unexpected mutation blocked proposal apply",
      ...(conciseDiagnostic(mutation.diagnostic)
        ? { diagnostic: conciseDiagnostic(mutation.diagnostic) }
        : {}),
      recoveryCommand: `archloop run --flow ${state.flowId}`,
      exitCode: 1,
    };
  }
  if (validation?.status === "failed") {
    return {
      ...base,
      outcome: "validation_failed",
      summary: "Proposal validation failed",
      ...(conciseDiagnostic(validation.diagnostic)
        ? { diagnostic: conciseDiagnostic(validation.diagnostic) }
        : {}),
      recoveryCommand: `archloop run --flow ${state.flowId}`,
      exitCode: 1,
    };
  }
  if (cancelledPhase) {
    return {
      ...base,
      outcome: "cancelled",
      summary: "Proposal cancelled",
      exitCode: 130,
    };
  }
  if (apply?.status === "no_change") {
    return {
      ...base,
      outcome: "no_change",
      summary: "Proposal approved; no changes applied",
      exitCode: 0,
    };
  }
  if (apply?.status === "completed") {
    return {
      ...base,
      outcome: "applied",
      summary: "Proposal approved and applied",
      exitCode: 0,
    };
  }
  return {
    ...base,
    outcome: "failed",
    summary: "Proposal flow failed",
    ...(failedPhase?.diagnostic
      ? { diagnostic: conciseDiagnostic(failedPhase.diagnostic) }
      : {}),
    recoveryCommand: `archloop run --flow ${state.flowId}`,
    exitCode: 1,
  };
};

export const formatPlainHubProposalOutcome = (
  state: HubProposalRunDisplayState,
  outcome: HubProposalRunOutcomeProjection,
): string =>
  [
    "event=run_completed",
    textField("outcome", outcome.outcome),
    textField("summary", outcome.summary),
    `applied=${outcome.counts.applied}`,
    `skipped=${outcome.counts.skipped}`,
    `dependencies=${outcome.counts.dependencies}`,
    textField("run_id", state.runId ?? ""),
    ...(outcome.diagnostic
      ? [textField("diagnostic", outcome.diagnostic)]
      : []),
    ...(outcome.recoveryCommand
      ? [textField("recovery", outcome.recoveryCommand)]
      : []),
    textField("logs", outcome.logs),
    `exit_code=${outcome.exitCode}`,
  ].join(" ");
