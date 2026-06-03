import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  evaluateGitRemoteGuidance,
  type GitRemoteGuidance,
} from "./initGitRemoteGuidance.js";

const execFileAsync = promisify(execFile);

const isNotGitRepositoryError = (message: string): boolean =>
  /not a git repository/i.test(message);

const runGit = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.toString().trim();
};

/** Inspect git remotes in `cwd` for GitHub Issues init guidance. */
export const inspectGitRemotes = async (
  cwd: string,
): Promise<GitRemoteGuidance> => {
  try {
    const remoteList = await runGit(["remote"], cwd);
    const names = remoteList.length > 0 ? remoteList.split("\n") : [];
    const remotes = await Promise.all(
      names.map(async (name) => ({
        name,
        url: await runGit(["remote", "get-url", name], cwd),
      })),
    );
    return evaluateGitRemoteGuidance({ isGitRepo: true, remotes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotGitRepositoryError(message)) {
      return { kind: "not-a-repo" };
    }
    throw error;
  }
};
