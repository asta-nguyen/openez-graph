#!/bin/sh
# OpenEZ Graph — install script (macOS / Linux)
# Usage: curl -fsSL https://raw.githubusercontent.com/asta-nguyen/openez-graph/main/install.sh | sh

set -e

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

info() { printf "${BOLD}${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${BOLD}${YELLOW}⚠${RESET} %s\n" "$1"; }
error() { printf "${BOLD}${RED}✗${RESET} %s\n" "$1" >&2; }

# ── Check Node.js ──
if ! command -v node >/dev/null 2>&1; then
  error "Node.js is not installed."
  echo "  Install from: https://nodejs.org/ (requires Node.js 20+)"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js 20+ is required. Current: $(node -v)"
  exit 1
fi
info "Node.js $(node -v) detected"

# ── Install CLI globally ──
echo ""
echo "Installing @openez-graph/cli globally..."
if command -v npm >/dev/null 2>&1; then
  npm install -g @openez-graph/cli
elif command -v pnpm >/dev/null 2>&1; then
  pnpm install -g @openez-graph/cli
else
  error "Neither npm nor pnpm found. Install Node.js from https://nodejs.org/"
  exit 1
fi

# ── Verify install ──
if ! command -v openez >/dev/null 2>&1; then
  # npm global bin might not be in PATH
  NPM_BIN=$(npm config get prefix 2>/dev/null)/bin
  if [ -f "$NPM_BIN/openez" ]; then
    warn "openez installed at $NPM_BIN/openez but not in PATH"
    echo "  Add to PATH: export PATH=\"$NPM_BIN:\$PATH\""
  else
    error "Installation failed — openez command not found"
    exit 1
  fi
fi
info "openez CLI installed"

# ── Auto-setup agents ──
echo ""
echo "Configuring agent integrations..."

SETUP_ARGS=""
if [ -n "$1" ]; then
  SETUP_ARGS="$1"
else
  # Auto-detect installed agents
  if [ -d "$HOME/.claude" ]; then
    SETUP_ARGS="claude"
  elif [ -d "$HOME/.codex" ]; then
    SETUP_ARGS="codex"
  elif [ -d "$HOME/.config/opencode" ]; then
    SETUP_ARGS="opencode"
  fi
fi

if [ -n "$SETUP_ARGS" ]; then
  openez setup "$SETUP_ARGS" || warn "Setup for $SETUP_ARGS failed — you can run 'openez setup claude' manually later"
else
  echo "No agent detected. Run manually when ready:"
  echo "  openez setup claude    # for Claude Code"
  echo "  openez setup codex     # for Codex"
  echo "  openez setup opencode  # for OpenCode"
fi

# ── Done ──
echo ""
info "OpenEZ Graph installed successfully!"
echo ""
echo "  Restart your agent to activate the MCP server."
echo "  The server will auto-register, auto-index, and auto-sync your workspace."
echo ""
echo "  Manual commands:"
echo "    openez init .        # register + index current directory"
echo "    openez serve --mcp   # start MCP server"
echo "    openez list          # list registered workspaces"
