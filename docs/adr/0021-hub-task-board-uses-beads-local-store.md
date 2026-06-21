# Hub task board uses Beads as the local task store

**archLoop Hub** uses Beads as the **local task store** for task planning, triage, dependencies, and task board state. Remote systems such as GitHub Issues are modeled as **remote task sources** that synchronize with the local store through **task sync**, so Hub flows plan from local Beads state rather than treating each remote issue tracker as the direct task board.

## Considered Options

1. **Use GitHub Issues directly as the Hub task board** -- rejected because Hub needs local-first task state, dependency-aware ready queues, and offline-friendly agent planning.
2. **Build a separate Hub task database** -- rejected because it would duplicate issue tracking and dependency management already provided by Beads.
3. **Use Beads locally and sync remote sources into it** -- chosen because it gives Hub a local task store while still supporting GitHub Issues pull/push workflows.
