# PRD decomposition finalization

Convert the approved PRD decomposition discussion into the final structured task proposal.

## Requirements

- Emit one JSON object only, wrapped in `<prd-decomposition-proposal>...</prd-decomposition-proposal>`.
- Use unique `tempId` values for every slice.
- Every slice must include `title`, `description`, `sliceType` (`AFK` or `HITL`), non-empty `acceptanceCriteria`, and `rationale`.
- `dependencies` must reference existing slice `tempId` values only.
- Include `warnings` for unclear or risky slices. Use `severity` of `low`, `medium`, or `high`.
- Preserve the PRD reference and title from the prepared context.
- Do not create tasks or mutate the repo. Hub validates and applies the proposal after finalization.

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
      "description": "What the slice delivers",
      "sliceType": "AFK",
      "acceptanceCriteria": ["Done means..."],
      "rationale": "Why this slice exists"
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
      "message": "Why this needs attention"
    }
  ]
}
```
