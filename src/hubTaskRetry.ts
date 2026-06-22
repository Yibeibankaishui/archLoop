import { Effect, Either } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { existsSync, realpathSync } from "node:fs";
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

const runFileSystemEffect = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, NodeFileSystem.layer));

const mapLeaseErrorToPreparation = (
  error: WorktreeLeaseError,
  branch: string,
): HubTaskRetryPreparation | undefined => {
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
      message: `Worktree lease has invalid metadata for branch '${branch}'. ${error.message}`,
      lease: error,
    };
  }

  return undefined;
};

/** Detect whether a managed worktree already exists for a Hub task branch. */
export const detectPreservedHubTaskWorktree = async (
  repoDir: string,
  branch: string,
): Promise<PreservedHubTaskWorktree> => {
  const configuredWorktreePath = worktreePathForBranch(repoDir, branch);
  if (!existsSync(configuredWorktreePath)) {
    return {
      isRetry: false,
      preservedWorktreePath: undefined,
      hasDirtyWork: false,
    };
  }

  const preservedWorktreePath = (() => {
    try {
      return realpathSync(configuredWorktreePath);
    } catch {
      return configuredWorktreePath;
    }
  })();

  const hasDirtyWork = await runFileSystemEffect(
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

/** Format retry context for Hub implementer prompt substitution. */
export const formatHubRetryPromptContext = (input: {
  readonly branch: string;
  readonly preservedWorktreePath?: string;
  readonly hasDirtyWork: boolean;
}): string => {
  const retryContext = buildHubRetryPromptContext(input);
  return retryContext.length === 0 ? "" : `${retryContext}\n`;
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

  const leaseResult = await runFileSystemEffect(
    checkWorktreeLeaseBeforeHubRetry(input.repoDir, input.branch).pipe(
      Effect.either,
    ),
  );

  if (Either.isLeft(leaseResult)) {
    if (leaseResult.left instanceof WorktreeLeaseError) {
      const blocked = mapLeaseErrorToPreparation(
        leaseResult.left,
        input.branch,
      );
      if (blocked) {
        return blocked;
      }
    }
    throw leaseResult.left;
  }

  return {
    status: "ready",
    ...preserved,
    staleLeaseCleared: leaseResult.right.staleLeaseCleared,
  };
};
