# AGENTS.md

shopify-operations-mcp: a safe-write MCP server for Shopify operations, built on safe-write-mcp-core — plan-before-execute writes, out-of-band localhost approval, and audit hooks. Work is tracked as tickets in GitHub Issues (see the [build map](https://github.com/jpka/shopify-operations-mcp/issues/1)).

## Working conventions

- Tickets live in GitHub Issues; claim one with `gh issue edit <n> --add-assignee @me` before starting.
- **PR-first:** any ticket that involves file edits is developed on a branch and merged via a GitHub PR — never push to main directly. Open the PR with `gh pr create`, then babysit it: watch CI (`gh pr checks <n> --watch --interval 10`), address failures in new commits on the branch, re-watch until green, then `gh pr merge --squash --delete-branch`.
- Put `Closes #n` in the PR body so the ticket closes on merge; then post a resolution comment summarizing what was delivered and verified.
- Triage labels: `needs-triage` (maintainer must evaluate), `needs-info` (waiting on reporter), `ready-for-agent` (fully specified, ready for an AFK agent), `ready-for-human` (requires human implementation), `wayfinder:map` (parent tracking issue). Drop `needs-triage` when a ticket is ready.
- Verify before opening a PR: `npm run lint` (tsc --noEmit) and `npm test` (vitest) locally — CI runs the same on Node 24.
- **Delegate when it makes sense:** break work into independent parallel tracks and hand each to a subagent (e.g. static lint/test/grep on one side, a live-store verification on another). Delegate when the tracks don't touch the same files or state; keep edits that depend on one another in the same hand.
- `safe-write-mcp-core` is a `file:` dependency until jpka/safe-write-mcp-core#7 publishes to npm; the registry dependency replaces it afterward.
- Architectural decisions are recorded in `DECISIONS.md` (newest first), in the style of sw-postgres-mcp.

## Agent docs

- **Issue tracker** — `gh` CLI conventions, the PR-first workflow, and the build map: `docs/agents/issue-tracker.md`.
- **Triage labels** — the five canonical labels and when to apply them: `docs/agents/triage-labels.md`.
- **Domain docs** — what to read before exploring, and the codebase's vocabulary: `docs/agents/domain.md`.
