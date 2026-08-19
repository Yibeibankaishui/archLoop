import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const HUB_REPOSITORY_INTEGRITY_RECOVERY_GUIDANCE =
  "Run `git fsck --full`, inspect `git reflog show <branch>`, or restore the branch from a trusted remote. Hub does not reset or rewrite refs automatically.";

export interface HubGitCommandDiagnostic {
  readonly command: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly repositoryPath: string;
  readonly ref?: string;
  readonly object?: string;
}

export interface HubGitBranchInspection {
  readonly exists: boolean;
  readonly hasUnmergedWork: boolean;
  readonly changedFiles?: readonly string[];
  readonly integrityFailure?: HubGitCommandDiagnostic;
}

const readErrorProperty = (error: unknown, key: string): unknown | undefined =>
  typeof error === "object" && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;

const readStringProperty = (
  error: unknown,
  key: string,
): string | undefined => {
  const value = readErrorProperty(error, key);
  return typeof value === "string" ? value : undefined;
};

const readExitCode = (error: unknown): number | undefined => {
  const code = readErrorProperty(error, "code");
  return typeof code === "number" ? code : undefined;
};

export const formatGitCommand = (
  args: readonly string[],
): string => `git ${args.join(" ")}`;

const extractObjectFromGitStderr = (
  stderr: string | undefined,
): string | undefined => {
  if (!stderr) {
    return undefined;
  }

  const looseObject = /loose object ([0-9a-f]{40})/i.exec(stderr);
  if (looseObject?.[1]) {
    return looseObject[1];
  }

  const objectFile =
    /\.git\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})/i.exec(stderr);
  if (objectFile?.[1] && objectFile[2]) {
    return `${objectFile[1]}${objectFile[2]}`;
  }

  return undefined;
};

export const extractHubGitCommandDiagnostic = (input: {
  readonly repositoryPath: string;
  readonly args: readonly string[];
  readonly error: unknown;
  readonly ref?: string;
}): HubGitCommandDiagnostic => {
  const stderr = readStringProperty(input.error, "stderr");
  const object =
    extractObjectFromGitStderr(stderr) ??
    extractObjectFromGitStderr(readStringProperty(input.error, "message"));

  return {
    command: formatGitCommand(input.args),
    exitCode: readExitCode(input.error),
    stderr,
    repositoryPath: input.repositoryPath,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(object ? { object } : {}),
  };
};

const firstNonEmptyLine = (value: string | undefined): string | undefined =>
  value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

export const formatHubGitRepositoryIntegrityMessage = (input: {
  readonly branch: string;
  readonly diagnostic: HubGitCommandDiagnostic;
}): string => {
  const stderrLine =
    firstNonEmptyLine(input.diagnostic.stderr) ??
    "Git could not resolve the branch tip.";

  const objectSuffix = input.diagnostic.object
    ? ` (object ${input.diagnostic.object})`
    : "";

  return `Repository integrity failure for branch ${input.branch}${objectSuffix}: ${stderrLine}`;
};

const gitRefExists = async (
  repositoryPath: string,
  branch: string,
): Promise<boolean> => {
  try {
    await execFileAsync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repositoryPath },
    );
    return true;
  } catch {
    return false;
  }
};

const inspectBranchHistory = async (
  repositoryPath: string,
  branch: string,
): Promise<
  | { readonly kind: "ok"; readonly hasUnmergedWork: boolean; readonly changedFiles: readonly string[] }
  | { readonly kind: "integrity_failure"; readonly integrityFailure: HubGitCommandDiagnostic }
> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", `HEAD..${branch}`],
      { cwd: repositoryPath, encoding: "utf8" },
    );
    const diff = await execFileAsync(
      "git",
      ["diff", "--name-only", `HEAD...${branch}`],
      { cwd: repositoryPath, encoding: "utf8" },
    ).catch(() => ({ stdout: "" }));

    return {
      kind: "ok",
      hasUnmergedWork: Number(String(stdout).trim()) > 0,
      changedFiles: String(diff.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    };
  } catch (error) {
    return {
      kind: "integrity_failure",
      integrityFailure: extractHubGitCommandDiagnostic({
        repositoryPath,
        args: ["rev-list", "--count", `HEAD..${branch}`],
        error,
        ref: `refs/heads/${branch}`,
      }),
    };
  }
};

export const inspectHubGitBranch = async (
  repositoryPath: string,
  branch: string,
): Promise<HubGitBranchInspection> => {
  const ref = `refs/heads/${branch}`;
  const exists = await gitRefExists(repositoryPath, branch);
  if (!exists) {
    return { exists: false, hasUnmergedWork: false };
  }

  try {
    await execFileAsync(
      "git",
      ["rev-parse", "--verify", `${branch}^{commit}`],
      { cwd: repositoryPath },
    );
  } catch (error) {
    return {
      exists: true,
      hasUnmergedWork: false,
      integrityFailure: extractHubGitCommandDiagnostic({
        repositoryPath,
        args: ["rev-parse", "--verify", `${branch}^{commit}`],
        error,
        ref,
      }),
    };
  }

  const history = await inspectBranchHistory(repositoryPath, branch);
  if (history.kind === "integrity_failure") {
    return {
      exists: true,
      hasUnmergedWork: false,
      integrityFailure: history.integrityFailure,
    };
  }

  return {
    exists: true,
    hasUnmergedWork: history.hasUnmergedWork,
    ...(history.changedFiles.length > 0
      ? { changedFiles: history.changedFiles }
      : {}),
  };
};
