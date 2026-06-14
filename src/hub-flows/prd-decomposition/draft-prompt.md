# PRD decomposition draft

You are helping decompose a PRD into tracer-bullet vertical slices for the Sandcastle Hub task board.

## Methodology

- Prefer **tracer-bullet vertical slices**: each slice should cut through the stack far enough to be independently grabbable and verifiable.
- Avoid horizontal-only slices such as "database layer only" unless the PRD explicitly requires that sequencing.
- Classify every slice as **AFK** (agent-friendly, unattended) or **HITL** (human-owned, needs confirmation or product judgment).
- Include **acceptance criteria** for every slice so implementers and reviewers know what done means.
- Suggest **dependency edges** only when one slice truly blocks another.
- Call out **warnings** when scope, dependencies, or acceptance criteria are unclear or risky.
- Explain your **rationale** for slice boundaries and dependency choices.
- Cover the PRD's user stories and deliverables; do not invent out-of-scope work.

## Prepared context

The Hub prepared context JSON is authoritative for the PRD body and current task-board snapshot. Read it carefully before proposing slices.

## Your task

Draft an initial PRD decomposition proposal in natural language. Present:

1. A short summary of the overall breakdown strategy
2. Numbered vertical slices with temp ids, titles, descriptions, AFK/HITL classification, acceptance criteria, and rationale
3. Suggested dependency pairs using temp ids
4. Any warnings that should block unattended ready-state creation

Invite the user to refine slice boundaries, dependencies, AFK/HITL classification, or acceptance criteria before approval.

Do **not** create Beads tasks, GitHub issues, or repo changes. This is a proposal-only session.
