# Mini Program runtime debugging (optional add-on)

This context applies only when the **runtime-debug** capability add-on was selected during init. It supplements — but does not replace — the core verification loop in `.archloop/verify.sh`.

## When to use runtime debugging

Use WeChat Developer Tools / MCP guidance **only when the task needs runtime evidence**, such as:

- simulator behavior, navigation, or page rendering
- debugger breakpoints or step-through
- console logs from the running mini program
- screenshots or page-state inspection
- mocked `wx.*` interactions in the IDE

Do **not** start WeChat Developer Tools for every task. Prefer `.archloop/verify.sh` and `debug/wx-check.log` for the default completion loop unless the user or task explicitly requires runtime debugging evidence.

Runtime debugging is **not a completion standard** unless the task explicitly asks for simulator, debugger, screenshot, console, or page-state proof. It does not replace `.archloop/verify.sh` or the final verification summary contract.

## Recommended MCP toolchain

**Default:** [WaterTian `wechat-devtools-mcp`](https://github.com/WaterTian/wechat-devtools-mcp) — preferred for Mini Program runtime debugging and its companion skill/SOP model.

**Experimental fallback only:** [FliPPeDround `wechat-devtools-mcp`](https://github.com/FliPPeDround/wechat-devtools-mcp) — lightweight alternative; do not treat it as the default workflow.

archLoop init does **not** install either package, generate MCP server configuration, or start DevTools. Configure MCP and DevTools on the host when runtime evidence is needed.

## WeChat Developer Tools prerequisites

Before relying on runtime-debug MCP tools, confirm on the host:

1. **WeChat Developer Tools installed** — stable build with CLI available.
2. **Login state** — the IDE is signed in to the WeChat developer account that owns the project AppID.
3. **Service / automator port** — DevTools settings enable the service port (or automation endpoint) MCP servers expect.
4. **CLI path** — `cli` / `cli.bat` resolves from PATH or a known install location.
5. **Project path** — open the repository root (or correct `miniprogramRoot`) so compile and navigation target the right tree.
6. **Automator readiness** — the IDE has finished opening the project and the automator bridge is accepting commands.

Use the normal DevTools CLI **open / auto** flow when MCP cannot attach because the IDE is not running or the project is not loaded.

## Troubleshooting

| Symptom                      | Likely cause                                                       | What to try                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `wait IDE port timeout`      | DevTools not running, service port disabled, or project not opened | Start DevTools manually; enable service port; run CLI open/auto for the project path; retry MCP after the IDE is ready |
| `CLI_TIMEOUT`                | CLI command hung or DevTools busy compiling                        | Wait for compile to finish; restart DevTools; retry with a longer timeout; confirm CLI path and project path           |
| Automator port not ready     | IDE still launching or wrong project loaded                        | Open the correct project; wait for simulator panel; confirm login and service port                                     |
| MCP server exits immediately | Missing `uv`/`uvx`, wrong package, or DevTools unreachable         | Install WaterTian toolchain per its README; verify DevTools prerequisites above before blaming application code        |

## Layering reminder

| Layer               | Tooling                                            | Role                                                    |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Local checks        | `.archloop/verify.sh`, `wx:check`, native verifier | Default completion loop                                 |
| Platform validation | `miniprogram-ci` preview/upload                    | Optional CI-style platform truth                        |
| Runtime debugging   | WaterTian `wechat-devtools-mcp` + DevTools         | Optional simulator/runtime truth when explicitly needed |

Keep runtime debugging separate from `miniprogram-ci` preview/upload automation — use the right layer for each question.
