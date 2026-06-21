---
"@yibeibankaishui/archloop": patch
---

Bundle a pinned Beads runtime with archLoop installs.

- Add `@beads/bd@1.0.4` as a runtime dependency so Hub and Beads-backed commands
  can resolve `bd` without a separate system install.
- Prefer `ARCHLOOP_BD_PATH`, then the bundled binary, then `PATH` when
  resolving `bd`, and update no-sandbox init guidance to match.
- Pin Docker scaffolds to the `gastownhall/beads` v1.0.4 Linux AMD64 release
  tarball instead of the mutable install script.
