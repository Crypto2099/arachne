#!/usr/bin/env bash
# Stops subagents editing the primary checkout instead of their own worktree.
#
# The risk is not git safety, which worktrees already provide. The primary
# checkout is the maintainer's working copy. An agent editing it changes files
# under someone who may be reading or running them, and two concurrent agents
# collide there exactly as they collide in a shared scratchpad.
#
# Rule: a subagent may not Write or Edit any path inside the repository root.
# Worktrees live outside it, so they pass untouched. Reads are not affected. The
# main session is exempt: it is the single coordinator and cannot collide with
# itself.
#
# Subagent calls carry `agent_id`; main-session calls do not. `session_id` and
# `transcript_path` are identical for both and cannot be used to tell them apart.
#
# The jq program lives in a quoted heredoc rather than a single-quoted argument.
# An apostrophe in prose inside a single-quoted jq program silently closes the
# shell quote and turns the deny path into a syntax error.
set -uo pipefail

payload=$(cat)
allow() { exit 0; }

command -v jq >/dev/null 2>&1 || allow

agent_id=$(printf '%s' "$payload" | jq -r '.agent_id // ""')
[ -n "$agent_id" ] || allow          # main session, not our business

file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
[ -n "$file" ] || allow

# This script lives at <repo>/.claude/hooks/, so the repo root is three up.
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd -- "$here/../.." && pwd)

case "$file" in
  "$repo"|"$repo"/*) ;;
  *) allow ;;
esac

read -r -d '' JQ_PROG <<'JQ'
{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: (
      "Blocked: writing to " + $f + ", which is inside the primary checkout at " + $r + ".\n\n" +
      "That directory is the maintainer's own working copy, not yours. Editing it changes files out from under someone who may be reading or running them, and concurrent agents collide there.\n\n" +
      "Your task gave you a worktree path. Work there instead: it is a checkout of this repository on your own branch, and everything you do in it is yours alone.\n\n" +
      "If you do not have one, create it and use it:\n" +
      "  git -C " + $r + " fetch origin\n" +
      "  git -C " + $r + " worktree add <your-scratch-root>/worktree -b <branch> origin/main\n\n" +
      "Reading from the primary checkout is fine and is not blocked. Only writes are.\n\n" +
      "Then retry against the worktree path."
    )
  }
}
JQ

jq -nc --arg f "$file" --arg r "$repo" "$JQ_PROG"
