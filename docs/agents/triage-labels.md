# Triage Labels

The five canonical triage labels used in this repo's issue tracker. Keep the right-hand column in sync with the actual label vocabulary — `gh issue edit <n> --add-label "<label>"` only works if the label string already exists in the repo.

| Label             | Meaning                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `needs-triage`    | Maintainer must evaluate this issue. Drop it when the ticket is ready.               |
| `needs-info`      | Waiting on the reporter for more information.                                        |
| `ready-for-agent` | Fully specified, ready for an AFK agent.                                             |
| `ready-for-human` | Requires human implementation (e.g. provisioning a store, publishing to npm).        |
| `wayfinder:map`   | Parent tracking issue (the build map).                                               |

When a ticket becomes fully specified, drop `needs-triage` and move it to `ready-for-agent` or `ready-for-human`:

- `gh issue edit <n> --remove-label needs-triage`
- `gh issue edit <n> --add-label ready-for-agent`

An agent claims a `ready-for-agent` ticket with `gh issue edit <n> --add-assignee @me` before starting.