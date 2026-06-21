# Mini Program verification (capability pack)

After changing WeChat Mini Program code, run the verification entrypoint before reporting task completion:

- **Entrypoint:** `.archloop/verify.sh`
- **Diagnostic log:** `debug/wx-check.log`

Read capability context when relevant:

- `.archloop/context/miniprogram.md`
- `.archloop/context/miniprogram-setup.md`

## Final verification summary

End capability-pack work with a final verification summary using `local`, `platform`, and `artifacts`:

- `local`: `passed` or `failed`
- `platform`: `passed`, `not_configured`, or `failed`
- `artifacts`: list paths such as `debug/wx-check.log` and `debug/wx-preview.jpg` when they exist

Rules:

- Do not claim platform validation passed when `platform` is `not_configured`.
- Treat `local: failed` or `platform: failed` as incomplete.
- Only `local: passed` with `platform: passed` may claim full platform validation passed.
- Reviewer and merger roles may add code-quality checks but must not change this verification contract or summary shape.
