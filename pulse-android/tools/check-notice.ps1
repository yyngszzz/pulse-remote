<#
.SYNOPSIS
  Run the phone's notification policy under a plain JVM.

.DESCRIPTION
  Notice.java has no Android dependencies on purpose, so the mapping from a
  distilled frame to "what the shade should say, and whether to interrupt" can be
  executed here in a second. The bug that motivated it - the service handled
  turn-end and dropped every other frame, so the shade sat on "Pulse 已连接" for
  the whole length of a task - is a property of a table, and a table is cheaper to
  check by command than on a lock screen.

  Compiles Notice.java together with tools/NoticeCheck.java, runs it, and passes
  the exit code through, so this can gate a build.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/check-notice.ps1

.PARAMETER Toolchain
  Root of the portable JDK + Android SDK, same default as build.ps1.
#>

[CmdletBinding()]
param(
  [string]$Toolchain = 'D:\android-toolchain'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {

$jdk = (Get-ChildItem $Toolchain -Directory -Filter 'jdk-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $jdk) { Write-Host "FAILED: 在 $Toolchain 里找不到 JDK" -ForegroundColor Red; exit 1 }
$javac = Join-Path $jdk 'bin\javac.exe'
$java = Join-Path $jdk 'bin\java.exe'
foreach ($tool in @($javac, $java)) {
  if (-not (Test-Path $tool)) { Write-Host "FAILED: 缺少 $tool" -ForegroundColor Red; exit 1 }
}

New-Item -ItemType Directory -Force -Path 'build\check' | Out-Null

# -encoding UTF-8 is load-bearing: the cases carry the same Chinese text the
# distiller emits, and javac would otherwise decode it with the legacy code page.
& $javac -source 8 -target 8 -nowarn -Xlint:-options -encoding UTF-8 `
  -d 'build\check' 'app\java\com\pulse\remote\Notice.java' 'app\java\com\pulse\remote\DoneGate.java' `
  'tools\NoticeCheck.java'
if ($LASTEXITCODE -ne 0) { Write-Host 'FAILED: javac' -ForegroundColor Red; exit 1 }

& $java -cp 'build\check' NoticeCheck
exit $LASTEXITCODE

}
finally {
  Pop-Location
}
