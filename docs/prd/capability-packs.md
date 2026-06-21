# PRD: Capability Packs For Specialized Agent Environments

## Problem Statement

archLoop users can choose templates, project profiles, preset agents, sandbox providers, and installed agent runtimes during init, but those choices are still low-level. A user who wants archLoop to specialize in a class of development work, such as WeChat Mini Program development, must know which template, project profile, preset agents, skills, prompts, verification commands, and optional host tools belong together.

The existing preset agent and bundled skill mechanism is useful but not strong enough for professional specialization. A preset prompt can tell the agent to read a skill file, but archLoop does not yet provide a higher-level scaffold that reliably assembles role guidance, domain skills, capability context, verification rules, and add-on guidance into a coherent prompt template and development loop.

The first motivating case is WeChat Mini Program development. The useful loop is not just "write code"; it is code, run a CLI validation command, read structured debug logs, fix failures, and optionally use host-dependent runtime debugging or cloud tooling when the sandbox mode supports it.

## Solution

Add capability packs to `archloop init`. A capability pack is an explicit init-time choice that specializes the generated config directory for a class of development work. It composes existing init concepts into a professional agent environment:

- A default template.
- A default project profile.
- Preset agents and bundled skills.
- Capability-specific context files.
- A verification entrypoint.
- A capability manifest.
- Optional capability add-ons.

The first version ships two capability packs:

- `generic`, the default pack that preserves the current low-assumption init path.
- `miniprogram`, the first specialized pack for WeChat Mini Program development.

The `miniprogram` core pack scaffolds a CLI-first feedback loop for the native WeChat Mini Program capability variant, centered on `.archloop/verify.sh`, `npm run wx:check` when present, the generated `.archloop/wx-check-native.mjs` fallback when `wx:check` is absent, Mini Program project checks, and `debug/wx-check.log`. It supports sandboxed and no-sandbox init paths. The core pack's required completion line is native local verification: the verification entrypoint must run project-specific `wx:check` or the generated native fallback, and it must not report success for unsupported variants such as Taro or uni-app.

Mini Program platform validation through `miniprogram-ci` preview, upload, or `packNpm` is guided and recommended, but optional for the core loop. Init should help users understand how to configure AppID, code upload private keys, and IP allowlists, but users may choose not to configure them. If `miniprogram-ci` platform validation is not configured, the agent loop must still run through local checks, project structure checks, build steps, and debug log feedback. If `miniprogram-ci` configuration is present, platform validation is considered enabled and the verifier must call it. Present but invalid configuration must fail loudly and point to the relevant log and configuration guidance rather than silently skipping the failure.

`miniprogram-ci` platform validation is recommended even though it is not required for the core loop. Without it, users may only discover WeChat compile, preview, upload, AppID, private key, or IP allowlist failures later when opening the project manually in WeChat Developer Tools. Generated context and init summary should therefore frame `miniprogram-ci` as the recommended platform validation layer, not as an unimportant extra.

The Mini Program toolchain should be presented as layered rather than as one tool doing everything:

- Local checks verify ordinary code quality and project shape without WeChat credentials.
- `miniprogram-ci` handles credentialed platform automation such as `preview`, `upload`, and `packNpm`; when configured, the fallback verifier runs `preview` by default as the platform validation action.
- WeChat Developer Tools plus the runtime-debug add-on handle simulator/runtime truth: IDE lifecycle, compile, navigation, screenshots, console logs, page state, and mocked `wx.*` interactions.
- Future cloud tooling may handle cloud functions, database, storage, environment operations, deployment, and cloud logs when a project uses cloud capabilities.

The first version models WeChat DevTools MCP as a no-sandbox-only `runtime-debug` capability add-on. This add-on scaffolds context and prompt guidance, but init does not install external tools, start authentication, or require MCP availability for the core loop. The default runtime-debug add-on guidance should target WaterTian `wechat-devtools-mcp`, because the tooling research found it better aligned with Mini Program runtime debugging and its companion skill/SOP model. The FliPPeDround `wechat-devtools-mcp` package may be mentioned only as a lightweight experimental fallback, not as the default runtime-debug path.

Capability packs provide defaults for other init choices, but explicit init flags override those defaults. For example, the Mini Program pack may default to a Mini Program loop template, Node project profile, and Mini Program preset agent, while still allowing a user to pass explicit `--template`, `--project-profile`, or `--preset-agents` flags.

The first version uses init-time prompt assembly. Init writes prompt templates that include the selected preset agent role, required skills, capability context, verification guidance, and selected add-on guidance. archLoop does not add a public runtime `run({ agentProfile })` API in the first version.

## User Stories

1. As a archLoop user, I want to select a capability pack during init, so that archLoop can scaffold an environment for the type of development work I want to automate.
2. As a archLoop user, I want `generic` to remain available, so that I can keep using archLoop without domain-specific assumptions.
3. As a archLoop user, I want to select `miniprogram`, so that my generated config directory is tailored to WeChat Mini Program development.
4. As a archLoop user, I want capability pack selection to be explicit, so that archLoop does not silently infer a specialized workflow from ambiguous repository files.
5. As a archLoop user, I want capability packs to provide sensible defaults for template, project profile, and preset agents, so that I do not need to manually assemble common combinations.
6. As a archLoop user, I want explicit init flags to override capability pack defaults, so that I can customize a pack without losing its context and verification scaffold.
7. As a archLoop user, I want init to write a capability manifest, so that the selected pack and add-ons are visible after init.
8. As a archLoop user, I want capability-owned files to live in the config directory, so that I can inspect and edit them without archLoop rewriting my application files.
9. As a archLoop user, I want the first version not to modify `package.json` unless I explicitly choose an init-time setup action that requires it, so that archLoop does not accidentally damage a project with custom package manager, framework, or monorepo conventions.
10. As a archLoop user, I want a verification entrypoint, so that agents have one stable command to run after changing code.
11. As a Mini Program developer, I want the first Mini Program capability variant to target native WeChat Mini Programs, so that archLoop can provide a meaningful built-in verification fallback.
12. As a Mini Program developer, I want `.archloop/verify.sh` to call `npm run wx:check` when available, so that the agent follows the project's own Mini Program validation loop.
13. As a Mini Program developer, I want `.archloop/verify.sh` to run `.archloop/wx-check-native.mjs` when no `wx:check` script is available, so that native Mini Program projects still get a real default verification loop.
14. As a Mini Program developer, I want the native fallback verifier to reject unsupported variants such as Taro, uni-app, mpvue, or cross-framework build outputs, so that the agent cannot mistake an unsupported project shape for a verified native Mini Program.
15. As a Mini Program developer, I want unsupported variant diagnostics to be written to `debug/wx-check.log`, so that I know whether to add a project-specific `wx:check` or wait for a future variant.
16. As a Mini Program developer, I want failed verification to point the agent at `debug/wx-check.log`, so that the agent fixes based on concrete logs instead of guessing.
17. As a Mini Program developer, I want the generated skill to mention `project.config.json`, `compileType`, `miniprogramRoot`, `app.json`, page JSON, component JSON, and routing rules, so that agents inspect the right files before changing Mini Program code.
18. As a Mini Program developer, I want the generated skill to warn against committing private upload keys such as `private.*.key`, so that agent work does not leak credentials.
19. As a Mini Program developer, I want the generated context to explain the expected `wx:check` loop and the native fallback verifier, so that I can adapt or replace the default verification path intentionally.
20. As a Mini Program developer, I want the generated context to include a WeChat DevTools error report template, so that runtime debugging feedback is structured for agents.
21. As a Mini Program developer, I want archLoop to guide me through optional but recommended `miniprogram-ci` platform validation configuration, so that I understand the AppID, code upload private key, and IP allowlist requirements before manual DevTools preview finds them later.
22. As a Mini Program developer, I want to skip `miniprogram-ci` platform validation configuration, so that the agent loop still works when I only want local checks.
23. As a Mini Program developer, I want the verification entrypoint to keep running native local checks when platform validation is unconfigured, so that missing credentials do not block basic agent iteration.
24. As a Mini Program developer, I want present `miniprogram-ci` configuration to automatically enable platform validation, so that configured preview/upload credentials are always exercised by the agent loop.
25. As a Mini Program developer, I want the default configured platform validation action to be `preview`, so that the verifier catches the same class of compile, AppID, private key, and IP allowlist problems that manual WeChat Developer Tools preview would expose.
26. As a Mini Program developer, I want invalid platform validation configuration to fail loudly, so that a broken private key, AppID, or IP allowlist does not look like a successful validation.
27. As a Mini Program developer, I want failed platform validation to write useful diagnostics to `debug/wx-check.log`, so that the agent can explain or fix project-side issues and tell me when account-side settings need human action.
28. As a Mini Program developer using Docker, I want the core Mini Program loop to remain available, so that I can use CLI validation without host GUI tooling.
29. As a Mini Program developer using no-sandbox, I want to enable a runtime debugging add-on, so that agent prompts include WeChat DevTools MCP guidance when host tooling is available.
30. As a Mini Program developer using no-sandbox, I want the runtime-debug add-on to guide agents toward WaterTian `wechat-devtools-mcp`, so that runtime debugging uses the most complete observed toolchain.
31. As a Mini Program developer using no-sandbox, I want runtime-debug guidance to mention WeChat Developer Tools service port, login state, CLI path, project path, and automator readiness, so that agents can diagnose local DevTools setup problems.
32. As a Mini Program developer using no-sandbox, I want runtime-debug guidance to include the `wait IDE port timeout` troubleshooting path, so that agents know to use the DevTools CLI open/auto flow when MCP startup is incomplete.
33. As a Mini Program developer, I want MCP add-ons not to be required for the core Mini Program pack, so that missing GUI tools do not block init.
34. As a Mini Program developer, I want MCP add-ons to be rejected for Docker in the first version, so that archLoop does not imply host-dependent tools are available inside a sandbox.
35. As a Mini Program developer, I want the runtime-debug add-on to be framed as simulator/runtime debugging rather than as a replacement for `miniprogram-ci` preview/upload automation, so that agents use the right tool for each layer.
36. As a Mini Program developer, I want generated context to distinguish WaterTian `wechat-devtools-mcp` from FliPPeDround `wechat-devtools-mcp`, so that users do not install the wrong same-name tool by accident.
37. As a Mini Program developer, I want FliPPeDround `wechat-devtools-mcp` to be described only as an experimental fallback, so that it does not become the default runtime-debug workflow.
38. As a archLoop user, I want the generated Mini Program prompt template to include the relevant skill and context, so that skill loading does not rely only on the agent deciding to open another file.
39. As a archLoop user, I want selected add-on guidance to be assembled into the prompt template, so that the agent sees only the add-ons I enabled.
40. As a archLoop user, I want generated prompts to remain ordinary Markdown files, so that I can edit the assembled guidance after init.
41. As a archLoop user, I want capability packs to work with existing agent providers, so that the first version does not depend on provider-native skill support.
42. As a archLoop user, I want the generated workflow to keep using the current `run()` API, so that capability packs do not require a new runtime API.
43. As a archLoop user, I want a future web capability pack to be possible, so that the abstraction is not Mini Program-specific.
44. As a archLoop user, I want a future game capability pack to be possible, so that the abstraction can support other specialized development loops.
45. As a maintainer, I want capability pack definitions in a registry, so that supported packs and add-ons are explicit and testable.
46. As a maintainer, I want capability pack ids and add-on ids to be stable and filesystem-safe, so that generated files and manifests are predictable.
47. As a maintainer, I want invalid capability pack definitions to fail tests, so that broken defaults or missing files do not ship.
48. As a maintainer, I want capability default resolution to happen before explicit init flags are applied, so that user overrides remain clear.
49. As a maintainer, I want capability add-on compatibility rules to be validated during init, so that unsupported sandbox/add-on combinations fail early.
50. As a maintainer, I want capability packs to reuse existing project profile and preset agent concepts, so that archLoop does not duplicate registries unnecessarily.
51. As a maintainer, I want prompt assembly to be testable without running a real agent, so that generated prompts reliably include required skill and context sections.
52. As a maintainer, I want template directories to remain self-contained, so that capability packs do not violate the template architecture decision.
53. As a maintainer, I want capability manifests to be scaffold metadata rather than required runtime config, so that generated workflows keep running even if future tooling changes.
54. As a maintainer, I want roadmap and documentation to distinguish project profiles, templates, preset agents, skills, capability packs, and capability add-ons, so that users have a clear mental model.

## Implementation Decisions

- Add a capability pack registry with at least `generic` and `miniprogram` definitions.
- Add a capability add-on definition for Mini Program runtime debugging.
- Add a capability variant concept to the Mini Program pack and implement only the native variant in the first version.
- Treat capability pack selection as an explicit init choice and as an optional scripted init flag.
- Do not automatically infer a capability pack from repository files in the first version.
- Resolve capability pack defaults before applying explicit template, project profile, and preset-agent init selections.
- Let explicit init flags override capability pack defaults.
- Keep orchestration templates orthogonal to capability verification contracts.
- Let templates decide agent orchestration strategy, such as `parallel-planner`, `parallel-planner-with-review`, or `sequential-reviewer`.
- Let capability packs decide domain context, verification entrypoint, diagnostic log contract, and final verification reporting.
- Ensure every template selected with the Mini Program capability pack uses the same Mini Program verification contract and final verification summary contract.
- Default the Mini Program capability pack to `parallel-planner-with-review` in the first version.
- Support `parallel-planner`, `parallel-planner-with-review`, `sequential-reviewer`, and `simple-loop` as first-version Mini Program capability templates.
- Allow explicit `blank` template selection with the Mini Program capability pack, but warn that blank templates require the user to manually wire the verification entrypoint into their workflow.
- Require templates to be marked compatible with the selected capability pack before Mini Program prompt assembly runs.
- Reject unknown or incompatible non-blank templates for the Mini Program capability pack instead of silently falling back to the default template.
- For incompatible Mini Program template selections, report an error that names the incompatible template and lists supported templates.
- Keep capability packs as init-time scaffolding choices rather than runtime options on `run()`, `interactive()`, `createSandbox()`, or sandbox providers.
- Use init-time prompt assembly for the first version.
- Generate assembled prompt templates that include preset role guidance, required skills, capability context, verification guidance, and selected add-on guidance.
- Do not add a public `run({ agentProfile })` API in the first version.
- Write a capability manifest in the config directory when a capability pack is selected.
- Keep the capability manifest as scaffold metadata, not required runtime configuration.
- Use `.archloop/capability.json` to record `capability`, `variant`, selected `addons`, `verification`, and `setupActions`.
- Record Mini Program verification metadata in `.archloop/capability.json`, including `entrypoint: ".archloop/verify.sh"` and `diagnosticLog: "debug/wx-check.log"`.
- Record setup actions in `.archloop/capability.json` with stable `id`, `status`, `packageManager`, `command`, and `summary` fields.
- Allow setup action `status` values `skipped`, `succeeded`, and `failed` in the first version.
- Record setup action `reason` separately from `status` so skipped setup actions distinguish already-satisfied prerequisites from user-declined or impossible setup.
- Use `reason: "already_available"` when `miniprogram-ci` is already available and no install action is needed.
- Use `reason: "user_declined"` when the user declines `miniprogram-ci` project installation.
- Use `reason: "no_package_json"` when the user chooses installation but the host repo has no `package.json`.
- Use `reason: "installed"` when user-approved `miniprogram-ci` project installation succeeds.
- Use `reason: "install_command_failed"` when user-approved `miniprogram-ci` project installation fails.
- Use `reason: "detected_but_unusable"` when a `miniprogram-ci` candidate exists but the lightweight availability probe fails.
- Keep `.archloop/capability.json` as metadata only; generated verification workflows must not require reading it to run.
- Add a verification entrypoint scaffold for capability packs that define a development validation loop.
- Use `.archloop/verify.sh` as the first-version verification entrypoint path.
- Generate `.archloop/wx-check-native.mjs` as the native Mini Program fallback verifier.
- Make `.archloop/verify.sh` prefer `npm run wx:check` when it exists and fall back to `.archloop/wx-check-native.mjs` when it does not.
- Treat `.archloop/verify.sh` as a verification wrapper when it runs project-owned `npm run wx:check`.
- Preserve `npm run wx:check` exit code as the source of verification success or failure when that project-owned command is present.
- Capture `npm run wx:check` stdout and stderr so the agent can inspect them through the verification diagnostic log even when the project command does not write structured diagnostics.
- If `npm run wx:check` does not write `debug/wx-check.log`, have `.archloop/verify.sh` create a JSONL `project_wx_check` event with `severity`, `message`, and `exit_code`.
- If `npm run wx:check` already writes `debug/wx-check.log`, have `.archloop/verify.sh` preserve the existing log and append a JSONL summary event instead of overwriting it.
- Make `.archloop/wx-check-native.mjs` validate native Mini Program project shape, including `project.config.json`, `compileType`, `miniprogramRoot`, `app.json`, route declarations, page JSON files, component JSON files, `tabBar` paths, and local asset references.
- Resolve the native Mini Program `project.config.json` path from `WX_PROJECT_CONFIG` when it is set.
- When `WX_PROJECT_CONFIG` is not set, check only the repository root `project.config.json` in the first version.
- Do not recursively scan monorepos or guess `apps/*/project.config.json` in the first version.
- Require the resolved `project.config.json` path to stay inside the repository.
- Require the resolved `miniprogramRoot` path to stay inside the repository.
- Report `project_config_missing` when no usable `project.config.json` is found.
- Report `project_config_ambiguous` if future discovery or user-provided inputs identify multiple candidates that archLoop cannot choose between.
- Report `project_config_outside_repo` when `WX_PROJECT_CONFIG` points outside the repository.
- Report `miniprogram_root_missing` when `miniprogramRoot` is missing or resolves to a missing directory.
- Report `miniprogram_root_outside_repo` when `miniprogramRoot` escapes the repository.
- Make `.archloop/wx-check-native.mjs` reject unsupported variants such as Taro, uni-app, mpvue, or cross-framework build outputs with an `unsupported_miniprogram_variant` diagnostic.
- Detect unsupported Mini Program variants through explicit reject signals rather than broad framework inference in the first version.
- Treat `@tarojs/*` dependencies or devDependencies as a Taro reject signal for the native fallback verifier.
- Treat `@dcloudio/*`, `uni-app`, or the `manifest.json` plus `pages.json` file pair near the selected project config as uni-app reject signals for the native fallback verifier.
- Treat `mpvue` dependencies or devDependencies as an mpvue reject signal for the native fallback verifier.
- Treat obvious cross-framework build output roots such as `dist/`, `dist/build/mp-weixin/`, and `unpackage/dist/dev/mp-weixin/` as unsupported native fallback inputs.
- Keep project-owned `npm run wx:check` as the escape hatch for unsupported variants; when it exists, `.archloop/verify.sh` runs the project command instead of the native fallback verifier.
- Scope the native fallback verifier to static project-structure integrity checks; do not attempt to simulate the WeChat compiler in the first version.
- Require `project.config.json` to be valid JSON.
- Treat `compileType` as compatible only when it is absent or compatible with native Mini Program development.
- Require `app.json` under `miniprogramRoot` to be valid JSON.
- Require `app.json.pages` to be a non-empty array.
- Require every page path in `app.json.pages` to resolve inside `miniprogramRoot`.
- Require each declared page to have `.json` and `.wxml` files; treat `.js` and `.wxss` as optional in the first version.
- Require every page `.json` file to be valid JSON.
- Resolve local `usingComponents` entries from app-level and page-level JSON and require component `.json` and `.wxml` files to exist.
- Require every `tabBar.list[].pagePath` to appear in `app.json.pages`.
- Check only `tabBar` `iconPath` and `selectedIconPath` local asset existence in the first version; do not perform full WXML/WXSS asset graph scanning.
- Keep bootstrap and verification separate: bootstrap prepares the repo before agent work, while verification checks the result after agent changes.
- Keep capability-owned generated files inside the config directory by default.
- Do not silently modify host repo application files such as `package.json` in the first version.
- Do not silently install `miniprogram-ci`, add `wx:check`, or add Mini Program automation scripts to the host repo in the first version.
- During Mini Program init, detect whether project-local `miniprogram-ci` is available through Node package resolution from the host repo.
- Prefer project-local `miniprogram-ci` over global CLI or `npx`, because project-local installation is versioned with the repo and repeatable across Docker, CI, and agent verification.
- Treat project-local `miniprogram-ci` as available only when `miniprogram-ci/package.json` resolves from the host repo, the package version is readable, and the Node API exposes expected members such as `Project`, `preview`, and `packNpm`.
- Use `createRequire`-style CommonJS package resolution for `miniprogram-ci` detection and verifier calls, even when the generated verifier itself is an ES module.
- Do not use `miniprogram-ci --version` as a required availability probe, because it is not the documented detection contract.
- Allow `miniprogram-ci --help` only as a secondary CLI executability probe for explicitly configured binary paths, not as the primary project dependency check.
- Record the detected `miniprogram-ci` source as `project_local` when project-local Node API detection succeeds.
- Do not treat global PATH, `npx`, or explicitly configured CLI-only availability as satisfying archLoop's Mini Program verification loop in the first version.
- Mention global CLI or `npx` only as manual user fallback guidance outside archLoop's managed verification loop.
- Treat a detected but unusable project-local `miniprogram-ci` package as missing for install prompting purposes.
- If `miniprogram-ci` is missing during Mini Program init, prompt the user to choose whether archLoop should install it into the project.
- If the user chooses installation, install `miniprogram-ci` into the host repo as an explicit init-time project setup action.
- Treat user-approved project installation as an allowed `package.json` / lockfile mutation, not as an implicit capability scaffold mutation.
- For user-approved `miniprogram-ci` project installation, choose the package manager from `package.json#packageManager` first, then lockfiles, then default to npm.
- Map `pnpm` to `pnpm add -D miniprogram-ci`, `yarn` to `yarn add -D miniprogram-ci`, and npm to `npm install -D miniprogram-ci`.
- If no `package.json` exists, do not create a new Node package during Mini Program init; continue init and guide the user to initialize a package before installing `miniprogram-ci`.
- If user-approved `miniprogram-ci` project installation fails, continue init and mark the setup action as failed in the init summary.
- Include the failed install command, a stderr summary, and the suggested manual install command in the init summary.
- Record setup action status in `.archloop/capability.json` without storing full stderr output.
- Use `miniprogram_ci_install_status: "failed"` in init summary or setup metadata when the user-approved install action fails.
- If the user declines installation, continue init and record next-step guidance explaining how to install or configure `miniprogram-ci` later.
- Make init summary distinguish project-local `miniprogram-ci` availability from host PATH availability, and recommend project-local installation when only a global CLI is found.
- Guide users through optional `miniprogram-ci` platform validation setup, including AppID, code upload private key, private key storage, and IP allowlist implications.
- Present `miniprogram-ci` platform validation as recommended for Mini Program projects, even though it remains optional for the core local verification loop.
- Treat detected `miniprogram-ci` preview/upload/packNpm configuration as enabled platform automation for the Mini Program core pack.
- Do not require a separate environment flag to enable `miniprogram-ci` platform validation once configuration is detected.
- Let `.archloop/wx-check-native.mjs` detect `miniprogram-ci` configuration from AppID plus an upload private key path.
- Resolve Mini Program AppID from `WX_APPID` first, then `project.config.json.appid`.
- Treat missing AppID as unconfigured platform validation while continuing local structure checks.
- Treat placeholder AppID values such as `touristappid` or `wx0000000000000000` as missing AppID for platform validation.
- When AppID is missing or placeholder, write a visible non-failing warning diagnostic `appid_missing` to `debug/wx-check.log`.
- If an upload key is present but AppID is missing or placeholder, keep `platform_validation_status: "not_configured"` and write a warning message explaining that platform validation was not enabled because AppID is missing.
- Prefer explicit `WX_UPLOAD_KEY_PATH` over any repository-local key path.
- When `WX_UPLOAD_KEY_PATH` is unset, resolve the repository-local upload key path from the effective AppID as `.archloop/auth/wx-upload/private.{effectiveAppid}.key`.
- When `WX_APPID` and `project.config.json.appid` differ, treat `WX_APPID` as the effective AppID for both `ci.Project` and repository-local upload key lookup.
- If repository-local `private.*.key` files exist for AppIDs other than the effective AppID, do not use them and write a non-failing warning diagnostic `upload_key_appid_mismatch`.
- When `WX_UPLOAD_KEY_PATH` is set, do not infer AppID from the key filename; use the effective AppID for `ci.Project`.
- If an explicit upload key path exists but `miniprogram-ci` preview fails because of AppID/key mismatch, report it as `platform_validation_status: "configured_invalid"`.
- Allow `.archloop/auth/wx-upload/private.{appid}.key` as a protected local credential drop zone for users who want an inspectable project-local path.
- Generate `.archloop/auth/wx-upload/.gitignore` that ignores `private.*.key`.
- Do not generate, copy, upload, commit, or otherwise manage WeChat code upload private keys.
- Do not write private key contents or sensitive private key metadata into `.archloop/capability.json`.
- Make init summary and generated context recommend `WX_UPLOAD_KEY_PATH` pointing outside the repository as the safest default.
- Make `preview` the default `miniprogram-ci` platform validation action when configuration is detected.
- Invoke configured Mini Program platform validation through the `miniprogram-ci` Node API rather than through the CLI in the first version.
- Create `ci.Project` with `appid`, `type: "miniProgram"`, `projectPath` set to the directory containing `project.config.json`, and `privateKeyPath`.
- Invoke `ci.preview` with `qrcodeFormat: "image"` and `qrcodeOutputDest: "debug/wx-preview.jpg"`.
- Run `packNpm` before `preview` only when the native project shape indicates Mini Program npm build is needed.
- Invoke `ci.packNpm(project, ...)` through the Node API only when the project appears to require Mini Program npm build.
- Treat `WX_PACK_NPM=1` as an explicit request to run `ci.packNpm(project, ...)` before `ci.preview`.
- Treat `WX_PACK_NPM=0` as an explicit request to skip `ci.packNpm(project, ...)`.
- When `WX_PACK_NPM` is unset, run `ci.packNpm(project, ...)` if `package.json` exists under `miniprogramRoot`.
- When `WX_PACK_NPM` is unset, run `ci.packNpm(project, ...)` if the repository root has `package.json`, `miniprogramRoot/miniprogram_npm` is absent, and app/page/component `usingComponents` contains a bare package-style component reference rather than a relative or absolute local path.
- When `WX_PACK_NPM` is unset and no Mini Program npm build signal is present, skip `ci.packNpm(project, ...)`.
- Treat `ci.packNpm(project, ...)` failure as a verification failure with diagnostic `pack_npm_failed`.
- Write native fallback and unsupported-variant diagnostics to `debug/wx-check.log` with enough structure for the agent to classify setup, project-shape, platform-validation, and code failures.
- Treat `debug/wx-check.log` as a verification diagnostic log, not as the archLoop run log.
- Format `debug/wx-check.log` as JSON Lines in the first Mini Program capability implementation.
- Require each `debug/wx-check.log` JSONL event to include `type`, `severity`, and `message`.
- Allow each JSONL event to include additional structured fields such as `diagnostic`, `file`, `appid`, `miniprogramRoot`, `platform_validation_status`, and `command`.
- Require platform-validation JSONL events to include `platform_validation_status`.
- Require project-shape JSONL events to include a stable `diagnostic` code when reporting an actionable verifier failure.
- Keep `message` human-readable so users can inspect the log without a parser.
- Write a stable `platform_validation_status` field to `debug/wx-check.log` when Mini Program platform validation is evaluated.
- Use `platform_validation_status: "not_configured"` when AppID or upload-key configuration is absent; this status does not fail verification.
- Use `platform_validation_status: "configured_missing_tool"` when AppID and upload-key configuration are present but project-local `miniprogram-ci` Node API detection fails; this status fails verification.
- Use `platform_validation_status: "configured_invalid"` when AppID, upload-key configuration, and `miniprogram-ci` are present but credential validation, IP allowlist validation, `packNpm`, or `preview` fails; this status fails verification.
- Use `platform_validation_status: "passed"` only when configured `miniprogram-ci` platform validation succeeds.
- Save the successful `miniprogram-ci preview` QR code artifact to `debug/wx-preview.jpg`.
- Include `artifact: "debug/wx-preview.jpg"` on the successful platform-validation JSONL event.
- Treat preview success plus QR code artifact write failure as a verification failure with diagnostic `preview_artifact_write_failed`.
- Keep preview artifacts under `debug/` rather than `.archloop/`, because they are run outputs rather than config scaffolds.
- Do not modify the host repo root `.gitignore` in the first version.
- Generate Mini Program context and init summary guidance recommending users ignore `debug/wx-check.log`, `debug/wx-preview.jpg`, `debug/wx-check-*.log`, and `debug/wx-preview-*.jpg`.
- Have `.archloop/verify.sh` write a non-failing warning JSONL event with diagnostic `verification_artifacts_not_ignored` when Mini Program verification artifacts are not ignored by git.
- Skip verification artifact ignore checks when the host repo is not a git repository.
- Write a non-failing info JSONL event with diagnostic `git_not_available_for_artifact_ignore_check` when artifact ignore checks are skipped because git repository metadata is unavailable.
- Ensure unconfigured platform validation does not prevent the agent loop from running local checks and reading debug logs, while writing a non-failing `platform_validation_not_configured` diagnostic.
- Ensure present but invalid platform validation configuration fails loudly with diagnostics instead of silently falling back to local-only validation.
- Treat detected upload key plus missing or unusable project-local `miniprogram-ci` package, AppID mismatch, private key failure, IP allowlist rejection, or `preview` failure as verification failures.
- Generate Mini Program context that explains how users can wire `npm run wx:check`, `miniprogram-ci`, and debug logs into their project.
- Generate Mini Program context that explains the difference between local checks, credentialed platform validation, and simulator/runtime debugging.
- Generate `.archloop/context/miniprogram-setup.md` as a user-readable setup checklist for the Mini Program capability pack.
- Treat `.archloop/context/miniprogram-setup.md` as an init-time static snapshot rather than a runtime status file.
- Do not update `.archloop/context/miniprogram-setup.md` from `.archloop/verify.sh` or `.archloop/wx-check-native.mjs`.
- Include current init detection results in `.archloop/context/miniprogram-setup.md`, such as project-local `miniprogram-ci` availability, AppID source or missing state, upload key guidance, and verification artifact ignore guidance.
- Include next-step guidance in `.archloop/context/miniprogram-setup.md` for installing `miniprogram-ci`, setting `WX_APPID`, placing or specifying upload keys, and configuring WeChat public platform upload keys and IP allowlists.
- Include safety reminders in `.archloop/context/miniprogram-setup.md` that `private.*.key` must not be committed and that `WX_UPLOAD_KEY_PATH` pointing outside the repository is preferred.
- Reference `.archloop/context/miniprogram.md`, `.archloop/context/miniprogram-setup.md`, `.archloop/verify.sh`, and `debug/wx-check.log` from all assembled Mini Program capability prompts, including planner, implementer, reviewer, and merger prompts when those roles exist in the selected template.
- Ensure Mini Program planner prompts understand whether platform validation is configured before treating preview/upload validation as a completion condition.
- Ensure Mini Program reviewer and merger prompts distinguish local verification pass, platform validation pass, and platform validation not configured.
- Require Mini Program capability agents to include a final verification summary with `local`, `platform`, and `artifacts` fields.
- For final verification summaries, allow `local` values `passed` and `failed`.
- For final verification summaries, allow `platform` values `passed`, `not_configured`, and `failed`.
- For final verification summaries, include `debug/wx-check.log` and `debug/wx-preview.jpg` when those artifacts exist.
- Forbid final reports from claiming complete platform validation when `platform` is `not_configured`; they must say local verification passed and platform validation was not configured.
- Treat `local: failed` or `platform: failed` as not complete for Mini Program capability workflows.
- Treat `local: passed` plus `platform: passed` as the only state that may claim platform validation passed.
- Expand the Mini Program preset skill with CLI validation, routing, page/component JSON, private key, and runtime debugging guidance.
- Strengthen the Mini Program preset prompt so it follows the verification entrypoint and reports verification outcomes.
- Add or update a Mini Program loop template that uses the assembled Mini Program prompt template and the verification entrypoint.
- Allow the Mini Program core pack with sandboxed and no-sandbox init paths.
- Allow the Mini Program runtime-debug add-on only with the no-sandbox provider in the first version.
- Do not enable the Mini Program `runtime-debug` add-on by default, even with the no-sandbox provider.
- In Docker or other sandboxed init paths, hide MCP-oriented Mini Program add-ons or show them disabled with a reason explaining that they require host state.
- In no-sandbox init paths, show Mini Program `runtime-debug` as an optional add-on with unchecked default.
- Generate add-on context and prompt guidance only when the user explicitly selects the add-on.
- Reject unsupported add-on and sandbox provider combinations during init.
- Generate add-on context files only when the add-ons are selected.
- Do not change `.archloop/verify.sh` behavior when the Mini Program `runtime-debug` add-on is selected.
- Keep WeChat DevTools MCP guidance out of `.archloop/verify.sh`; runtime debugging remains prompt/context guidance rather than part of the default verification entrypoint.
- Make WaterTian `wechat-devtools-mcp` the documented default for the runtime-debug add-on.
- Mention FliPPeDround `wechat-devtools-mcp` only as a lightweight experimental fallback, not as the default.
- Generate `.archloop/context/miniprogram-runtime-debug.md` only when the Mini Program `runtime-debug` add-on is selected.
- Include WeChat Developer Tools prerequisites in `.archloop/context/miniprogram-runtime-debug.md`: installed DevTools, login state, service port or automation availability, and correct project path.
- Include common runtime-debug troubleshooting in `.archloop/context/miniprogram-runtime-debug.md`, including `wait IDE port timeout`, `CLI_TIMEOUT`, and automator port readiness.
- In `.archloop/context/miniprogram-runtime-debug.md`, instruct agents to use runtime-debug guidance only when runtime, simulator, debugger, screenshot, console, or page-state evidence is needed.
- In `.archloop/context/miniprogram-runtime-debug.md`, state that runtime-debug does not replace `.archloop/verify.sh` and is not a completion standard unless the user task explicitly requires runtime debugging evidence.
- Reference `.archloop/context/miniprogram-runtime-debug.md` from all assembled Mini Program capability prompts when the runtime-debug add-on is selected.
- Ensure runtime-debug prompt references frame the context as conditional guidance, not as an instruction to start WeChat Developer Tools for every task.
- Ensure planner prompts can decide when runtime evidence is needed.
- Ensure reviewer and merger prompts can report whether runtime evidence was used and avoid requiring it when the task does not call for it.
- Generate runtime-debug context that explains WeChat Developer Tools setup prerequisites: service port, login state, CLI path, project path, normal CLI open flow, and automator readiness.
- Generate runtime-debug context that includes common troubleshooting for `wait IDE port timeout`, `CLI_TIMEOUT`, automator port readiness, and MCP server process behavior.
- Keep `wechat-devtools-mcp` guidance out of `.archloop/verify.sh`; the verification entrypoint should not require a GUI or simulator automation by default.
- Do not automatically install `wechat-devtools-mcp`, start WeChat Developer Tools, or assume MCP servers are available.
- Update init summary and next steps to explain selected capability pack, add-ons, verification entrypoint, and follow-up setup.
- Update user documentation to explain the distinction between project profiles, templates, preset agents, skills, capability packs, and capability add-ons.
- Update the roadmap to track capability packs as their own phase.
- Record the architectural decision in an ADR, including explicit selection, init-time prompt assembly, no-sandbox-only MCP add-ons, and no application-file modification in the first version.

## Testing Decisions

- Tests should focus on scaffolded external behavior: given init options, archLoop writes the expected config directory files, manifest, prompts, context, and verification entrypoint.
- Add registry validation tests for capability pack ids, add-on ids, default references, required files, and compatibility declarations.
- Add tests that `generic` preserves the existing init behavior when no specialized capability is selected.
- Add tests that `miniprogram` applies default template, project profile, and preset agent selections when no explicit override is provided.
- Add tests that explicit template, project profile, and preset-agent selections override Mini Program defaults.
- Add tests that Mini Program capability verification contract is present across supported templates such as `parallel-planner`, `parallel-planner-with-review`, and `sequential-reviewer`.
- Add tests that Mini Program capability defaults to `parallel-planner-with-review`.
- Add tests that Mini Program capability supports `parallel-planner`, `parallel-planner-with-review`, `sequential-reviewer`, and `simple-loop`.
- Add tests that explicit Mini Program plus `blank` template selection is allowed but produces a warning about manually wiring the verification entrypoint.
- Add tests that unknown or incompatible non-blank templates fail Mini Program init rather than silently falling back to the default template.
- Add tests that incompatible Mini Program template errors name the selected template and list supported templates.
- Add tests that reviewer or merger roles can add checks but do not change the Mini Program verification contract or final verification summary contract.
- Add tests that `.archloop/capability.json` is written with the selected capability, add-ons, verification entrypoint, and log paths.
- Add tests that `.archloop/capability.json` records Mini Program `variant`, `verification`, and `setupActions`.
- Add tests that setup actions use stable `id`, `status`, `packageManager`, `command`, and `summary` fields.
- Add tests that setup action status is limited to `skipped`, `succeeded`, and `failed` in the first version.
- Add tests that setup actions record `reason` and distinguish `already_available`, `user_declined`, `no_package_json`, `installed`, `install_command_failed`, and `detected_but_unusable`.
- Add tests that generated verification workflows do not require `.archloop/capability.json` to run.
- Add tests that `.archloop/verify.sh` is written for the Mini Program pack and is executable when the platform supports mode assertions.
- Add tests that `.archloop/wx-check-native.mjs` is written for the native Mini Program variant.
- Add tests that `.archloop/verify.sh` calls `npm run wx:check` when that script is present.
- Add tests that `.archloop/verify.sh` falls back to `.archloop/wx-check-native.mjs` when `wx:check` is absent.
- Add tests that `.archloop/verify.sh` preserves the `npm run wx:check` exit code when wrapping project-owned validation.
- Add tests that `.archloop/verify.sh` writes a JSONL `project_wx_check` event when project-owned `wx:check` does not write `debug/wx-check.log`.
- Add tests that `.archloop/verify.sh` appends a summary event without overwriting `debug/wx-check.log` when project-owned `wx:check` already writes it.
- Add tests that `.archloop/wx-check-native.mjs` passes for a minimal native Mini Program project.
- Add tests that `.archloop/wx-check-native.mjs` uses `WX_PROJECT_CONFIG` when it is set.
- Add tests that `.archloop/wx-check-native.mjs` checks only the repository root `project.config.json` when `WX_PROJECT_CONFIG` is absent.
- Add tests that `.archloop/wx-check-native.mjs` reports `project_config_missing` when no usable `project.config.json` is found.
- Add tests that `.archloop/wx-check-native.mjs` reports `project_config_ambiguous` rather than guessing when project config selection is ambiguous.
- Add tests that `.archloop/wx-check-native.mjs` reports `project_config_outside_repo` when `WX_PROJECT_CONFIG` points outside the repository.
- Add tests that `.archloop/wx-check-native.mjs` reports `miniprogram_root_missing` when `miniprogramRoot` is absent or resolves to a missing directory.
- Add tests that `.archloop/wx-check-native.mjs` reports `miniprogram_root_outside_repo` when `miniprogramRoot` escapes the repository.
- Add tests that `.archloop/wx-check-native.mjs` exits non-zero and writes an actionable `unsupported_miniprogram_variant` diagnostic for unsupported variants such as Taro or uni-app.
- Add tests that Taro dependency signals trigger `unsupported_miniprogram_variant` in the native fallback verifier.
- Add tests that uni-app dependency and `manifest.json` plus `pages.json` signals trigger `unsupported_miniprogram_variant` in the native fallback verifier.
- Add tests that mpvue dependency signals trigger `unsupported_miniprogram_variant` in the native fallback verifier.
- Add tests that obvious cross-framework build output roots trigger `unsupported_miniprogram_variant` in the native fallback verifier.
- Add tests that project-owned `npm run wx:check` bypasses native fallback unsupported-variant detection because the project supplies its own validation contract.
- Add tests that `.archloop/wx-check-native.mjs` reports native project-shape failures such as missing page JSON, bad `tabBar` paths, or invalid `miniprogramRoot`.
- Add tests that invalid `project.config.json`, `app.json`, or page JSON files are reported as verifier failures.
- Add tests that empty or missing `app.json.pages` is reported as a verifier failure.
- Add tests that page paths escaping `miniprogramRoot` are reported as verifier failures.
- Add tests that missing required page `.json` or `.wxml` files are reported as verifier failures while missing `.js` or `.wxss` files do not fail in the first version.
- Add tests that unresolved local `usingComponents` entries are reported as verifier failures.
- Add tests that `tabBar.list[].pagePath` values not present in `app.json.pages` are reported as verifier failures.
- Add tests that missing local `tabBar` `iconPath` or `selectedIconPath` assets are reported as verifier failures.
- Add tests that `debug/wx-check.log` is JSON Lines and every event has `type`, `severity`, and `message`.
- Add tests that project-shape failure events include stable `diagnostic` codes.
- Add tests that platform-validation events include `platform_validation_status`.
- Add tests that the Mini Program assembled prompt includes required skill content or required skill sections.
- Add tests that selected add-on guidance appears in assembled prompts and unselected add-on guidance does not.
- Add tests that the runtime-debug add-on is accepted with no-sandbox.
- Add tests that the runtime-debug add-on is rejected with Docker init in the first version.
- Add tests that the Mini Program `runtime-debug` add-on is not enabled by default.
- Add tests that sandboxed init paths hide or disable MCP-oriented Mini Program add-ons with a host-state reason.
- Add tests that no-sandbox init paths present Mini Program `runtime-debug` as an unchecked option.
- Add tests that add-on context and prompt guidance are generated only when the user explicitly selects the add-on.
- Add tests that selecting the Mini Program `runtime-debug` add-on does not change `.archloop/verify.sh`.
- Add tests that WeChat DevTools MCP guidance remains out of `.archloop/verify.sh`.
- Add tests that runtime-debug context identifies WaterTian `wechat-devtools-mcp` as the default and does not present FliPPeDround as the default.
- Add tests that `.archloop/context/miniprogram-runtime-debug.md` is generated only when the runtime-debug add-on is selected.
- Add tests that runtime-debug context states it does not replace `.archloop/verify.sh` and is not a completion standard unless the task explicitly requires runtime debugging evidence.
- Add tests that all assembled Mini Program capability prompts reference `.archloop/context/miniprogram-runtime-debug.md` when the runtime-debug add-on is selected.
- Add tests that runtime-debug prompt references frame runtime debugging as conditional guidance rather than mandatory DevTools startup.
- Add tests that runtime-debug context includes WeChat Developer Tools service port, CLI path, project path, login state, and automator readiness prerequisites.
- Add tests that `.archloop/verify.sh` guidance does not require WeChat Developer Tools MCP or GUI automation by default.
- Add tests that Mini Program core pack does not require add-ons.
- Add tests that init does not silently modify host repo application files such as `package.json`.
- Add tests that Mini Program init detects missing `miniprogram-ci` and offers an explicit install choice.
- Add tests that Mini Program init detects project-local `miniprogram-ci` through Node package resolution from the host repo.
- Add tests that Mini Program init requires readable package version and expected Node API members such as `Project`, `preview`, and `packNpm`.
- Add tests that Mini Program init does not require `miniprogram-ci --version`.
- Add tests that Mini Program init treats global PATH-only `miniprogram-ci` as non-preferred and recommends project-local installation.
- Add tests that Mini Program init treats detected but unusable project-local `miniprogram-ci` as installable and records reason `detected_but_unusable`.
- Add tests that Mini Program init continues without installing `miniprogram-ci` when the user declines and writes next-step guidance.
- Add tests that Mini Program init installs `miniprogram-ci` into the project only after the user explicitly chooses installation.
- Add tests that user-approved project installation is the only Mini Program init path allowed to mutate `package.json` or the package manager lockfile.
- Add tests that user-approved `miniprogram-ci` project installation chooses the package manager from `package.json#packageManager` before lockfiles.
- Add tests that user-approved `miniprogram-ci` project installation chooses pnpm, yarn, or npm commands from lockfiles when `packageManager` is absent.
- Add tests that user-approved `miniprogram-ci` project installation defaults to npm when no package manager signal is present.
- Add tests that Mini Program init does not create `package.json` when the user chooses installation but no `package.json` exists; it should continue init with guidance instead.
- Add tests that Mini Program init continues when user-approved `miniprogram-ci` project installation fails.
- Add tests that failed user-approved `miniprogram-ci` installation is reported in init summary with `miniprogram_ci_install_status: "failed"`, failed command, stderr summary, and manual install guidance.
- Add tests that `.archloop/capability.json` records setup action status without storing full stderr output.
- Add tests that Mini Program init summary distinguishes project-local `miniprogram-ci` availability from host PATH availability.
- Add tests that Mini Program context files and DevTools error template are copied into the config directory.
- Add tests that `.archloop/context/miniprogram-setup.md` is generated for the Mini Program capability pack.
- Add tests that `.archloop/context/miniprogram-setup.md` includes init detection results, next-step setup guidance, and upload-key safety reminders.
- Add tests that `.archloop/verify.sh` and `.archloop/wx-check-native.mjs` do not update `.archloop/context/miniprogram-setup.md`.
- Add tests that all assembled Mini Program capability prompts reference `.archloop/context/miniprogram.md`, `.archloop/context/miniprogram-setup.md`, `.archloop/verify.sh`, and `debug/wx-check.log`.
- Add tests that assembled Mini Program planner prompts distinguish configured platform validation from local-only verification.
- Add tests that assembled Mini Program reviewer and merger prompts distinguish local verification pass, platform validation pass, and platform validation not configured.
- Add tests that assembled Mini Program prompts require final verification summaries with `local`, `platform`, and `artifacts`.
- Add tests that assembled Mini Program prompts forbid claiming complete platform validation when `platform` is `not_configured`.
- Add tests that assembled Mini Program prompts treat `local: failed` or `platform: failed` as incomplete.
- Add tests that Mini Program verification guidance distinguishes unconfigured platform validation from invalid platform validation.
- Add tests that unconfigured platform validation still permits the local-check loop.
- Add tests that unconfigured platform validation writes a non-failing `platform_validation_not_configured` diagnostic.
- Add tests that `debug/wx-check.log` reports `platform_validation_status: "not_configured"` without failing when AppID or upload-key configuration is absent.
- Add tests that `debug/wx-check.log` reports `platform_validation_status: "configured_missing_tool"` and exits non-zero when configuration is present but `miniprogram-ci` is unavailable.
- Add tests that `debug/wx-check.log` reports `platform_validation_status: "configured_invalid"` and exits non-zero when configured `miniprogram-ci` validation fails.
- Add tests that `debug/wx-check.log` reports `platform_validation_status: "passed"` when configured `miniprogram-ci` validation succeeds.
- Add tests that configured platform validation uses the `miniprogram-ci` Node API to create `ci.Project` and call `ci.preview`.
- Add tests that configured platform validation passes `projectPath`, `appid`, `privateKeyPath`, `type: "miniProgram"`, `qrcodeFormat: "image"`, and `qrcodeOutputDest: "debug/wx-preview.jpg"`.
- Add tests that `ci.packNpm` is called before `ci.preview` only when the project appears to require Mini Program npm build.
- Add tests that `WX_PACK_NPM=1` forces `ci.packNpm` before `ci.preview`.
- Add tests that `WX_PACK_NPM=0` skips `ci.packNpm`.
- Add tests that `miniprogramRoot/package.json` triggers `ci.packNpm` when `WX_PACK_NPM` is unset.
- Add tests that bare package-style `usingComponents` entries trigger `ci.packNpm` when root `package.json` exists and `miniprogramRoot/miniprogram_npm` is absent.
- Add tests that relative or absolute local `usingComponents` entries do not trigger `ci.packNpm`.
- Add tests that `ci.packNpm` failure exits non-zero with diagnostic `pack_npm_failed`.
- Add tests that successful configured `miniprogram-ci preview` writes `debug/wx-preview.jpg` and records it as an `artifact` in `debug/wx-check.log`.
- Add tests that preview success plus QR code artifact write failure exits non-zero with diagnostic `preview_artifact_write_failed`.
- Add tests that init does not modify the host repo root `.gitignore`.
- Add tests that Mini Program context and init summary recommend ignoring Mini Program verification artifacts.
- Add tests that `.archloop/verify.sh` writes a non-failing `verification_artifacts_not_ignored` warning when Mini Program verification artifacts are not ignored by git.
- Add tests that `.archloop/verify.sh` skips artifact ignore checks outside git repositories and writes a non-failing `git_not_available_for_artifact_ignore_check` info event.
- Add tests that detected `miniprogram-ci` configuration automatically triggers platform validation without a separate enable flag.
- Add tests that `WX_UPLOAD_KEY_PATH` takes precedence over `.archloop/auth/wx-upload/private.{appid}.key`.
- Add tests that `WX_APPID` takes precedence over `project.config.json.appid`.
- Add tests that missing AppID writes visible non-failing warning diagnostic `appid_missing` and keeps platform validation `not_configured`.
- Add tests that placeholder AppID values such as `touristappid` and `wx0000000000000000` are treated as missing.
- Add tests that upload key present plus missing AppID does not fail local verification but writes a warning explaining platform validation was not enabled.
- Add tests that repository-local upload key lookup uses `.archloop/auth/wx-upload/private.{effectiveAppid}.key`.
- Add tests that `WX_APPID` controls effective AppID and repository-local upload key lookup when it differs from `project.config.json.appid`.
- Add tests that extra repository-local `private.*.key` files for other AppIDs are ignored and produce warning diagnostic `upload_key_appid_mismatch`.
- Add tests that `WX_UPLOAD_KEY_PATH` does not infer AppID from the key filename and still uses effective AppID for `ci.Project`.
- Add tests that `.archloop/auth/wx-upload/.gitignore` ignores `private.*.key`.
- Add tests that `.archloop/capability.json` does not contain private key contents or sensitive private key metadata.
- Add tests that detected `miniprogram-ci` configuration invokes `preview` by default.
- Add tests that detected upload key plus missing `miniprogram-ci` package is represented as a verification failure.
- Add tests that invalid platform validation configuration is represented as a verification failure with a useful diagnostic.
- Reuse existing `InitService` scaffold test patterns for filesystem output, manifest contents, and generated prompt files.
- Reuse existing preset agent registry validation tests as prior art for capability pack registry validation.
- Run `npm run typecheck` as the required type verification.
- Run focused init, preset registry, and capability registry tests as the primary implementation verification path.
- Run broader test suites before merge when feasible, while accounting for existing provider-specific environment constraints.

## Out of Scope

- Implementing web or game capability packs beyond reserving the abstraction for them.
- Supporting Mini Program variants beyond native WeChat Mini Programs, such as Taro, uni-app, mpvue, or other cross-framework builds.
- Automatically detecting repository type and silently selecting a capability pack.
- Adding a public runtime `agentProfile` API to `run()`, `interactive()`, `createSandbox()`, or worktree APIs.
- Silently modifying host repo application files such as `package.json`, `app.json`, `project.config.json`, or Mini Program scripts during init.
- Authoring project-specific Mini Program automation scripts in the first version.
- Generating, storing, uploading, or managing WeChat code upload private keys.
- Automatically configuring WeChat IP allowlists or recommending that users disable them by default.
- Installing or configuring `wechat-devtools-mcp`.
- Launching WeChat Developer Tools or managing its service port.
- Making FliPPeDround `wechat-devtools-mcp` the default runtime-debug workflow.
- Authenticating to CloudBase or binding a CloudBase environment.
- Implementing a CloudBase capability add-on in the first Mini Program capability version.
- Making MCP add-ons work inside Docker, Podman, or isolated sandbox providers in the first version.
- Building a remote marketplace or third-party capability pack install flow.
- Implementing capability pack upgrade or migration commands.
- Adding GUI support for capability packs.

## Further Notes

The Mini Program core loop follows the research in `docs/research/wx-miniprogram-loop.md`: first make the local and CLI validation loop reliable, then use runtime debugging as an optional enhancement.

The Mini Program tooling choices follow `docs/research/miniprogram-ci-and-wechat-devtools-mcp.md` and `docs/research/wechat-miniprogram-tooling-handoff.md`: use `miniprogram-ci` for preview/upload/packNpm and CI-style platform automation; use WaterTian `wechat-devtools-mcp` for local WeChat Developer Tools runtime debugging. CloudBase MCP remains a future capability add-on candidate rather than part of the first Mini Program capability version.

The design follows ADR-0016. Capability packs are a new composition layer rather than a replacement for project profiles, templates, preset agents, or skills.

The first implementation should prefer boring, inspectable scaffold files over hidden runtime behavior. That keeps archLoop explainable while giving future web and game capability packs a clear path.
