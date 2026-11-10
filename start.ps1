# start.ps1 starts Polygraph's server and the dashboard together, then opens
# the New interrogation screen in your browser. Press Ctrl+C to stop both.
#
# Run it in the run tab, from the Polygraph folder:
#   .\start.ps1
#
# Both only listen on this PC. If a run is going when you press Ctrl+C, it
# stops, and everything finished so far is saved and judged first.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$dashboard = Join-Path $PSScriptRoot 'dashboard'
$serverPort = 8420
$dashboardPort = 5173

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

function PortInUse([int]$port) {
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$listening
}

# 1. Everything it needs.
if (-not (Test-Path $python)) {
    Say "Polygraph's Python setup (the .venv folder) is missing." Red
    Say 'Set it up as described in PROGRESS.md, then run .\start.ps1 again.'
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Say "Node.js isn't installed, or Windows can't find it." Red
    exit 1
}
if (-not (Test-Path (Join-Path $dashboard 'node_modules'))) {
    Say "Installing the dashboard's packages (first time only, exactly the locked versions)..." Yellow
    Push-Location $dashboard
    try {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Say 'Installing the packages failed. The messages above say why.' Red; exit 1 }
    } finally { Pop-Location }
}
if (PortInUse $serverPort) {
    Say "Port $serverPort is already in use: Polygraph's server may already be running in another tab." Red
    Say 'Close that tab (or press Ctrl+C in it), then run .\start.ps1 again.'
    exit 1
}
if (PortInUse $dashboardPort) {
    Say "Port $dashboardPort is already in use: the dashboard may already be running (npm run dev) in another tab." Red
    Say 'Stop it with Ctrl+C there, then run .\start.ps1 again.'
    exit 1
}

# 2. Ollama: only a warning, because cloud models work without it.
try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/version' -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {
    Say "Ollama isn't running, so the models on this PC won't be offered. To use them, open Ollama from the Start menu." Yellow
}

# 3. The server. It shares this window, so Ctrl+C reaches it too.
Say "Starting Polygraph's server..." Cyan
$server = Start-Process -FilePath $python -ArgumentList @('-m', 'polygraph', 'serve', '--port', "$serverPort") -NoNewWindow -PassThru
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if ($server.HasExited) { break }
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$serverPort/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
        $ready = $true
        break
    } catch { }
}
if (-not $ready) {
    Say "Polygraph's server didn't start. The message above says why." Red
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    exit 1
}

# 4. The dashboard, in this window, until Ctrl+C.
Say 'Starting the dashboard. It opens in your browser. Press Ctrl+C here to stop everything.' Cyan
$open = @('--open', '/#/new')
if ($env:POLYGRAPH_NO_BROWSER) { $open = @() }
Push-Location $dashboard
try {
    & node scripts/export-runs.mjs
    & node node_modules/vite/bin/vite.js --strictPort @open
} finally {
    Pop-Location
    if (-not $server.HasExited) {
        # The server got the Ctrl+C too. Give it time to save and judge a run that was going.
        if (-not $server.WaitForExit(20000)) { Stop-Process -Id $server.Id -Force }
    }
    Say "Polygraph's server and the dashboard have stopped." Cyan
}
