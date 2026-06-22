import { Effect, Either } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { existsSync } from "node:fs";
import { WorktreeLeaseError } from "./errors.js";
import * as WorktreeManager from "./WorktreeManager.js";
import {
  checkWorktreeLeaseBeforeHubRetry,
  worktreePathForBranch,
} from "./WorktreeLease.js";

export interface PreservedHubTaskWorktree {
  readonly isRetry: boolean;
  readonly preservedWorktreePath?: string;
  readonly hasDirtyWork: boolean;
}

export interface HubTaskRetryPreparationReady extends PreservedHubTaskWorktree {
  readonly status: "ready";
  readonly staleLeaseCleared: boolean;
}

export interface HubTaskRetryPreparationActive {
  readonly status: "active_execution";
  readonly message: string;
  readonly lease: WorktreeLeaseError;
}

export interface HubTaskRetryPreparationMalformed {
  readonly status: "lease_malformed";
  readonly message: string;
  readonly lease: WorktreeLeaseError;
}

export type HubTaskRetryPreparation =
  | HubTaskRetryPreparationReady
  | HubTaskRetryPreparationActive
  | HubTaskRetryPreparationMalformed;

export interface PrepareHubTaskRetryInput {
  readonly repoDir: string;
  readonly branch: string;
  readonly taskId: string;
}

const runLeaseEffect = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<
      A,
      never
    >,
  );

/** Detect whether a managed worktree already exists for a Hub task branch. */
export const detectPreservedHubTaskWorktree = async (
  repoDir: string,
  branch: string,
): Promise<PreservedHubTaskWorktree> => {
  const preservedWorktreePath = worktreePathForBranch(repoDir, branch);
  if (!existsSync(preservedWorktreePath)) {
    return {
      isRetry: false,
      preservedWorktreePath: undefined,
      hasDirtyWork: false,
    };
  }

  const hasDirtyWork = await runLeaseEffect(
    WorktreeManager.hasUncommittedChanges(preservedWorktreePath),
  );

  return {
    isRetry: true,
    preservedWorktreePath,
    hasDirtyWork,
  };
};

/** Build optional retry context injected into Hub implementer prompts. */
export const buildHubRetryPromptContext = (input: {
  readonly branch: string;
  readonly preservedWorktreePath?: string;
  readonly hasDirtyWork: boolean;
}): string => {
  if (!input.preservedWorktreePath) {
    return "";
  }

  const dirtyNote = input.hasDirtyWork
    ? " The preserved worktree currently has uncommitted changes."
    : "";

  return [
    "# RETRY",
    "",
    "This Hub task is being retried from a preserved worktree.",
    `Inspect existing work on branch \`${input.branch}\` and in \`${input.preservedWorktreePath}\` before editing.${dirtyNote}`,
    "Continue from the previous attempt when possible instead of starting from scratch.",
    "Do not reset, clean, or discard partially completed code unless a separate explicit recovery action requests that behavior.",
    "",
  ].join("\n");
};

/** Build prompt args for Hub implementer retries. */
export const buildHubRetryPromptArgs = (input: {
  readonly branch: string;
  readonly preservedWorktreePath?: string;
  readonly hasDirtyWork: boolean;
}): Readonly<Record<string, string>> => {
  const retryContext = buildHubRetryPromptContext(input);
  if (retryContext.length === 0) {
    return { RETRY_CONTEXT: "" };
  }

  return { RETRY_CONTEXT: `${retryContext}\n` };
};

/**
 * Prepare a Hub task retry by checking worktree lease occupancy and detecting
 * preserved worktree state without deleting or resetting work.
 */
export const prepareHubTaskRetry = async (
  input: PrepareHubTaskRetryInput,
): Promise<HubTaskRetryPreparation> => {
  const preserved = await detectPreservedHubTaskWorktree(
    input.repoDir,
    input.branch,
  );

  try {
    const leaseResult = await Effect.runPromise(
      checkWorktreeLeaseBeforeHubRetry(input.repoDir, input.branch).pipe(
        Effect.either,
        Effect.provide(NodeFileSystem.layer),
      ) as Effect.Effect<
        Either.Either<
          { readonly staleLeaseCleared: boolean },
          WorktreeLeaseError
        >,
        never
      >,
    );

    if (Either.isLeft(leaseResult)) {
      const error = leaseResult.left;
      if (error.reason === "active") {
        return {
          status: "active_execution",
          message: error.message,
          lease: error,
        };
      }

      if (error.reason === "malformed") {
        return {
          status: "lease_malformed",
          message: `Worktree lease has invalid metadata for branch '${input.branch}'. ${error.message}`,
          lease: error,
        };
      }

      throw error;
    }

    return {
      status: "ready",
      ...preserved,
      staleLeaseCleared: leaseResult.right.staleLeaseCleared,
    };
  } catch (error) {
    if (error instanceof WorktreeLeaseError) {
      if (error.reason === "active") {
        return {
          status: "active_execution",
          message: error.message,
          lease: error,
        };
      }

      if (error.reason === "malformed") {
        return {
          status: "lease_malformed",
          message: `Worktree lease has invalid metadata for branch '${input.branch}'. ${error.message}`,
          lease: error,
        };
      }
    }

    throw error;
  }
};
