<#
.SYNOPSIS
  Keep the SSH reverse tunnel to the public edge alive.

.DESCRIPTION
  Pulse is only reachable from a phone while an SSH reverse tunnel is up:

      phone --HTTPS--> edge:443 (nginx) --127.0.0.1:3199--> reversed to this PC

  An ad-hoc `ssh -R` dies with the terminal that started it, which makes the
  remote useless the moment the laptop sleeps or the console closes. This script
  is the supervisor that replaces it: it holds the tunnel, notices when it drops,
  reconnects with backoff, and logs what happened.

  It is deliberately conservative about duplicates. If the remote port is already
  listening -- typically because another supervisor or an interactive session
  owns it -- this script idles and re-checks instead of fighting for the port,
  because two forwards on one remote port just makes both flap.

.PARAMETER Server
  SSH destination, e.g. root@203.0.113.10.

.PARAMETER RemotePort
  Port to bind on the edge. Must match what nginx proxies to.

.PARAMETER LocalPort
  Local Pulse port.

.PARAMETER LogPath
  Where to append supervision events.

.PARAMETER Once
  Run one supervision cycle and exit. Used by tests and by manual diagnosis.

.EXAMPLE
  pwsh -File scripts/tunnel.ps1 -Server root@203.0.113.10
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [int]$RemotePort = 3199,
  [int]$LocalPort = 3199,
  [string]$LogPath = '',
  [switch]$Once
)

$ErrorActionPreference = 'Continue'

# Windows PowerShell 5.1 has no '??' operator, and this must run under it because
# that is what the Task Scheduler invokes by default.
if (-not $LogPath) {
  $home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $LogPath = Join-Path $home_ 'remote-pulse\tunnel.log'
}

function Write-Log {
  param([string]$Message)
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $line = "[$stamp] $Message"
  Write-Host $line
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch {
    # Logging must never be the reason the tunnel stops.
  }
}

function Test-RemotePort {
  <#
    Whether something is already listening on the edge.
    Returns $true / $false / $null -- $null means the check itself failed
    (no network, no key), which is different from "the port is closed".
  #>
  $probe = "ss -ltn | grep -c ':$RemotePort '"
  $result = & ssh -o BatchMode=yes -o ConnectTimeout=10 $Server $probe 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $text = ($result | Out-String).Trim()
  if (-not $text) { return $null }
  return ($text -ne '0')
}

function Test-LocalPort {
  <# Whether Pulse itself is listening locally. #>
  $found = netstat -ano | Select-String 'LISTENING' | Select-String ":$LocalPort\s"
  return [bool]$found
}

function Start-Tunnel {
  <#
    Run one foreground ssh until it exits. ExitOnForwardFailure makes a
    port-collision a fast, loud failure instead of a silent half-open tunnel.
  #>
  Write-Log "starting tunnel: -R ${RemotePort}:127.0.0.1:${LocalPort} -> $Server"
  & ssh -N -T `
    -o BatchMode=yes `
    -o ExitOnForwardFailure=yes `
    -o GatewayPorts=yes `
    -o ServerAliveInterval=20 `
    -o ServerAliveCountMax=3 `
    -o TCPKeepAlive=yes `
    -R "${RemotePort}:127.0.0.1:${LocalPort}" `
    $Server 2>&1 | ForEach-Object { Write-Log "ssh: $_" }
  return $LASTEXITCODE
}

# ---------------------------------------------------------------- supervision

Write-Log "supervisor started (server=$Server remote=$RemotePort local=$LocalPort once=$($Once.IsPresent))"

$attempt = 0
while ($true) {
  if (-not (Test-LocalPort)) {
    # Nothing to forward yet. Waiting is better than tunnelling to a dead port,
    # which would make the phone hang instead of showing a clear failure.
    Write-Log "Pulse is not listening on 127.0.0.1:$LocalPort yet; waiting"
    if ($Once) { exit 3 }
    Start-Sleep -Seconds 15
    continue
  }

  if (Test-RemotePort) {
    Write-Log "remote port $RemotePort is already served; supervising instead of competing"
    if ($Once) { exit 0 }
    Start-Sleep -Seconds 30
    continue
  }

  $exit = Start-Tunnel
  $attempt += 1
  Write-Log "ssh exited ($exit) after attempt $attempt"

  if ($Once) { exit 1 }

  if ($exit -eq 0) {
    $attempt = 0
    Start-Sleep -Seconds 3
    continue
  }

  # Exponential backoff, capped: a server that is down for an hour should not
  # produce an hour of connection spam.
  [int]$delay = [Math]::Min(120, [Math]::Pow(2, [Math]::Min($attempt, 7)))
  Write-Log "reconnecting in $delay s"
  Start-Sleep -Seconds $delay
}
