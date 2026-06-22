const NONE_MARKERS =
  /^(?:none|nothing|n\/a|not applicable|can start immediately)\b/i;

const BLOCKED_BY_SECTION =
  /(?:^|\n)#{1,3}\s*Blocked by[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|\n##\s|$)/i;

const INLINE_BLOCKED_BY = /(?:^|\n)Blocked by:\s*([^\n]+)/i;

const BEADS_ID_REF = /^-\s+([A-Za-z][\w.-]+)\s*$/gm;

const dedupeRefs = (refs: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
};

export const sectionDeclaresNoBlockers = (section: string): boolean => {
  const trimmed = section.trim();
  if (!trimmed) return true;

  const normalized = trimmed.replace(/^-\s+/gm, "").replace(/\s+/g, " ").trim();

  return NONE_MARKERS.test(normalized) && !normalized.includes("#");
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
  return dedupeRefs(refs);
};

export const parseDeclaredBeadsBlockers = (body: string): string[] => {
  const section = extractBlockedBySection(body);
  if (!section) {
    return [];
  }
  return parseBeadsBlockerIds(section);
};
