<#
.SYNOPSIS
  Run / recycle Agent Cockpit and open it in a standalone (chromeless) Edge window.

.DESCRIPTION
  One entry point for the run + recycle loop.

    .\cockpit.ps1              # start server (if not already up) + open standalone window
    .\cockpit.ps1 open         # just open the standalone window (server already running)
    .\cockpit.ps1 restart      # kill the server on the port + start fresh (backend change)
    .\cockpit.ps1 stop         # kill the server on the port

  Recycle rule:
    - Front-end change (public/*.html/.css/.js) -> just HARD-REFRESH the window (Ctrl+F5).
      The server reads index.html fresh per request, so no restart is needed.
    - Backend change (src/*.ts) -> .\cockpit.ps1 restart (tsx has no hot reload).

  Port: $env:COCKPIT_PORT or 8770.
#>
param([ValidateSet('start','open','restart','stop')] [string]$Action = 'start')

$ErrorActionPreference = 'Stop'
$port = if ($env:COCKPIT_PORT) { $env:COCKPIT_PORT } else { '8770' }
$url  = "http://127.0.0.1:$port"
$root = $PSScriptRoot

function Get-CockpitPid {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess } else { return $null }
}

function Stop-Cockpit {
  $procId = Get-CockpitPid
  if ($procId) { Write-Host "Stopping server on :$port (pid $procId)"; Stop-Process -Id $procId -Force }
  else { Write-Host "No server listening on :$port" }
}

function Start-Cockpit {
  if (Get-CockpitPid) { Write-Host "Server already up on :$port"; return }
  Write-Host "Starting server on :$port ..."
  Start-Process -FilePath 'npm' -ArgumentList 'start' -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 400
    if (Get-CockpitPid) { Write-Host "Server up."; return }
  }
  Write-Warning "Server did not come up within ~12s; check the npm window."
}

function Open-Cockpit {
  # Edge --app= gives a standalone chromeless window (no tabs / no omnibox).
  $edge = 'msedge'
  Write-Host "Opening standalone window -> $url"
  Start-Process $edge "--app=$url"
}

switch ($Action) {
  'stop'    { Stop-Cockpit }
  'open'    { Open-Cockpit }
  'restart' { Stop-Cockpit; Start-Sleep -Milliseconds 500; Start-Cockpit; Open-Cockpit }
  'start'   { Start-Cockpit; Open-Cockpit }
}
