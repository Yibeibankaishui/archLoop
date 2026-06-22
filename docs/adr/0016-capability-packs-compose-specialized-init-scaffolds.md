# Capability packs compose specialized init scaffolds

`archloop init` will support explicit capability pack selection for specialized development work. A capability pack composes existing init concepts -- template, project profile, preset agents, skills, context files, verification entrypoints, and optional capability add-ons -- into a coherent scaffold for a class of development tasks. The first non-generic capability pack is WeChat Mini Program development.

## Decision

Capability packs are init-time scaffolding choices. archLoop will not silently infer a capability pack from repository files in the first version. A selected capability pack provides defaults for other init choices, such as template, project profile, and preset agents, but explicit init flags override those defaults.

Templates remain orchestration strategies, while capability packs own the specialized verification contract. Selecting a different template such as a parallel planner or reviewer workflow changes agent coordination, not the Mini Program diagnostic log or completion reporting contract.

Template compatibility with a capability pack is explicit. Unknown or incompatible templates fail init instead of silently falling back to the capability default, because fallback would hide the user's selected orchestration strategy.

The first version uses init-time prompt assembly: init writes prompt templates that include the relevant preset agent role, skills, capability context, verification guidance, and selected add-on guidance. archLoop will not add a public `run({ agentProfile })` runtime API in this version.

Init writes a capability manifest in the config directory to record the selected capability pack, variant, selected add-ons, verification entrypoint, diagnostic log, and setup action outcomes. Setup action records keep `status` separate from `reason` so already-satisfied prerequisites, user-declined setup, unavailable package metadata, successful installation, and failed installation remain distinguishable. The manifest is scaffold metadata; generated workflows do not need to read it to run in the first version.

Capability packs own scaffold artifacts in the config directory by default. They do not silently modify host repo application files such as `package.json` in the first version.

## WeChat Mini Program pack

The WeChat Mini Program core pack centers on a layered validation loop for the native Mini Program variant:

```text
agent changes code
-> .archloop/verify.sh
-> npm run wx:check when present, otherwise .archloop/wx-check-native.mjs
-> native project-shape checks
-> miniprogram-ci preview when platform validation configuration is detected
-> debug/wx-check.log
-> agent reads the log and fixes failures
```

The first Mini Program capability pack supports only native WeChat Mini Programs. Cross-framework variants such as Taro, uni-app, and mpvue are not supported in the first version. If a project-specific `wx:check` is absent, the generated verification entrypoint falls back to a native verifier; unsupported variants fail with an explicit diagnostic rather than being treated as verified. The native fallback uses explicit reject signals for known cross-framework projects and build output roots instead of attempting broad framework inference.

The core pack supports sandboxed and no-sandbox init paths. It scaffolds a verification entrypoint, native fallback verifier, context, skills, and prompt templates, but it does not automatically add `wx:check` scripts or `miniprogram-ci` dependencies to the host repo's `package.json`.

During init, archLoop may detect missing `miniprogram-ci` and offer an explicit project installation choice. This is not silent installation: `package.json` or lockfile mutation is allowed only after the user chooses the setup action. Detection prefers project-local Node package resolution over global CLI probing: `miniprogram-ci/package.json` must resolve from the host repo, its version must be readable, and the package must expose expected Node API members such as `Project`, `preview`, and `packNpm`. Global CLI or `npx` availability can be documented as a manual fallback, but it does not satisfy archLoop's managed Mini Program verification loop in the first version. The setup action chooses the package manager from the host repo's existing signals: `package.json#packageManager`, then lockfiles, then npm. If there is no `package.json`, init does not create one just to install `miniprogram-ci`; it continues with guidance instead. If the user declines installation, init still completes and generated guidance explains how to install or configure the tool later. If user-approved installation fails, init still writes the capability scaffold, records setup status without storing full stderr, and reports the failed command plus manual recovery guidance. Project-local `miniprogram-ci` is preferred over host global availability because it is more repeatable across Docker, CI, and agent verification loops.

The native fallback verifier uses explicit project config selection rather than monorepo discovery in the first version. `WX_PROJECT_CONFIG` may point to the intended `project.config.json`; otherwise the verifier checks only the repository root `project.config.json` and fails with diagnostics instead of guessing among nested apps. The resolved project config and `miniprogramRoot` must stay inside the repository; the fallback verifier does not inspect Mini Program roots outside the host repo.

The native fallback verifier performs static project-structure integrity checks rather than simulating the WeChat compiler. It checks JSON validity, declared pages, page/component files, `usingComponents`, `tabBar` page references, and tab bar icon assets, while leaving deeper compile/runtime behavior to project-owned `wx:check`, configured `miniprogram-ci`, or WeChat Developer Tools.

When a project-owned `npm run wx:check` exists, `.archloop/verify.sh` acts as a verification wrapper rather than replacing the project command. The project command's exit code decides success or failure, while the wrapper preserves the Mini Program pack's diagnostic contract by capturing stdout/stderr and ensuring `debug/wx-check.log` contains structured summary information.

`miniprogram-ci` platform validation is recommended but not required. If platform validation configuration is absent, the native verifier keeps running local checks and writes a non-failing diagnostic. If configuration is detected, platform validation is enabled without a separate opt-in flag, and the verifier runs `preview` by default through the `miniprogram-ci` Node API. The verifier creates `ci.Project` from `appid`, `projectPath`, `privateKeyPath`, and `type: "miniProgram"`, then calls `ci.preview` with image QR output. Missing or unusable project-local `miniprogram-ci`, bad upload keys, AppID mismatches, IP allowlist rejections, and preview failures are verification failures rather than reasons to silently fall back to local-only validation.

`ci.packNpm` is not run unconditionally before preview. The native verifier runs it only when Mini Program npm build signals are present, or when the user explicitly sets `WX_PACK_NPM=1`; `WX_PACK_NPM=0` explicitly skips it. This keeps default preview validation lean while allowing projects that depend on Mini Program npm packaging to request the build step.

AppID is resolved from `WX_APPID` before `project.config.json.appid`. Missing or placeholder AppID disables platform validation without failing local verification, but it is reported as a visible warning so users know preview/upload validation did not run.

When using the repository-local upload key location, the key filename is derived from the effective AppID. Explicit `WX_UPLOAD_KEY_PATH` takes precedence over repository-local key lookup and does not redefine the effective AppID.

Successful configured `miniprogram-ci preview` writes the preview QR code as a verification artifact under `debug/`, not under `.archloop/`. `.archloop/` remains the config scaffold; `debug/` holds run outputs such as `wx-check.log` and `wx-preview.jpg`. Init does not modify the host repo root `.gitignore`; generated guidance recommends ignoring these verification artifacts, and the verifier can warn when they are not ignored.

The Mini Program setup checklist under `.archloop/context/` is an init-time snapshot. Verification runs do not update it; runtime results belong in the verification diagnostic log and verification artifacts under `debug/`.

Mini Program agents must report final verification as separate local and platform states. A local pass with unconfigured platform validation is not the same as platform validation passing.

WeChat code upload private keys remain user-owned credentials. Init may scaffold `.archloop/auth/wx-upload/.gitignore` and document `.archloop/auth/wx-upload/private.{appid}.key` as a protected local credential drop zone, but `WX_UPLOAD_KEY_PATH` pointing outside the repository is the recommended path and takes precedence. archLoop does not generate, copy, upload, commit, or store private key contents or sensitive private key metadata in the capability manifest.

WeChat DevTools MCP is modeled as the first Mini Program capability add-on. It is only accepted with the no-sandbox provider because it depends on host state such as local GUI tools, MCP configuration, and login state. Enabling the add-on scaffolds context and prompt guidance; init does not install external tools, start authentication, or launch WeChat Developer Tools.

Mini Program MCP add-ons are not enabled by default. No-sandbox users may explicitly select them; sandboxed init paths reject or disable them with a host-state explanation.

Selecting the runtime-debug add-on does not change `.archloop/verify.sh`. WeChat DevTools MCP guidance belongs in prompts and context files, while the verification entrypoint stays CLI-oriented and repeatable.

When selected, the runtime-debug add-on generates context only, such as `.archloop/context/miniprogram-runtime-debug.md`. It does not generate scripts, MCP server configuration, install packages, or start WeChat Developer Tools.

## Considered options

1. **Extend project profiles instead** -- rejected. A project profile describes language and build-tool shape, while a capability pack specializes a development loop and composes prompts, skills, context, verification, and add-ons.
2. **Use templates alone** -- rejected. A template defines workflow shape, but specialized development also needs tool context, agent roles, verification contracts, and optional add-ons.
3. **Use preset agents alone** -- rejected. A preset agent describes an agent role, but it cannot by itself prepare the environment or define a repository verification loop.
4. **Automatically infer capability packs** -- rejected for the first version. Specialized scaffolds have wider effects than project profiles, and repository signals such as `project.config.json` or `app.json` are ambiguous across native mini programs, Taro, uni-app, monorepos, and partial repos.
5. **Add runtime `agentProfile` support immediately** -- rejected for the first version. It would expand `run()`, `interactive()`, `createSandbox()`, and worktree APIs before the scaffolded shape is proven. Init-time prompt assembly solves the first reliability problem without growing the runtime API.
6. **Automatically install MCP tools or complete host authentication** -- rejected. WeChat DevTools MCP depends on host state and user-controlled login; init should not make it a hard requirement for the core mini program loop.
7. **Automatically modify `package.json`** -- rejected for the first version. Mini program repos vary across package managers, frameworks, and monorepo layouts. The first version keeps capability-owned artifacts inside the config directory, except for explicit user-approved setup actions such as installing `miniprogram-ci` into the project.

## Consequences

- Capability packs become a new init registry alongside templates, project profiles, preset agents, and sandbox providers.
- Init ordering must resolve capability defaults before applying explicit template, project profile, and preset-agent selections.
- The WeChat Mini Program pack can ship a useful core loop for Docker and no-sandbox users while preserving no-sandbox-only add-ons for host-dependent MCP workflows.
- Future web and game capability packs can reuse the same abstraction without being implemented in the first version.
- A later runtime agent-profile API remains possible, but it should be justified by repeated scaffold use rather than introduced up front.
