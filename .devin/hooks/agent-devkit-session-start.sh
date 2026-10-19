#!/usr/bin/env bash
# SessionStart hook for agent-devkit skills (Devin CLI adaptation).
# Injects the using-devkit skill content so the agent can select the right workflow.

set -euo pipefail

# Prefer the project copy, then the user-level Devin skill.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_SKILL="${SCRIPT_DIR}/../../.agents/skills/using-devkit/SKILL.md"
GLOBAL_SKILL="${HOME}/.config/devin/skills/using-devkit/SKILL.md"

if [ -f "$PROJECT_SKILL" ]; then
  SKILL_PATH="$PROJECT_SKILL"
elif [ -f "$GLOBAL_SKILL" ]; then
  SKILL_PATH="$GLOBAL_SKILL"
else
  # Skill not found — fail silently rather than break the session.
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'
  exit 0
fi

using_devkit_content=$(cat "$SKILL_PATH")

# Escape string for JSON embedding using bash parameter substitution.
escape_for_json() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

using_devkit_escaped=$(escape_for_json "$using_devkit_content")
session_context="Project workflow: agent-devkit.\n\n**Read the full content of the repository's using-devkit entry skill below, then load other skills as directed by it:**\n\n${using_devkit_escaped}"

# Devin CLI reads hookSpecificOutput.additionalContext for SessionStart.
printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' "$session_context"

exit 0
