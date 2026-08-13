# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations. Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Claim a ticket**: `gh issue edit <number> --add-assignee @me` — the session's first write.
- **Close**: `gh issue close <number> --comment "..."`

## PR-first workflow

Any ticket that involves file edits is developed on a branch and merged via a GitHub PR — never push to main directly:

1. `git checkout -b feat/<topic>` off `main`.
2. Develop; verify locally with `npm run lint` (tsc --noEmit) and `npm test` (vitest) — CI runs the same on Node 24.
3. `git push -u origin feat/<topic>`, then `gh pr create` with a body containing `Closes #<n>` and a summary of what was delivered and verified.
4. Babysit CI: `gh pr checks <number> --watch --interval 10` until green; address failures in new commits on the branch and re-watch.
5. Merge with `gh pr merge --squash --delete-branch`. `Closes #n` in the PR body closes the ticket on merge.
6. Post a resolution comment (`gh issue comment <n>`) summarizing what was delivered and verified.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Build map (wayfinding)

The **map** is a single tracking issue labelled `wayfinder:map` — for this repo, the build map is issue #1. **Child tickets** reference the map with `Part of #1` at the top of their body.

- **Frontier query**: list the map's open children (`gh issue list --state open`), drop any with an assignee; first in map order wins.
- **Blocking**: per the build map's note, canonical blocking is GitHub's native issue dependencies (`blocked_by`) within this repo; cross-repo blockers are body lines. A ticket is unblocked when every blocker is closed.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`. When a ticket ships a decision, record it in `DECISIONS.md` (newest first).