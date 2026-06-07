import { describe, expect, it } from "vitest";
import {
  evaluateGitRemoteGuidance,
  githubIssuesGitRemoteNextStepLines,
  isMalformedGithubRemoteUrl,
} from "./initGitRemoteGuidance.js";

describe("isMalformedGithubRemoteUrl", () => {
  it("detects double https://github.com prefix", () => {
    expect(
      isMalformedGithubRemoteUrl(
        "https://github.com/https://github.com/user/repo.git",
      ),
    ).toBe(true);
  });

  it("detects nested github.com path segments", () => {
    expect(
      isMalformedGithubRemoteUrl("https://github.com/github.com/user/repo.git"),
    ).toBe(true);
  });

  it("accepts a normal HTTPS origin URL", () => {
    expect(isMalformedGithubRemoteUrl("https://github.com/user/repo.git")).toBe(
      false,
    );
  });
});

describe("evaluateGitRemoteGuidance", () => {
  it("flags repos with no remotes", () => {
    expect(evaluateGitRemoteGuidance({ isGitRepo: true, remotes: [] })).toEqual(
      { kind: "no-remotes" },
    );
  });

  it("flags malformed origin URLs", () => {
    expect(
      evaluateGitRemoteGuidance({
        isGitRepo: true,
        remotes: [
          {
            name: "origin",
            url: "https://github.com/https://github.com/user/repo.git",
          },
        ],
      }),
    ).toEqual({
      kind: "malformed-url",
      remote: "origin",
      url: "https://github.com/https://github.com/user/repo.git",
    });
  });

  it("returns ok for a valid remote", () => {
    expect(
      evaluateGitRemoteGuidance({
        isGitRepo: true,
        remotes: [{ name: "origin", url: "https://github.com/user/repo.git" }],
      }),
    ).toEqual({ kind: "ok" });
  });

  it("ignores non-git directories", () => {
    expect(
      evaluateGitRemoteGuidance({ isGitRepo: false, remotes: [] }),
    ).toEqual({ kind: "not-a-repo" });
  });
});

describe("githubIssuesGitRemoteNextStepLines", () => {
  it("suggests adding origin when no remotes exist", () => {
    const lines = githubIssuesGitRemoteNextStepLines({ kind: "no-remotes" });
    expect(lines.join(" ")).toMatch(/git remote add origin/i);
    expect(lines.join(" ")).toMatch(/gh repo set-default/i);
  });

  it("suggests fixing a duplicated github.com URL", () => {
    const lines = githubIssuesGitRemoteNextStepLines({
      kind: "malformed-url",
      remote: "origin",
      url: "https://github.com/https://github.com/user/repo.git",
    });
    const joined = lines.join(" ");
    expect(joined).toMatch(/git remote set-url origin/i);
    expect(joined).toMatch(/do not prefix https:\/\/github\.com\/ twice/i);
  });
});
