<#
.SYNOPSIS
  Run / recycle Agent Cockpit and open it in a standalone (chromeless) Edge window.

.DESCRIPTION
  One entry point for the run + recycle loop.

    .\cockpit.ps1              # start server (if not already up) + open standalone window
    .\cockpit.ps1 open         # just open the standalone window (server already running)
    .\cockpit.ps1 restart      # kill the server on the port + start fresh (backend change)
    .\cockpit.ps1 stop         # kill the server on the port
    .\cockpit.ps1 -Tailscale   # bind to this device's Tailscale IP instead of loopback,
                               # so your phone (on the same tailnet) can reach the cockpit.
                               # One-time setup: run as Administrator once -
                               #   New-NetFirewallRule -DisplayName 'Agent Cockpit (Tailscale)' `
                               #     -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8770 `
                               #     -InterfaceAlias 'Tailscale' -Profile Any
                               # (scoped to the Tailscale adapter only - nothing opens on your LAN/Wi-Fi NIC).

  Recycle rule:
    - Front-end change (public/*.html/.css/.js) -> just HARD-REFRESH the window (Ctrl+F5).
      The server reads index.html fresh per request, so no restart is needed.
    - Backend change (src/*.ts) -> .\cockpit.ps1 restart (tsx has no hot reload).

  Port: $env:COCKPIT_PORT or 8770.
#>
param(
  [ValidateSet('start','open','restart','stop')] [string]$Action = 'start',
  [switch]$Tailscale
)

$ErrorActionPreference = 'Stop'
$port = if ($env:COCKPIT_PORT) { $env:COCKPIT_PORT } else { '8770' }
$root = $PSScriptRoot

$hostAddr = '127.0.0.1'
if ($Tailscale) {
  $hostAddr = (& tailscale ip -4 2>$null | Select-Object -First 1)
  if (-not $hostAddr) { Write-Warning "Could not read a Tailscale IP (is Tailscale running?) - falling back to 127.0.0.1."; $hostAddr = '127.0.0.1' }
}
$url = "http://${hostAddr}:$port"

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
  Write-Host "Starting server on ${hostAddr}:$port ..."
  # cmd /c 'set VAR=...&& npm.cmd start' - Start-Process on PS 5.1 has no -Environment
  # param, and 'npm' (extensionless) doesn't resolve directly; go through cmd.exe.
  Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', "set COCKPIT_HOST=$hostAddr&& npm.cmd start" `
    -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Milliseconds 400
    if (Get-CockpitPid) { Write-Host "Server up -> $url"; return }
  }
  Write-Warning "Server did not come up within ~18s; check the npm window."
}

function Open-Cockpit {
  # Edge --app= gives a standalone chromeless window (no tabs / no omnibox).
  $edge = 'msedge'
  Write-Host "Opening standalone window -> $url"
  Start-Process $edge "--app=$url"
}

# How many sessions are live right now? A restart kills the server process, so
# we refuse to do that out from under running work.
function Get-ActiveSessionCount {
  try {
    $r = Invoke-RestMethod -Uri "$url/api/state" -TimeoutSec 2 -ErrorAction Stop
    return @($r).Count
  } catch { return 0 }  # server down / unreachable = nothing to protect
}

function Restart-Cockpit {
  $active = Get-ActiveSessionCount
  if ($active -gt 0) {
    Write-Warning "$active active session(s) - NOT restarting (would kill them). Opening a window instead."
    Write-Warning "Front-end fixes: just Ctrl+Shift+R. To force a restart, remove the sessions first or run: .\cockpit.ps1 stop"
    Open-Cockpit
    return
  }
  Stop-Cockpit; Start-Sleep -Milliseconds 500; Start-Cockpit; Open-Cockpit
}

switch ($Action) {
  'stop'    { Stop-Cockpit }
  'open'    { Open-Cockpit }
  'restart' { Restart-Cockpit }
  'start'   { Start-Cockpit; Open-Cockpit }
}
