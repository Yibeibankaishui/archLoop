# Handoff: archLoop WeChat Mini Program Loop

## User Goal

The user wants to integrate a WeChat Mini Program development feedback loop into archLoop's agent orchestration. The current direction is to make it a reusable archLoop capability, not just a one-off MCP setup.

## Current Repo / Context

- Repo: `/Users/yibeibankaishui/projects/ref/archloop`
- Core research doc already exists: `docs/research/wx-miniprogram-loop.md`
- archLoop terminology lives in `CONTEXT.md`
- Type checking command from `AGENTS.md`: `npm run typecheck`
- User-facing changes need a patch changeset under `.changeset`, using `package.json#name`
- Public behavior changes should check `README.md`
- Roadmap maintenance is expected for major features or phase changes: `docs/roadmap.md`

## Decisions So Far

- Treat `miniprogram-ci` as the stable CLI validation loop.
- Treat `wechat-devtools-mcp` as runtime debugging enhancement, not the primary loop.
- Treat `CloudBase MCP` as the cloud development/deployment/log loop.
- Preferred archLoop integration shape:
  - Expand the existing `miniprogram` preset agent and bundled skill.
  - Add a dedicated workflow template, likely `wx-miniprogram-loop`.
  - Consider a future WeChat Mini Program project profile, but the first useful slice can avoid broad init/profile changes.
- Do not modify core `Orchestrator` first unless a later implementation proves templates/presets cannot express the workflow.

## Existing Code Touchpoints

- Existing preset agent registry: `src/presetAgents.ts`
- Existing miniprogram preset prompt: `src/preset-bundles/agents/miniprogram.prompt.md`
- Existing miniprogram bundled skill: `src/preset-bundles/skills/miniprogram-context/SKILL.md`
- Existing orchestration template examples:
  - `src/templates/simple-loop/main.mts`
  - `src/templates/parallel-planner/main.mts`
  - `src/templates/parallel-planner-with-review/main.mts`
- Existing project profiles: `src/projectProfiles.ts`

## Tool / Skill State Observed

- `CloudBase MCP` is installed and callable in the current session via `mcp__cloudbase__`.
- `CloudBase MCP` status was checked:
  - `auth_status: REQUIRED`
  - `env_status: NONE`
  - no current environment bound
- Suggested login path: call CloudBase MCP `auth` with `action="start_auth"` and `authMode="device"`, then bind env with `action="set_env"` and `envId`.
- Current machine had Node available:
  - `node -v` returned `v20.20.2`
- `uv` was not installed:
  - `uv --version` failed with command not found
- `wechat-devtools-mcp` install research:
  - PyPI package: `wechat-devtools-mcp`
  - Typical install path requires `uv`, e.g. `uv tool install wechat-devtools-mcp --force`
  - MCP config would use `uvx wechat-devtools-mcp`
  - Also requires WeChat Developer Tools service port enabled in settings.
- WaterTian skill relationship:
  - `miniprogram-development` is a general mini program development skill.
  - `WaterTian/wechat-devtools-mcp/.agents/skills/wechat-devtools` is the tool-specific SOP skill for `wechat-devtools-mcp`.

## Relevant Installed Skills For Next Session

Use these if the next session continues implementation or design:

- `miniprogram-development`: general WeChat Mini Program development rules and CloudBase mini program routing.
- `cloudbase-platform`: CloudBase platform and MCP setup/operation guidance.
- `cloud-functions`: CloudBase cloud function development/deployment/log guidance.
- `find-docs`: for current technical docs if needed.
- `roadmap-format`: if updating `docs/roadmap.md`.
- `existing-project-change`: useful if implementing a scoped change in this spec-driven repo.

Project rule also says to use `ctx7` CLI for current library/framework/API docs. Earlier `ctx7` lookup for `miniprogram-ci` did not find a direct useful library ID and returned unrelated mini program component/demo results; do not rely on those as authoritative.

## Proposed Implementation Slice

Recommended first implementation slice:

1. Expand `src/preset-bundles/skills/miniprogram-context/SKILL.md` with explicit loop rules:
   - Check `project.config.json`, `app.json`, routing, and page JSON.
   - After mini program code changes, run `npm run wx:check` when present.
   - If it fails, read `debug/wx-check.log` and continue fixing.
   - Keep upload private keys out of git, e.g. `private.*.key`.
   - Use `wechat-devtools-mcp` only after CLI validation passes and runtime behavior needs inspection.
   - Use CloudBase MCP for `wx.cloud`, `cloudfunctions/`, database/storage/deployment/log tasks.
2. Strengthen `src/preset-bundles/agents/miniprogram.prompt.md` so the preset agent explicitly follows the bundled skill and reports verification outcomes.
3. Add a new template under `src/templates/wx-miniprogram-loop/`, probably based on `parallel-planner-with-review` but with a mini program verifier phase.
4. Add tests for template/preset registry validity and any init/template copy behavior touched.
5. Add docs/changelog as required:
   - `.changeset/*.md`
   - maybe `README.md`
   - maybe `docs/roadmap.md`

## Important Design Boundaries

- Keep the primary validation loop inside the sandbox with npm scripts and `miniprogram-ci`.
- Runtime devtools automation is host-dependent and should be optional.
- CloudBase MCP is currently available to the outer Codex session, but archLoop agents inside a sandbox may need separate MCP/auth wiring; do not assume it is automatically available inside every agent runtime.
- Avoid requiring users to install `wechat-devtools-mcp` just to use the basic mini program template.

## Likely Next Ask

The next session may ask to implement the first slice, write a PRD, or install/configure `wechat-devtools-mcp` / CloudBase login. If implementing code, inspect current git state first and avoid reverting unrelated changes.
