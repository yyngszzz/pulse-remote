<#
.SYNOPSIS
  Run the app's MIME table under a plain JVM.

.DESCRIPTION
  Mime.java has no Android dependencies on purpose, so "no non-image file is ever
  announced as an image" is a command here rather than a hope. That property is the
  one that broke: the table used to fall back to `image/*`, and WeChat reported
  发送失败 for a .md, a .zip or an .apk because it tried to decode the bytes as a
  picture — the same message the real permission bug produced.

  Compiles Mime.java together with tools/MimeCheck.java, runs it, and passes the
  exit code through, so this can gate a build.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/check-mime.ps1

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

# -encoding UTF-8 is load-bearing: the cases carry Chinese text, and javac would
# otherwise decode it with the machine's legacy code page.
& $javac -source 8 -target 8 -nowarn -Xlint:-options -encoding UTF-8 `
  -d 'build\check' 'app\java\com\pulse\remote\Mime.java' 'tools\MimeCheck.java'
if ($LASTEXITCODE -ne 0) { Write-Host 'FAILED: javac' -ForegroundColor Red; exit 1 }

& $java -cp 'build\check' MimeCheck
exit $LASTEXITCODE

}
finally {
  Pop-Location
}
