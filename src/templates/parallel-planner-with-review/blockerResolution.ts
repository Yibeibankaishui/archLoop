export type BlockerRef = number | string;

export type ResolvedBlocker = {
  ref: BlockerRef;
  state: string;
  title: string;
};

export type BlockerEnrichmentFields = {
  blockersDeclared: BlockerRef[];
  blockersResolved: ResolvedBlocker[];
  openBlockers: BlockerRef[];
};

const NONE_MARKERS =
  /^(?:none|nothing|n\/a|not applicable|can start immediately)\b/i;

const BLOCKED_BY_SECTION =
  /(?:^|\n)#{1,3}\s*Blocked by[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|\n##\s|$)/i;

const INLINE_BLOCKED_BY = /(?:^|\n)Blocked by:\s*([^\n]+)/i;

const GITHUB_ISSUE_REF = /(?:^|[^\w])#(\d+)\b|issues\/(\d+)(?:\b|\/)/g;

const BEADS_ID_REF = /^-\s+([A-Za-z][\w.-]+)\s*$/gm;

const dedupeRefs = (refs: BlockerRef[]): BlockerRef[] => {
  const seen = new Set<string>();
  const out: BlockerRef[] = [];
  for (const ref of refs) {
    const key = String(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
};

export const sectionDeclaresNoBlockers = (section: string): boolean => {
  const trimmed = section.trim();
  if (!trimmed) return true;
  if (NONE_MARKERS.test(trimmed) && !trimmed.includes("#")) {
    return true;
  }
  const withoutListMarkers = trimmed
    .replace(/^-\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    NONE_MARKERS.test(withoutListMarkers) && !withoutListMarkers.includes("#")
  );
};

export const extractBlockedBySection = (body: string): string => {
  const sectionMatch = body.match(BLOCKED_BY_SECTION);
  if (sectionMatch) {
    return sectionMatch[1] ?? "";
  }
  const inlineMatch = body.match(INLINE_BLOCKED_BY);
  if (inlineMatch) {
    return inlineMatch[1] ?? "";
  }
  return "";
};

export const parseGithubBlockerNumbers = (section: string): number[] => {
  if (sectionDeclaresNoBlockers(section)) {
    return [];
  }

  const refs: number[] = [];
  for (const match of section.matchAll(GITHUB_ISSUE_REF)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const number = Number.parseInt(raw, 10);
    if (!Number.isNaN(number)) {
      refs.push(number);
    }
  }
  return dedupeRefs(refs) as number[];
};

export const parseBeadsBlockerIds = (section: string): string[] => {
  if (sectionDeclaresNoBlockers(section)) {
    return [];
  }

  const refs: string[] = [];
  for (const match of section.matchAll(BEADS_ID_REF)) {
    const id = match[1]?.trim();
    if (id) {
      refs.push(id);
    }
  }
  return dedupeRefs(refs) as string[];
};

export const parseDeclaredBlockers = (
  body: string,
  mode: "github" | "beads",
): BlockerRef[] => {
  const section = extractBlockedBySection(body);
  if (!section) {
    return [];
  }
  return mode === "github"
    ? parseGithubBlockerNumbers(section)
    : parseBeadsBlockerIds(section);
};

const isOpenState = (state: string): boolean => {
  const normalized = state.trim().toUpperCase();
  return normalized === "OPEN" || normalized === "IN_PROGRESS";
};

export const enrichReadyIssuesWithBlockers = async (
  issues: readonly Record<string, unknown>[],
  options: {
    mode: "github" | "beads";
    resolveBlocker: (ref: BlockerRef) => Promise<ResolvedBlocker | null>;
    warn?: (message: string) => void;
  },
): Promise<Record<string, unknown>[]> => {
  const warn = options.warn ?? (() => undefined);

  return Promise.all(
    issues.map(async (issue) => {
      const body = typeof issue.body === "string" ? issue.body : "";
      const description =
        typeof issue.description === "string" ? issue.description : "";
      const blockerBody = body || description;

      const blockersDeclared = parseDeclaredBlockers(blockerBody, options.mode);

      const blockersResolved: ResolvedBlocker[] = [];
      for (const ref of blockersDeclared) {
        const resolved = await options.resolveBlocker(ref);
        if (resolved) {
          blockersResolved.push(resolved);
        }
      }

      const openBlockers = blockersResolved
        .filter((blocker) => isOpenState(blocker.state))
        .map((blocker) => blocker.ref);

      const issueId = issue.number ?? issue.id;
      if (
        blockersDeclared.length > 0 &&
        openBlockers.length === 0 &&
        blockersResolved.length === blockersDeclared.length
      ) {
        warn(
          `Issue ${issueId}: declared blockers [${blockersDeclared.join(", ")}] are all closed — issue body may be stale.`,
        );
      }

      return {
        ...issue,
        blockersDeclared,
        blockersResolved,
        openBlockers,
      };
    }),
  );
};
