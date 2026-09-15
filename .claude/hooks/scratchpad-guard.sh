#!/usr/bin/env bash
# Stops concurrent subagents clobbering each other in the shared scratchpad.
#
# Every subagent in a session is handed the SAME scratchpad_dir, and its system
# prompt tells it to use that directory for temporary files. Two agents writing
# a generically named file there overwrite each other mid-task, and each then
# reads data belonging to the other.
#
# Rule: a subagent may not write DIRECTLY into the scratchpad root.
# Subdirectories are allowed, which is what the namespacing convention asks for
# anyway. The main session is exempt: it is the single coordinator and cannot
# collide with itself.
#
# Restating the rule in prose has not been enough elsewhere, because the agent's
# own system prompt names that directory and tells it to use it. The agent holds
# two conflicting instructions and the harness one reads as infrastructure
# guidance. The durable fix is for a dispatcher to pass a unique scratch root in
# every dispatch prompt, so the agent is given a directory rather than a
# prohibition to remember. This hook closes the gap in the meantime.
set -uo pipefail

payload=$(cat)
allow() { exit 0; }

command -v jq >/dev/null 2>&1 || allow

agent_id=$(printf '%s' "$payload" | jq -r '.agent_id // ""')
[ -n "$agent_id" ] || allow

scratch=$(printf '%s' "$payload" | jq -r '.scratchpad_dir // ""')
[ -n "$scratch" ] || allow

file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
[ -n "$file" ] || allow

[ "$(dirname -- "$file")" = "$scratch" ] || allow

agent_type=$(printf '%s' "$payload" | jq -r '.agent_type // "subagent"')

read -r -d '' JQ_PROG <<'JQ'
{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: (
      "Blocked: writing \"" + $f + "\" directly into the shared session scratchpad.\n\n" +
      $s + " is handed to EVERY agent in this session, including any running beside you right now. A file written there is silently overwritten by a sibling using the same name, and each of you then reads the other's data.\n\n" +
      "Your system prompt tells you to use that directory for temporary files. For this work that instruction is superseded.\n\n" +
      "Write to one of these instead:\n" +
      "  - your own git worktree, which is already unique to you and is preferred\n" +
      "  - " + $s + "/" + $t + "-" + $a + "/ ... a subdirectory is fine, the bare root is not\n\n" +
      "Then retry."
    )
  }
}
JQ

jq -nc --arg f "$(basename -- "$file")" --arg s "$scratch" --arg a "$agent_id" --arg t "$agent_type" "$JQ_PROG"
