#!/usr/bin/env bash
# SessionStart hook for Superpowers skills (Devin CLI adaptation).
# Injects the using-superpowers skill content as additionalContext so the
# agent bootstraps the skills system at session start.
#
# Without this hook, skills sit on disk but never auto-trigger.
# See: https://github.com/obra/superpowers

set -euo pipefail

# Resolve the using-superpowers SKILL.md path.
# Prefer project-level, fall back to global.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_SKILL="${SCRIPT_DIR}/../../.agents/skills/superpowers-using-superpowers/SKILL.md"
GLOBAL_SKILL="${HOME}/.config/devin/skills/superpowers-using-superpowers/SKILL.md"

if [ -f "$PROJECT_SKILL" ]; then
  SKILL_PATH="$PROJECT_SKILL"
elif [ -f "$GLOBAL_SKILL" ]; then
  SKILL_PATH="$GLOBAL_SKILL"
else
  # Skill not found — fail silently rather than break the session.
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'
  exit 0
fi

using_superpowers_content=$(cat "$SKILL_PATH")

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

using_superpowers_escaped=$(escape_for_json "$using_superpowers_content")
session_context="<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n**Below is the full content of your 'superpowers-using-superpowers' skill - your introduction to using skills. For all other skills, use the 'Skill' tool:**\n\n${using_superpowers_escaped}\n</EXTREMELY_IMPORTANT>"

# Devin CLI reads hookSpecificOutput.additionalContext for SessionStart.
printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' "$session_context"

exit 0
