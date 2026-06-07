# Mini Program capability context

You are working under the **miniprogram** capability pack (native variant).

## Verification loop

- After Mini Program code changes, run `.sandcastle/verify.sh` from the repository root.
- On failure, read `debug/wx-check.log` and fix using concrete diagnostics.
- Prefer `npm run wx:check` when the host project defines it; otherwise the scaffold runs `.sandcastle/wx-check-native.mjs`.
- Verification does not depend on the capability manifest.

## Tooling layers

1. **Local checks** — code quality and native project shape (no WeChat credentials).
2. **Platform validation** — optional `miniprogram-ci` preview when AppID and upload key are configured.
3. **Runtime debugging** — optional `runtime-debug` add-on (no-sandbox only); not required for task completion.

## Project files to inspect

- `project.config.json` (`compileType`, `miniprogramRoot`, `appid`)
- `app.json`, page `.json` / `.wxml`, component JSON
- `tabBar` paths and local icon assets

## Credentials and safety

- Never commit WeChat code upload private keys (`private.*.key`).
- Prefer `WX_UPLOAD_KEY_PATH` pointing **outside** the repository.
- Repository-local drop zone: `.sandcastle/auth/wx-upload/private.{appid}.key` (gitignored).

## Setup checklist

See `.sandcastle/context/miniprogram-setup.md` for the init-time snapshot of detected setup state and next steps.
