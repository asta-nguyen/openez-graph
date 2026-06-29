# OpenEZ Graph — install script (Windows PowerShell)
# Usage: irm https://raw.githubusercontent.com/asta-nguyen/openez-graph/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "⚠ $msg" -ForegroundColor Yellow }
function Err($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

# ── Check Node.js ──
try {
    $nodeVersion = (node -v) -replace 'v','' -split '\.' | Select-Object -First 1
    if ([int]$nodeVersion -lt 20) {
        Err "Node.js 20+ is required. Current: $(node -v)"
    }
    Info "Node.js $(node -v) detected"
} catch {
    Err "Node.js is not installed. Get it from: https://nodejs.org/"
}

# ── Install CLI globally ──
Write-Host ""
Write-Host "Installing @openez-graph/cli globally..."
npm install -g @openez-graph/cli
if ($LASTEXITCODE -ne 0) { Err "npm install failed" }

# ── Verify install ──
$openezPath = (Get-Command openez -ErrorAction SilentlyContinue).Source
if (-not $openezPath) {
    $npmPrefix = (npm config get prefix)
    $candidate = Join-Path $npmPrefix "openez.cmd"
    if (Test-Path $candidate) {
        Warn "openez installed at $candidate but not in PATH"
        Write-Host "  Add to PATH: $npmPrefix"
    } else {
        Err "Installation failed — openez command not found"
    }
}
Info "openez CLI installed"

# ── Auto-setup agents ──
Write-Host ""
Write-Host "Configuring agent integrations..."

$setupAgent = $null
if (Test-Path "$env:USERPROFILE\.claude") {
    $setupAgent = "claude"
} elseif (Test-Path "$env:USERPROFILE\.codex") {
    $setupAgent = "codex"
} elseif (Test-Path "$env:USERPROFILE\.config\opencode") {
    $setupAgent = "opencode"
}

if ($setupAgent) {
    Write-Host ""
    $confirm = Read-Host "Configure $setupAgent automatically? (Y/n)"
    if ($confirm -eq "" -or $confirm -match "^[Yy]") {
        openez setup $setupAgent
        if ($LASTEXITCODE -ne 0) { Warn "Setup for $setupAgent failed — run 'openez setup $setupAgent' manually later" }
    } else {
        Write-Host "Skipped. Run manually later:"
        Write-Host "  openez setup $setupAgent"
    }
} else {
    Write-Host "No agent detected. Run manually when ready:"
    Write-Host "  openez setup claude    # for Claude Code"
    Write-Host "  openez setup codex     # for Codex"
    Write-Host "  openez setup opencode  # for OpenCode"
}

# ── Done ──
Write-Host ""
Info "OpenEZ Graph installed successfully!"
Write-Host ""
Write-Host "  Restart your agent to activate the MCP server."
Write-Host "  The server will auto-register, auto-index, and auto-sync your workspace."
Write-Host ""
Write-Host "  Manual commands:"
Write-Host "    openez init .        # register + index current directory"
Write-Host "    openez serve --mcp   # start MCP server"
Write-Host "    openez list          # list registered workspaces"
