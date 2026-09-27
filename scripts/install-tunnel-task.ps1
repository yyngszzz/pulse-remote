<#
.SYNOPSIS
  Register (or remove) the logon task that keeps the Pulse tunnel up.

.DESCRIPTION
  Without this, the remote dies with the console that started it: close the
  terminal, sleep the laptop, and the phone gets a connection error with no
  explanation. The task runs scripts\tunnel.ps1 in the current user's context at
  logon, with Task Scheduler restarting it if it ever exits.

  The supervisor is safe to run alongside an existing tunnel -- it checks the
  remote port first and idles rather than competing for it -- so registering this
  while a manual tunnel is up will not cause flapping.

.PARAMETER Server
  SSH destination, e.g. root@203.0.113.10.

.PARAMETER RemotePort
  Port to bind on the edge; must match nginx's proxy_pass target.

.PARAMETER LocalPort
  Local Pulse port.

.PARAMETER TaskName
  Scheduled task name.

.PARAMETER Remove
  Unregister the task instead of creating it.

.EXAMPLE
  pwsh -File scripts/install-tunnel-task.ps1 -Server root@203.0.113.10
  pwsh -File scripts/install-tunnel-task.ps1 -Remove
#>

[CmdletBinding()]
param(
  # Not [Mandatory]: removal does not need a server, and a mandatory parameter
  # would make `-Remove` unusable without one.
  [string]$Server = '',
  [int]$RemotePort = 3199,
  [int]$LocalPort = 3199,
  [string]$TaskName = 'DSH-Pulse-Tunnel',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Host "没有名为 $TaskName 的计划任务，无需删除。"
    exit 0
  }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已删除计划任务 $TaskName。"
  exit 0
}

if (-not $Server) {
  Write-Host '需要 -Server，例如：'
  Write-Host '  pwsh -File scripts/install-tunnel-task.ps1 -Server root@203.0.113.10'
  exit 2
}

$script = Join-Path $PSScriptRoot 'tunnel.ps1'
if (-not (Test-Path $script)) { throw "找不到 $script" }

# Prefer PowerShell 7 when present, but fall back: this must work on a machine
# where only the built-in Windows PowerShell exists.
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source }
if (-not $shell) { throw '找不到 pwsh 或 powershell.exe' }

$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$log = Join-Path $home_ 'remote-pulse\tunnel.log'

$arguments = @(
  '-NoProfile'
  '-ExecutionPolicy', 'Bypass'
  '-WindowStyle', 'Hidden'
  '-File', "`"$script`""
  '-Server', $Server
  '-RemotePort', $RemotePort
  '-LocalPort', $LocalPort
  '-LogPath', "`"$log`""
) -join ' '

$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

# Interactive principal: the tunnel needs this user's SSH key and Pulse runs in
# this user's session, so a service account would not have either.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
} catch {
  Write-Host "注册计划任务失败：$($_.Exception.Message)"
  Write-Host ''
  Write-Host '这一步通常需要管理员权限。用管理员 PowerShell 重跑本脚本，或者手动跑：'
  Write-Host "  $shell $arguments"
  exit 1
}

Write-Host "已注册计划任务 $TaskName"
Write-Host "  服务器    : $Server"
Write-Host "  端口      : 远端 $RemotePort -> 本机 127.0.0.1:$LocalPort"
Write-Host "  日志      : $log"
Write-Host ''
Write-Host '常用命令：'
Write-Host "  Start-ScheduledTask -TaskName $TaskName      # 立刻启动"
Write-Host "  Get-ScheduledTaskInfo -TaskName $TaskName    # 看上次结果"
Write-Host "  Get-Content '$log' -Tail 30 -Wait            # 看隧道日志"
Write-Host "  pwsh -File scripts/install-tunnel-task.ps1 -Remove   # 取消自启"
Write-Host ''
Write-Host '注意：现在会同时存在两个隧道守护（本会话一个 + 计划任务一个）。'
Write-Host '守护脚本会先检查远端端口，已经有人占着就只观察不抢，所以不会互相打架。'
