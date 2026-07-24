---
"@yibeibankaishui/archloop": patch
---

Improve `archloop tasks show` visual hierarchy: color the status value by board-bucket severity (via optional `valueSeverity` on `section` kv rows), emphasize the comments timeline (bold author, dim timestamp, plain body), and render leftover metadata as labeled kv rows instead of a raw JSON blob. Plain mode (`NO_COLOR` / non-TTY / `--plain`) stays ANSI-free with the same textual content.
