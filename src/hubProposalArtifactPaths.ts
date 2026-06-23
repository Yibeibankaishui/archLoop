export interface ProposalSessionArtifactPaths {
  readonly artifactsDir: string;
  readonly preparedContextPath: string;
  readonly transcriptPath: string;
  readonly finalProposalPath: string;
  readonly applyResultPath: string;
  readonly proposalEventsPath: string;
}

const trimTrailingSeparators = (value: string): string =>
  value.replace(/[\\/]+$/, "");

const joinPath = (base: string, ...segments: readonly string[]): string => {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return [trimTrailingSeparators(base), ...segments].join(separator);
};

export const resolveProposalSessionArtifactPaths = (
  runDir: string,
): ProposalSessionArtifactPaths => {
  const artifactsDir = joinPath(runDir, "artifacts");
  const eventsDir = joinPath(runDir, "events");
  return {
    artifactsDir,
    preparedContextPath: joinPath(artifactsDir, "prepared-context.json"),
    transcriptPath: joinPath(artifactsDir, "transcript.json"),
    finalProposalPath: joinPath(artifactsDir, "final-proposal.json"),
    applyResultPath: joinPath(artifactsDir, "apply-result.json"),
    proposalEventsPath: joinPath(eventsDir, "proposal.jsonl"),
  };
};
