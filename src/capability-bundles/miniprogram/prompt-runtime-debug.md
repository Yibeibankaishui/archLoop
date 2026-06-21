# Mini Program runtime debugging (conditional)

The **runtime-debug** add-on is enabled for this repository. Read `.archloop/context/miniprogram-runtime-debug.md` when — and only when — the task needs simulator, debugger, screenshot, console, or page-state evidence.

Rules:

- Do **not** start WeChat Developer Tools or MCP servers for every task.
- Prefer `.archloop/verify.sh` and the verification summary contract unless runtime debugging evidence is explicitly required.
- Runtime debugging does not replace `.archloop/verify.sh` and is not a completion standard by itself.
- Default MCP guidance targets WaterTian `wechat-devtools-mcp`; treat FliPPeDround `wechat-devtools-mcp` as an experimental fallback only.
- Planner roles may decide whether runtime evidence is needed; implementer/reviewer/merger roles should report whether runtime evidence was used without requiring it when the task does not call for it.
