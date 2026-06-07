export type GitRemoteGuidance =
  | { readonly kind: "ok" }
  | { readonly kind: "not-a-repo" }
  | { readonly kind: "no-remotes" }
  | {
      readonly kind: "malformed-url";
      readonly remote: string;
      readonly url: string;
    };

export interface GitRemoteEntry {
  readonly name: string;
  readonly url: string;
}

/** Detect origin URLs with a duplicated `https://github.com/` prefix (field report #29 bug 7). */
export const isMalformedGithubRemoteUrl = (url: string): boolean =>
  /github\.com\/https?:\/\//i.test(url) ||
  /github\.com\/github\.com/i.test(url);

export const evaluateGitRemoteGuidance = (input: {
  readonly isGitRepo: boolean;
  readonly remotes: readonly GitRemoteEntry[];
}): GitRemoteGuidance => {
  if (!input.isGitRepo) {
    return { kind: "not-a-repo" };
  }
  if (input.remotes.length === 0) {
    return { kind: "no-remotes" };
  }
  for (const remote of input.remotes) {
    if (isMalformedGithubRemoteUrl(remote.url)) {
      return {
        kind: "malformed-url",
        remote: remote.name,
        url: remote.url,
      };
    }
  }
  return { kind: "ok" };
};

export const githubIssuesGitRemoteNextStepLines = (
  guidance: GitRemoteGuidance,
): string[] => {
  switch (guidance.kind) {
    case "ok":
    case "not-a-repo":
      return [];
    case "no-remotes":
      return [
        "This repo has no git remote. GitHub Issues backlog needs a remote (or `gh repo set-default`) before `gh issue` and git push work: `git remote add origin https://github.com/<owner>/<repo>.git`",
      ];
    case "malformed-url":
      return [
        `Git remote "${guidance.remote}" looks malformed (${guidance.url}). Use one full HTTPS URL, e.g. \`git remote set-url ${guidance.remote} https://github.com/<owner>/<repo>.git\` — do not prefix https://github.com/ twice.`,
      ];
  }
};
