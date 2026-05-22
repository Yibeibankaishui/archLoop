# WeChat DevTools Debug and Preview

This document supplements `SKILL.md` with practical guidance for debugging, previewing, uploading, and validating WeChat Mini Program projects.

## How to use this reference (for a coding agent)

1. Prefer WeChat Developer Tools when available
   - Use it for simulator debugging, Console inspection, Network inspection, preview QR generation, and real-device validation.
   - Use `wechat-devtools-mcp` when the environment supports Developer Tools automation.

2. Use `miniprogram-ci` as the no-DevTools fallback
   - Use it for npm build flows, CLI preview, and CLI upload.
   - Do not treat `miniprogram-ci` as a runtime debugger. It validates compile, preview, and release flows, not page-state inspection.

3. Confirm project readiness before preview or upload
   - Check `project.config.json`.
   - Confirm `appid` is present for real preview and upload workflows.
   - Confirm `miniprogramRoot` points to the actual mini program source directory.
   - Ensure page JSON files, asset paths, and route declarations are complete.

## 1. Preferred path: WeChat Developer Tools

Use WeChat Developer Tools first when you need:

- simulator rendering checks
- runtime Console errors
- failed requests in Network panels
- page navigation and interaction validation
- preview QR generation and real-device verification

Recommended runtime debugging loop:

1. Open the project in WeChat Developer Tools.
2. Compile and enter the target page.
3. Reproduce the issue.
4. Capture Console errors, compile output, failed requests, page path, base library version, and DevTools version.
5. Fix code and validate again.

## 2. Fallback path: `miniprogram-ci`

Use `miniprogram-ci` when:

- WeChat Developer Tools is unavailable in the current environment
- the task is CI-oriented preview or upload automation
- you need repeatable CLI validation after code changes

Typical CLI flow:

1. Build mini program npm dependencies if the project requires it.
2. Run lint and type checks when present.
3. Run a preview or compile script that calls `miniprogram-ci`.
4. Persist output to a log file such as `debug/wx-check.log`.
5. Fix errors based on the log and rerun the check.

## 3. Required checks before preview, compile, or upload

Before suggesting DevTools or `miniprogram-ci` workflows, confirm:

- `project.config.json` exists
- `compileType` is correct for a mini program project
- `miniprogramRoot` matches the source layout
- `appid` is configured when real preview or upload is required
- referenced assets exist locally
- route declarations match the actual page files

If `miniprogram-ci` preview or upload is required, also confirm:

- a valid code upload private key file is available
- the private key path passed to the script is correct
- the WeChat platform upload IP allowlist is configured when required

## 4. Suggested automation shape

Recommended scripts:

- `wx:build-npm` for mini program npm build steps
- `wx:preview` for CLI preview
- `wx:upload` for CLI upload
- `wx:check` for the main validation loop

Recommended `wx:check` responsibilities:

1. Run static checks such as lint and typecheck when present.
2. Run the mini program npm build step when present.
3. Run the preview or compile validation step.
4. Write a full log to a stable debug file.

## 5. Common failure cases

Watch for these issues first:

- missing or invalid `appid`
- incorrect `miniprogramRoot`
- missing page `.json` files
- bad local asset paths
- `tabBar` paths pointing at non-existent pages
- missing preview or upload private key
- platform IP allowlist rejecting CI upload requests
- treating runtime bugs as if they were compile-only failures

## 6. Tool boundary summary

- WeChat Developer Tools: runtime debugging, simulator, preview, and device validation
- `wechat-devtools-mcp`: automation bridge for Developer Tools workflows
- `miniprogram-ci`: CLI preview, upload, and build automation

Use WeChat Developer Tools for runtime truth, and use `miniprogram-ci` for repeatable CLI validation and release automation.
