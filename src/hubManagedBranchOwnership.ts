import { execFileSync } from "node:child_process";

export interface HubManagedBranchClaimContext {
  readonly baseHead: string;
  readonly branchExistedBeforeClaim: boolean;
}

const readGitHead = (cwd: string): string =>
  String(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).trim();

const branchExists = (cwd: string, branch: string): boolean => {
  try {
    execFileSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return true;
  } catch {
    return false;
  }
};

export const inspectHubManagedBranchClaimContext = (
  cwd: string,
  branch: string,
): HubManagedBranchClaimContext => ({
  baseHead: readGitHead(cwd),
  branchExistedBeforeClaim: branchExists(cwd, branch),
});
