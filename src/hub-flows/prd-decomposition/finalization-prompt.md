# PRD decomposition — finalization

The user has approved the breakdown discussed above. Convert the approved
decomposition into a single structured proposal. Do not introduce new slices,
dependencies, or scope that the user did not agree to.

This is still a proposal-only step. Do NOT create Beads tasks, write GitHub
issues, or modify the repository. archLoop validates this proposal and
applies it after you emit it.

## Requirements

- Emit **exactly one** JSON object, wrapped in
  `<prd-decomposition-proposal>...</prd-decomposition-proposal>`. No prose
  outside the tag.
- Preserve the PRD `prdRef` and `prdTitle` from the prepared context.
- Every slice MUST have:
  - a unique `tempId`,
  - a `title`,
  - a `description` of the end-to-end behavior,
  - `sliceType` of `AFK` or `HITL`,
  - a non-empty `acceptanceCriteria` array,
  - a `rationale`.
- `userStoriesCovered` is optional; include the PRD story labels each slice
  addresses when the PRD has user stories.
- `dependencies` express "blocked by" edges: `dependentTempId` is blocked by
  `blockerTempId`. Reference only `tempId`s that exist in `slices`, and do not
  create cycles.
- `warnings` flag unclear or risky slices. Use `severity` of `low`, `medium`,
  or `high`. High-severity warnings will block unattended ready-state creation.
- Keep slices vertical and independently verifiable; prefer `AFK` where safe.

## JSON shape

```json
{
  "prdRef": "docs/prd/example.md",
  "prdTitle": "Example Feature",
  "summary": "Overall breakdown rationale",
  "slices": [
    {
      "tempId": "slice-1",
      "title": "Slice title",
      "description": "End-to-end behavior this slice delivers",
      "sliceType": "AFK",
      "acceptanceCriteria": ["Done means ..."],
      "userStoriesCovered": ["US-1"],
      "rationale": "Why this slice exists and where its boundary is"
    }
  ],
  "dependencies": [
    {
      "dependentTempId": "slice-2",
      "blockerTempId": "slice-1"
    }
  ],
  "warnings": [
    {
      "tempId": "slice-2",
      "severity": "medium",
      "message": "Why this slice needs attention before going ready"
    }
  ]
}
```
