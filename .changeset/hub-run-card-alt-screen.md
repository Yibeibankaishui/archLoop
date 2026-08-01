---
"@yibeibankaishui/archloop": patch
---

Rewrite the Hub run live view as an alt-screen dashboard (ADR-0033, supersedes ADR-0032). In a colour-capable TTY, `archloop run` now enters the alt-screen buffer, hides the cursor, and repaints a four-region dashboard on a 500 ms ticker: fixed header (project · flow · run id · outcome · elapsed), append-only done ledger, live active card, and fixed footer with logs path and hotkeys. On q / SIGINT / SIGTERM / natural completion the CLI leaves the alt-screen, restores the cursor, and dumps a plain-text summary (header + `N done · M failed` + on-screen ledger rows + logs path + recovery command on failure) to real terminal scrollback. Non-TTY, `--plain`, `--yes`, `NO_COLOR=1`, `TERM=dumb`, and the new `--stream` flag keep the append-only single-line-per-transition fallback path used by CI logs and piped consumers.
