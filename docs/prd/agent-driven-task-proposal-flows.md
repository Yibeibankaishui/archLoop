# PRD: Agent-Driven Task Proposal Flows

## Problem Statement

archLoop Hub task board commands such as PRD decomposition and task triage currently risk behaving like deterministic CLI helpers even though their primary value depends on semantic judgment. A regex-based `from-prd` command can prove that Beads writes work, but it cannot provide the same experience as an agent-guided `$to-issues` session: discussing slice boundaries, checking dependencies, explaining AFK/HITL classification, and iterating until the user approves the breakdown. A rule-based `triage` command has the same problem: triage is not just label assignment, it is a conversation that gathers context, recommends state transitions, asks for missing information, and produces durable notes.

Users need `archloop tasks from-prd` and `archloop tasks triage` to feel like first-class archLoop orchestration, not hidden deterministic scripts. These commands should use agents for judgment while preserving Hub's ownership of validation, confirmation, task store writes, run artifacts, and synchronization boundaries.

## Solution

Introduce agent-driven task commands backed by proposal flows. A proposal flow is a no-sandbox Hub flow that gathers required context, invokes an agent through archLoop's agent provider abstraction, lets the user refine a proposal through a CLI-managed proposal session, and accepts only a schema-validated task proposal as the final write request. Hub then validates the proposal, detects forbidden mutations, asks for confirmation or applies guarded `--yes` behavior, and writes the approved changes to the local task store.

`archloop tasks from-prd <prd-ref>` becomes the primary shortcut for the `prd-decomposition` proposal flow. It reads the PRD and related context, lets the user discuss vertical slices with the agent, and creates Beads tasks and dependency edges only after approval. `archloop tasks triage` becomes the primary shortcut for the `triage` proposal flow. It reads inbox and needs-info tasks, lets the user discuss the recommendations with the agent, and applies approved status, label, dependency, and comment updates locally.

`archloop run <project> --flow <id> --input <value>` should also expose these flows through the same flow execution path. The shortcut commands remain the recommended user interface, while `run --flow` provides a uniform advanced entry point for CLI automation and future GUI integration.

Hub-wide agent configuration selects provider, model, and provider-specific options by reusable stage role. The first version exposes role-level configuration through CLI commands and uses these roles for flow stages such as planning, triage, implementation, review, merge, and recovery. Proposal flows use the planning or triage roles and always run no-sandbox, but they are still archLoop flows: they use archLoop prompts, agent providers, structured output, run directories, and Hub task board writes.

## User Stories

1. As a archLoop Hub user, I want PRD decomposition to be performed by an agent, so that the task breakdown reflects semantic understanding rather than Markdown shape.
2. As a archLoop Hub user, I want `archloop tasks from-prd` to open an interactive proposal session, so that I can refine slices before tasks are created.
3. As a archLoop Hub user, I want the PRD decomposition agent to propose vertical slices, so that each task is independently grabbable and verifiable.
4. As a archLoop Hub user, I want each PRD-derived slice to include AFK/HITL classification, so that agent-owned and human-owned work are explicit.
5. As a archLoop Hub user, I want each PRD-derived slice to include acceptance criteria, so that implementers and reviewers know what done means.
6. As a archLoop Hub user, I want each PRD-derived slice to include dependency suggestions, so that Beads can represent the true ready queue.
7. As a archLoop Hub user, I want the agent to explain its slice and dependency rationale, so that I can judge whether the breakdown is correct.
8. As a archLoop Hub user, I want to ask the decomposition agent to split, merge, reorder, or reclassify slices, so that the final task graph matches my intent.
9. As a archLoop Hub user, I want to approve the final PRD decomposition before it writes Beads tasks, so that agent judgment never silently mutates the local task store.
10. As a archLoop Hub user, I want PRD-derived tasks to default to inbox, so that new work still passes through the task board unless I explicitly choose ready states.
11. As a archLoop Hub user, I want an interactive PRD session to optionally create AFK slices as ready_for_agent and HITL slices as ready_for_human, so that confirmed breakdowns can skip redundant triage.
12. As a archLoop Hub user, I want `from-prd --yes` to run a one-shot proposal and create inbox tasks by default, so that scripted workflows remain possible.
13. As a archLoop Hub user, I want high-severity PRD warnings to block unattended ready-state creation, so that unclear or risky slices are not sent directly to agents.
14. As a archLoop Hub user, I want `archloop tasks triage` to be performed by an agent, so that triage recommendations reflect task body, comments, dependencies, and codebase context.
15. As a maintainer, I want triage to show recommendations before applying them, so that I can accept, reject, or refine the agent's reasoning.
16. As a maintainer, I want to discuss triage recommendations with the agent, so that vague tasks can be clarified before their status changes.
17. As a maintainer, I want triage proposals to include status, category, confidence, labels, rationale, and concise comments, so that local task history is understandable.
18. As a maintainer, I want triage comments to include an AI triage disclaimer, so that collaborators know the notes were generated during AI triage.
19. As a maintainer, I want `triage --yes` to apply only low-risk high-confidence non-closing decisions, so that unattended triage does not silently close or heavily reshape tasks.
20. As a maintainer, I want wontfix and dependency-changing decisions to require explicit confirmation, so that product and scheduling decisions stay human-owned.
21. As a maintainer, I want triage writes to update only the local task store, so that remote issue mutations remain controlled by task sync.
22. As a collaborator, I want remote GitHub Issues to be updated by `archloop tasks sync`, not by proposal flows, so that sync conflicts and remote failures have one consistent owner.
23. As a archLoop Hub user, I want proposal sessions to save transcripts and final proposals in the Hub run directory, so that I can inspect how a task graph or triage decision was produced.
24. As a archLoop Hub user, I want Beads tasks to store concise run references instead of full transcripts, so that task history remains readable.
25. As a archLoop Hub user, I want proposal flows to use structured output, so that Hub can validate final proposals before writing them.
26. As a archLoop Hub user, I want invalid or missing structured output to fail without writing Beads, so that malformed agent responses are safe.
27. As a archLoop Hub user, I want proposal flows to run no-sandbox, so that they can naturally read host PRDs, Beads data, and Hub context without mount complexity.
28. As a archLoop Hub user, I want proposal flows to be allowed to explore extra context through normal agent behavior, so that high-capability agents can inspect relevant docs or code when useful.
29. As a archLoop Hub user, I want proposal flows to be checked after running for repo or Beads mutations, so that accidental writes are detected even without shell allowlists.
30. As a archLoop Hub user, I want detected proposal-flow mutations to fail the flow without automatic rollback, so that archLoop does not destroy concurrent user work.
31. As a archLoop Hub user, I want a Hub-wide agent config, so that all projects use a consistent provider/model policy for planning, triage, implementation, review, merge, and recovery.
32. As a archLoop Hub user, I want CLI commands to show and set Hub agent roles, so that I can configure the same settings a future GUI will edit.
33. As a archLoop Hub user, I want missing agent role config to trigger interactive setup in TTY mode, so that first-run setup is smooth.
34. As a archLoop Hub user, I want missing agent role config to fail clearly in non-interactive or `--yes` mode, so that scripts do not hang.
35. As a archLoop Hub user, I want agent role config to avoid storing credentials, so that provider/model choices stay separate from Hub env files and login state.
36. As a archLoop Hub user, I want run readiness checks before invoking a provider, so that missing credentials or login state are reported before a proposal session starts.
37. As an advanced user, I want `archloop run . --flow prd-decomposition --input <prd-ref>` to work, so that proposal flows can be scripted through the general flow interface.
38. As an advanced user, I want flow input schemas, so that each flow can validate whether `--input` is a file, task query, task selector, or other typed value.
39. As a future GUI user, I want proposal sessions, run artifacts, and agent config to be modeled independently of terminal prompts, so that GUI screens can reuse the same Hub primitives.
40. As a archLoop maintainer, I want deterministic PRD decomposition and triage heuristics removed from the user main path, so that judgment-producing task commands behave consistently.
41. As a archLoop maintainer, I want deterministic helpers retained only for tests or explicit internal fallback, so that tests can run without requiring a live agent.
42. As a archLoop maintainer, I want proposal prompts to be archLoop-owned, so that default behavior is versioned with the package and does not depend on user-local skills.
43. As a archLoop maintainer, I want proposal prompts to incorporate the methodology of the to-issues and triage skills, so that the productized flow keeps the familiar experience.
44. As a archLoop maintainer, I want ADRs for proposal sessions, no-sandbox mutation detection, and Hub-wide agent roles, so that future contributors understand the trade-offs.
45. As a archLoop maintainer, I want README, bundled archLoop skill, QA docs, and roadmap to describe the new behavior, so that users do not expect regex-based PRD parsing or direct remote issue writes.

## Implementation Decisions

- Add proposal flows as a distinct Hub flow kind. Proposal flows produce task proposals and do not directly mutate code or the local task store.
- Treat `archloop tasks from-prd` and `archloop tasks triage` as agent-driven task commands. They remain user-friendly shortcuts but internally execute proposal flows.
- Expose `prd-decomposition` and `triage` through `archloop run <project> --flow <id> --input <value>` as advanced entry points.
- Add typed flow input schemas to the Hub flow registry. `prd-decomposition` accepts a PRD file input. `triage` accepts a task query or defaults to inbox and needs-info work.
- Add Hub-owned prompts for `prd-decomposition` and `triage`. These prompts should be packaged with archLoop and should not depend on host-local skill paths.
- Incorporate the to-issues method into the PRD decomposition prompt: tracer-bullet vertical slices, independently grabbable tasks, AFK/HITL classification, dependency review, user-story coverage, and approval before publishing.
- Incorporate the triage method into the triage prompt: category/state recommendations, conflict detection, context gathering, codebase exploration when useful, durable notes, needs-info questions, ready-for-agent briefs, ready-for-human briefs, and wontfix explanation.
- Add proposal session orchestration. Hub manages the transcript, required context, agent turns, user refinement turns, finalization prompt, structured output validation, and application.
- Use Hub-managed transcripts instead of provider-native resume as the first-version semantic model. Provider-native resume may be an optimization later but should not define behavior.
- Require final proposals to be emitted as archLoop structured output. Hub validates the final task proposal schema before any Beads write.
- Keep final proposal generation in the agent. Hub must not infer business JSON from natural language conversation; Hub only validates and applies.
- Store proposal session artifacts in Hub run directories, including prepared context, transcript, final proposal, apply result, and event stream.
- Write only concise metadata, comments, and run references into Beads. Do not dump full proposal transcripts into task comments.
- Force proposal flows to run no-sandbox. They may still use normal agent exploration and prompt expansion, but they are not allowed to write code or task state.
- Do not impose a shell-expression allowlist in the first version. Instead, provide strong prompt instructions and detect prohibited mutations after each proposal flow run.
- Add post-run mutation detection for proposal flows. Compare repo state and local task store state before and after the proposal flow. If either changed unexpectedly, fail the flow and do not apply the proposal.
- Do not automatically revert detected mutations. Report the detected changes and leave recovery to the user to avoid overwriting concurrent work.
- Add Hub-wide agent config stored in the archLoop user data directory, not in target project repos.
- Model Hub agent config as reusable stage roles: planning, triage, implementation, review, merge, and recovery.
- Add CLI commands to inspect and edit Hub agent roles: show config, show config path, and set provider/model/options for a role.
- Do not expose flow/stage override commands in the first version. Flow definitions map internal stages to Hub agent roles.
- Keep credentials and auth state separate from Hub agent config. Provider readiness checks should use Hub env files, Hub auth directories, process environment overrides, and provider-specific login checks.
- In interactive TTY mode, missing Hub agent role config should offer setup. In non-interactive and `--yes` modes, missing config should fail with an actionable command.
- `from-prd` should default to creating inbox tasks. Interactive sessions may create ready_for_agent or ready_for_human tasks after the user confirms slice granularity, dependencies, and AFK/HITL classification.
- `from-prd --yes` should create inbox tasks by default and should not silently create ready tasks unless a future explicit option requests it.
- `triage` should default to confirmation before applying decisions. `triage --yes` may apply only high-confidence, low-risk, non-closing decisions.
- `wontfix`, dependency-changing, low-confidence, and medium-confidence triage decisions require explicit confirmation.
- Triage comments written to Beads must include the AI triage disclaimer.
- PRD-derived task bodies do not need the triage disclaimer, but they must include origin and proposal run metadata.
- Proposal flows write only to the local task store. Remote GitHub issue changes remain the responsibility of task sync.
- Remove deterministic PRD decomposition and deterministic triage from the user main path. Keep deterministic helpers only for tests or an explicit internal fallback.
- Add ADRs for agent-driven proposal sessions, no-sandbox proposal flows with mutation detection, and Hub-wide agent roles.
- Update public documentation, the bundled archLoop usage skill, QA docs, and roadmap to describe agent-driven proposal flows and the new agent config model.

Potential deep modules:

- Proposal session runtime: a provider-agnostic module that manages context, transcript turns, finalization, artifact persistence, structured output, and apply lifecycle.
- Task proposal schemas: isolated schemas for PRD decomposition and triage proposals, including validation rules for dependencies, statuses, confidence, and warnings.
- Flow input schema registry: a small interface for validating generic `--input` values against flow-specific requirements.
- Hub agent config store: a Hub-wide store for stage role provider/model/options with CLI-friendly read/write operations.
- Provider readiness checker: a module that validates whether a configured agent provider can run before launching a flow.
- Mutation detector: a module that snapshots repo and local task store state before/after proposal flows and reports unexpected changes.
- Proposal applicators: separate applicators for PRD decomposition and triage that translate validated proposals into Beads task creations, dependency edges, status updates, and concise comments.

## Testing Decisions

- Tests should focus on external behavior and contracts rather than prompt wording internals.
- Add tests for Hub agent config CLI behavior: empty config, set-role, show, path, invalid role, provider/model/options persistence, and non-interactive missing-config errors.
- Add tests for flow input schema validation: PRD file inputs, missing inputs, invalid paths, triage defaults, and unsupported input kinds.
- Add tests for proposal session orchestration with fake agent invocations: first draft, user refinement turn, approve/finalization, invalid structured output, and cancelled session.
- Add tests for final proposal validation: valid PRD proposals, dependency cycles, unknown tempIds, invalid slice types, missing acceptance criteria, invalid triage statuses, invalid confidence values, and blocked `--yes` decisions.
- Add tests for PRD proposal application: task creation, metadata, acceptance criteria body, dependency edge creation, inbox default, ready-state creation after explicit confirmation, and no remote sync.
- Add tests for triage proposal application: status transitions, labels, AI disclaimer comments, needs-info questions, ready-for-agent briefs, ready-for-human briefs, wontfix confirmation, and safe `--yes` filtering.
- Add tests for mutation detection: clean no-op runs, repo modifications, Beads modifications, concurrent-change reporting, and failure without automatic rollback.
- Add tests for run artifact persistence: prepared context, transcript, final proposal, apply result, and event records.
- Add tests for `archloop run --flow --input`: dispatch to proposal flows, input validation, missing config, and shared execution path with task shortcut commands.
- Add tests that deterministic PRD decomposition is no longer the default user path.
- Use existing CLI tests as prior art for command behavior, task board projection, Hub flow execution, and Beads integration fakes.
- Use existing Hub flow execution tests as prior art for registry dispatch and fake agent invocation.
- Use existing task board and sync tests as prior art for local Beads state assertions and remote-sync separation.

## Out of Scope

- Building the GUI for proposal sessions or agent config.
- Directly calling user-local `$to-issues` or `$triage` skill files at runtime.
- Directly creating, updating, labeling, commenting on, or closing GitHub Issues from proposal flows.
- Storing credentials or auth tokens in Hub agent config.
- Flow-specific or project-specific agent config override commands.
- Provider-native resume as the behavior-defining proposal session mechanism.
- Shell-expression allowlists for proposal flows.
- Automatic rollback of accidental agent mutations.
- Editing structured proposals in a full-screen CLI editor.
- Replacing Beads as the local task store.
- Removing `archloop init` or old scaffolded `main.ts` / `main.mts` workflows.

## Further Notes

This PRD refines the Hub task board design by changing judgment-producing task commands from deterministic helpers into agent-driven proposal sessions. The previous deterministic `from-prd` implementation remains useful as a test fixture, but it should not define product behavior.

Three ADRs should accompany implementation:

- Agent-driven task commands use proposal sessions.
- Proposal flows run no-sandbox with post-run mutation detection.
- Hub-wide agent roles configure flow stages.

The proposal session model is intentionally CLI-first but GUI-ready. The same transcript, final proposal, run artifacts, flow input schema, and Hub agent config can later power a graphical archLoop Hub without changing the task-board semantics.
