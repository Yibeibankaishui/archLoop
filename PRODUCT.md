# Product

## Register

product

## Users

archLoop serves software engineers and maintainers who want AI agents to move real repository work from task intake to verified code changes. In Hub, users are operating a local control plane while they monitor task state, review proposal output, inspect runs, recover failures, and decide when local task-store or remote-sync actions should proceed.

## Product Purpose

archLoop is an automated software engineering execution system. It turns tasks, issues, and PRDs into isolated, auditable agent loops with worktrees, branches, verification, review, repair, and merge gates. Hub exists to make that loop visible and controllable without weakening the CLI-first recovery paths or preview-confirm safety model.

## Brand Personality

Reliable, technical, accountable. archLoop should feel like a dependable automated engineer: calm under failure, explicit about state, and serious about shipping verified code rather than generating one-off snippets.

## Anti-references

archLoop should not look or behave like a cute assistant, a generic chat UI, a one-shot code generator, an IDE plugin, an ordinary issue tracker, or a decorative SaaS dashboard. Hub UI should avoid marketing-page theatrics, oversized hero content, vague disabled actions, hidden destructive writes, and visual systems that make workflow state feel less important than ornament.

## Design Principles

- State before decoration: surface task, run, sync, claim, and gate state as the primary visual hierarchy.
- Preview before mutation: actions that write locally or sync remotely must make the preview-confirm boundary legible.
- Dense but recoverable: preserve desktop control-plane density while keeping failures, fallbacks, and next steps easy to scan.
- CLI honesty: when v0 cannot perform an action in Hub, name the CLI recovery path plainly and avoid implying a disabled control is secretly available.
- Agent work is auditable: logs, events, artifacts, run directories, and proposal rationale should be first-class inspection material.

## Accessibility & Inclusion

Default to WCAG AA contrast, keyboard-accessible controls, visible focus states, readable monospace metadata, reduced-motion support, and layouts that remain usable when panes collapse. Status cannot rely on color alone; labels and disabled reasons must carry the meaning.
