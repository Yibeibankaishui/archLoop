# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Which repository `gh` uses

With several remotes (for example `origin` pointing at upstream and `fork` at your GitHub fork), `gh issue`, `gh pr`, and similar commands use the **GitHub CLI default repository** for this directory, not necessarily the remote your branch tracks for `git push`.

To send all issue operations from this clone to **your fork**, set the default once (replace with your fork’s `owner/name`):

```bash
gh repo set-default YOUR_GITHUB_USER/sandcastle
```

Confirm with:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

To target a repository for a single command without changing the default, pass `-R owner/repo` (for example `gh issue create -R owner/repo --title "..."`).

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

If you have not set a default, `gh` infers a repository from this clone’s remotes; that choice may not match where you want issues to live, so prefer `gh repo set-default` when using a fork.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
