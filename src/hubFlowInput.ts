import { readPrdFile, resolvePrdPath } from "./prdDecomposition.js";
import { HubFlowError } from "./errors.js";
import {
  HUB_TRIAGE_DEFAULT_TASK_QUERY,
  isHubTriageSourceStatus,
} from "./hubTriage.js";
import { getHubFlowDefinition, type HubFlowInputKind } from "./hubFlows.js";

export { HUB_TRIAGE_DEFAULT_TASK_QUERY } from "./hubTriage.js";

export type ValidatedPrdFileFlowInput = {
  readonly flowId: "prd-decomposition";
  readonly kind: "prd-file";
  readonly ref: string;
  readonly path: string;
  readonly content: string;
};

export type ValidatedTaskQueryFlowInput = {
  readonly flowId: "triage";
  readonly kind: "task-query";
  readonly query: string;
};

export type ValidatedHubFlowInput =
  | ValidatedPrdFileFlowInput
  | ValidatedTaskQueryFlowInput;

const toHubFlowInputError = (message: string): HubFlowError =>
  new HubFlowError({ message });

export const resolveHubFlowRawInput = (
  flowId: string,
  rawInput?: string,
): string | undefined => {
  const trimmed = rawInput?.trim();
  if (trimmed) {
    return trimmed;
  }

  const defaultValue =
    getHubFlowDefinition(flowId)?.input?.defaultValue?.trim();
  return defaultValue || undefined;
};

const normalizeTaskQuery = (rawQuery: string): string => {
  const statuses = rawQuery
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (statuses.length === 0) {
    throw toHubFlowInputError(
      "Hub task query input must include at least one Hub status.",
    );
  }

  for (const status of statuses) {
    if (!isHubTriageSourceStatus(status)) {
      throw toHubFlowInputError(
        `Unsupported Hub task query status "${status}". Use comma-separated inbox and needs_info statuses.`,
      );
    }
  }

  return statuses.join(",");
};

const validateInputKind = (
  flowId: string,
  kind: HubFlowInputKind,
  cwd: string,
  rawInput: string | undefined,
): ValidatedHubFlowInput => {
  switch (kind) {
    case "prd-file": {
      if (!rawInput) {
        throw toHubFlowInputError(
          'PRD file path is required for flow "prd-decomposition". Pass --input <prd-ref>.',
        );
      }

      const content = readPrdFile(cwd, rawInput);
      return {
        flowId: "prd-decomposition",
        kind: "prd-file",
        ref: rawInput,
        path: resolvePrdPath(cwd, rawInput),
        content,
      };
    }
    case "task-query": {
      const query = normalizeTaskQuery(
        rawInput ?? HUB_TRIAGE_DEFAULT_TASK_QUERY,
      );
      return {
        flowId: "triage",
        kind: "task-query",
        query,
      };
    }
    default: {
      const unsupportedKind: never = kind;
      throw toHubFlowInputError(
        `Unsupported Hub flow input kind "${unsupportedKind}" for flow "${flowId}".`,
      );
    }
  }
};

export const validateHubFlowInput = (
  flowId: string,
  input: {
    readonly cwd: string;
    readonly rawInput?: string;
  },
): ValidatedHubFlowInput => {
  const flow = getHubFlowDefinition(flowId);
  if (!flow?.input) {
    throw toHubFlowInputError(
      `Hub flow "${flowId}" does not accept flow input. Remove --input or choose a flow that declares an input schema.`,
    );
  }

  const resolvedInput = resolveHubFlowRawInput(flowId, input.rawInput);
  if (flow.input.required && !resolvedInput) {
    throw toHubFlowInputError(
      `${flow.input.label} is required for flow "${flowId}". Pass --input <value>.`,
    );
  }

  return validateInputKind(flowId, flow.input.kind, input.cwd, resolvedInput);
};

export const mapFromPrdArgToFlowInput = (
  cwd: string,
  prdRef: string,
): ValidatedPrdFileFlowInput => {
  const validated = validateHubFlowInput("prd-decomposition", {
    cwd,
    rawInput: prdRef,
  });
  if (validated.kind !== "prd-file") {
    throw toHubFlowInputError(
      'Expected prd-file input for flow "prd-decomposition".',
    );
  }
  return validated;
};

export const mapTriageToFlowInput = (
  cwd: string,
  rawInput?: string,
): ValidatedTaskQueryFlowInput => {
  const validated = validateHubFlowInput("triage", {
    cwd,
    rawInput,
  });
  if (validated.kind !== "task-query") {
    throw toHubFlowInputError('Expected task-query input for flow "triage".');
  }
  return validated;
};

export const formatValidatedHubFlowInputSummary = (
  validated: ValidatedHubFlowInput,
): string => {
  switch (validated.kind) {
    case "prd-file":
      return `PRD input: ${validated.ref}`;
    case "task-query":
      return `Task query: ${validated.query}`;
    default: {
      const unsupportedKind: never = validated;
      throw toHubFlowInputError(
        `Unsupported validated Hub flow input kind "${unsupportedKind}".`,
      );
    }
  }
};
