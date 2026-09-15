# Agent scaffolding

Working files for agents operating in this repository. Nothing here ships, and nothing
here may be referenced from a commit message, a pull request, an issue or a code
comment: a reader of those cannot open these files.

| Path            | What it is                                        |
| --------------- | ------------------------------------------------- |
| `agents/`       | Dispatchable worker definitions                   |
| `skills/`       | Task procedures invoked by name                   |
| `hooks/`        | `PreToolUse` guards registered in `settings.json` |
| `plans/`        | Saved plans, one per piece of work                |
| `settings.json` | Permissions and hook registration, committed      |

`settings.local.json` is per-machine and is not committed.

The work contract itself is in `CLAUDE.md` at the repository root, because it is the
file agents are given automatically.
