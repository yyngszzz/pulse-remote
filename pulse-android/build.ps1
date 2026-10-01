<#
.SYNOPSIS
  Build a signed Pulse Remote APK without Gradle.

.DESCRIPTION
  Gradle would pull a plugin graph from Maven Central, which is slow and flaky
  from mainland China for a project this small. The APK is a zip with a manifest,
  resources and a dex file, and the SDK ships every tool needed to assemble one
  directly: aapt2, d8, zipalign and apksigner.

  Two details this script exists to get right:

  * **The pin is derived, not typed.** `tools/PinTool.java` hashes the public key
    of the certificate about to be bundled, and the result is written into the
    generated `Config` class. So the trust anchor and the pin computed at runtime
    come from one input and cannot disagree.
  * **No argument ever contains a space.** This repository lives under
    `D:\deepseek harness`, and Windows PowerShell 5.1 does not quote arguments
    when invoking a native executable — a path with a space silently arrives
    split in two and the tool fails in a confusing way. Every project path here is
    therefore relative to the project root, and the toolchain lives at a
    space-free absolute path.

.PARAMETER BaseUrl
  Where the phone reaches the harness, e.g. https://203.0.113.10. Defaults to the
  value already in app/res/raw/pulse_ca.crt's deployment (recorded in build.json).

.PARAMETER Toolchain
  Root of the portable JDK + Android SDK.

.PARAMETER Clean
  Remove build outputs first.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File build.ps1
  powershell -ExecutionPolicy Bypass -File build.ps1 -BaseUrl https://203.0.113.10 -Clean
#>

[CmdletBinding()]
param(
  [string]$BaseUrl = '',
  [string]$Toolchain = 'D:\android-toolchain',
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'

# Everything below uses paths relative to here, so no argument can contain a space.
$root = $PSScriptRoot
Push-Location $root
try {

function Step($n, $text) { Write-Host "`n=== [$n] $text ===" -ForegroundColor Cyan }
function Fail($text) { Write-Host "FAILED: $text" -ForegroundColor Red; exit 1 }

# ---- locate the toolchain ---------------------------------------------------

Step 1 '定位工具链'

$jdk = (Get-ChildItem $Toolchain -Directory -Filter 'jdk-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $jdk) { Fail "在 $Toolchain 里找不到 JDK" }
$sdk = Join-Path $Toolchain 'sdk'
$buildTools = (Get-ChildItem (Join-Path $sdk 'build-tools') -Directory -ErrorAction SilentlyContinue |
               Sort-Object Name -Descending | Select-Object -First 1).FullName
$platform = (Get-ChildItem (Join-Path $sdk 'platforms') -Directory -ErrorAction SilentlyContinue |
             Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $buildTools) { Fail '缺少 build-tools，先跑 sdkmanager "build-tools;34.0.0"' }
if (-not $platform) { Fail '缺少 platform，先跑 sdkmanager "platforms;android-34"' }

$androidJar = Join-Path $platform 'android.jar'
$java = Join-Path $jdk 'bin\java.exe'
$javac = Join-Path $jdk 'bin\javac.exe'
$keytool = Join-Path $jdk 'bin\keytool.exe'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$d8 = Join-Path $buildTools 'd8.bat'
if (-not (Test-Path $d8)) { $d8 = Join-Path $sdk 'cmdline-tools\latest\bin\d8.bat' }

foreach ($tool in @($java, $javac, $aapt2, $zipalign, $apksigner, $d8)) {
  if (-not (Test-Path $tool)) { Fail "缺少工具：$tool" }
}

# d8.bat and apksigner.bat are wrappers that shell out to java, and they find the
# runtime through JAVA_HOME rather than through the path of the .bat that invoked
# them. Without this, d8 reports "JAVA_HOME is not set" even though javac, two
# lines earlier, just ran fine.
$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$env:PATH"

Write-Host "  JDK        : $jdk"
Write-Host "  build-tools: $(Split-Path $buildTools -Leaf)"
Write-Host "  platform   : $(Split-Path $platform -Leaf)"

# ---- what are we pointing at? -----------------------------------------------

Step 2 '确定部署地址与证书指纹'

$configFile = 'build.json'
if (-not $BaseUrl) {
  if (Test-Path $configFile) {
    $BaseUrl = (Get-Content $configFile -Raw | ConvertFrom-Json).baseUrl
  } else {
    Fail "没有 -BaseUrl，也没有 $configFile"
  }
}
$BaseUrl = $BaseUrl.TrimEnd('/')
$uri = [Uri]$BaseUrl
if ($uri.Scheme -ne 'https') { Fail '必须用 https：明文会把配对 cookie 暴露在公网上' }
$host_ = $uri.Host

# The official client's hard floor on the browser engine: the shell calls
# `Promise.withResolvers()`, which no engine before Chrome 119 implements. A
# phone below that renders a blank page with no error, so the number is passed
# into the app and checked at startup. Measured, not guessed — see the probe that
# scans the served shell and bundles for modern syntax.
$requiredChrome = 119
if (Test-Path $configFile) {
  $configured = (Get-Content $configFile -Raw | ConvertFrom-Json).requiredChrome
  if ($configured) { $requiredChrome = [int]$configured }
}

$certPath = 'app\res\raw\pulse_ca.crt'
if (-not (Test-Path $certPath)) { Fail "找不到 $certPath" }
$pin = (& $java 'tools\PinTool.java' $certPath | Select-Object -Last 1).Trim()
if ($pin.Length -lt 40) { Fail "算不出证书指纹：$pin" }

Write-Host "  baseUrl: $BaseUrl"
Write-Host "  host   : $host_"
Write-Host "  pin    : $pin"
Write-Host "  需要 WebView: Chrome $requiredChrome+"

# ---- clean ------------------------------------------------------------------

if ($Clean) {
  foreach ($d in @('build', 'dist')) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
}
New-Item -ItemType Directory -Force -Path 'build', 'build\gen', 'build\gen-config', 'build\classes', 'build\dex', 'dist' | Out-Null

# ---- generate Config --------------------------------------------------------

Step 3 '生成 Config（指纹来自上一步，不会和证书不一致）'

$configSource = @"
package com.pulse.remote;

/**
 * Generated by build.ps1. Do not edit: the pin below is computed from the
 * certificate bundled at $certPath, so the trust anchor and the runtime check
 * cannot drift apart.
 */
final class Config {
    static final String BASE_URL = "$BaseUrl";
    static final String HOST = "$host_";
    static final String CERT_PIN_SHA256 = "$pin";
    static final int REQUIRED_CHROME_MAJOR = $requiredChrome;
    static final String PREFS = "pulse";
    static final String PREF_SEQ = "lastSeq";
    private Config() {}
}
"@
Set-Content -Path 'build\gen-config\com\pulse\remote\Config.java' -Value $configSource -Encoding UTF8 -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path 'build\gen-config\com\pulse\remote' | Out-Null
# Written without a BOM on purpose. PowerShell 5.1's -Encoding UTF8 always emits
# one, and javac reads a leading U+FEFF as a stray character before `package` and
# rejects the file with a message that never mentions encoding.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) 'build\gen-config\com\pulse\remote\Config.java'),
  $configSource, $utf8NoBom)

# ---- resources --------------------------------------------------------------

Step 4 '编译资源（aapt2 compile）'
& $aapt2 compile --dir 'app\res' -o 'build\res.zip'
if ($LASTEXITCODE -ne 0) { Fail 'aapt2 compile' }
Write-Host "  res.zip: $((Get-Item 'build\res.zip').Length) 字节"

Step 5 '链接资源并生成 R.java（aapt2 link）'
& $aapt2 link `
  -o 'build\base.apk' `
  -I $androidJar `
  --manifest 'app\AndroidManifest.xml' `
  --java 'build\gen' `
  --min-sdk-version 24 `
  --target-sdk-version 34 `
  'build\res.zip'
if ($LASTEXITCODE -ne 0) { Fail 'aapt2 link' }
$rJava = Get-ChildItem 'build\gen' -Recurse -Filter 'R.java' | Select-Object -First 1
if (-not $rJava) { Fail 'aapt2 没有生成 R.java' }
Write-Host "  base.apk: $((Get-Item 'build\base.apk').Length) 字节"

# ---- java -------------------------------------------------------------------

Step 6 '编译 Java（javac，相对路径因此不含空格）'
$sources = @()
$sources += (Get-ChildItem 'app\java' -Recurse -Filter '*.java' | ForEach-Object { (Resolve-Path -Relative $_.FullName) -replace '^\.\\', '' })
$sources += (Get-ChildItem 'build\gen' -Recurse -Filter '*.java' | ForEach-Object { (Resolve-Path -Relative $_.FullName) -replace '^\.\\', '' })
$sources += (Get-ChildItem 'build\gen-config' -Recurse -Filter '*.java' | ForEach-Object { (Resolve-Path -Relative $_.FullName) -replace '^\.\\', '' })
Write-Host "  源文件 $($sources.Count) 个"
# -encoding UTF-8 is load-bearing: these sources are UTF-8 without a BOM, and
# javac otherwise decodes them with the machine's legacy code page, turning every
# Chinese comment into mojibake and failing on bytes that are not valid there.
& $javac -source 8 -target 8 -nowarn -Xlint:-options -encoding UTF-8 -classpath $androidJar -d 'build\classes' $sources
if ($LASTEXITCODE -ne 0) { Fail 'javac' }

# ---- dex --------------------------------------------------------------------

Step 7 '转成 dex（d8）'
$classes = (Get-ChildItem 'build\classes' -Recurse -Filter '*.class' | ForEach-Object { (Resolve-Path -Relative $_.FullName) -replace '^\.\\', '' })
& $d8 --lib $androidJar --min-api 24 --output 'build\dex' $classes
if ($LASTEXITCODE -ne 0) { Fail 'd8' }
if (-not (Test-Path 'build\dex\classes.dex')) { Fail 'd8 没有产出 classes.dex' }
Write-Host "  classes.dex: $((Get-Item 'build\dex\classes.dex').Length) 字节"

# ---- assemble ---------------------------------------------------------------

Step 8 '组装 APK（把 classes.dex 放进 aapt2 产出的包）'

# Done in Node rather than with a .NET/zip library, because the compression
# method of each entry has to survive: resources.arsc must stay STORED or an app
# targeting API 30+ is refused at install time, and .NET's
# CompressionLevel.NoCompression deflates at level 0 instead of storing. See
# tools/pack.mjs, which reads the method from the source and preserves it.
& node 'tools\pack.mjs' 'build\base.apk' 'build\dex\classes.dex' 'build\unsigned.apk'
if ($LASTEXITCODE -ne 0) { Fail 'pack' }
Write-Host "  unsigned.apk: $((Get-Item 'build\unsigned.apk').Length) 字节"

Step 9 '对齐（zipalign -f 4，必须在签名之前）'
& $zipalign -f 4 'build\unsigned.apk' 'build\aligned.apk'
if ($LASTEXITCODE -ne 0) { Fail 'zipalign' }

# ---- sign -------------------------------------------------------------------

Step 10 '签名（apksigner）'

$keystore = 'keystore\pulse-release.jks'
$storePass = if ($env:PULSE_STORE_PASS) { $env:PULSE_STORE_PASS } else { 'CHANGE_ME' }
$alias = 'pulse'
if (-not (Test-Path $keystore)) {
  New-Item -ItemType Directory -Force -Path 'keystore' | Out-Null
  Write-Host '  第一次构建，生成自签名密钥库（这个文件要留着，否则无法覆盖升级）'
  & $keytool -genkeypair -v `
    -keystore $keystore `
    -alias $alias `
    -keyalg RSA -keysize 2048 -validity 10950 `
    -storepass $storePass -keypass $storePass `
    -dname 'CN=Pulse Remote, OU=self-signed, O=personal, C=CN'
  if ($LASTEXITCODE -ne 0) { Fail 'keytool' }
}

$outApk = 'dist\pulse-remote.apk'
& $apksigner sign `
  --ks $keystore `
  --ks-key-alias $alias `
  --ks-pass "pass:$storePass" `
  --key-pass "pass:$storePass" `
  --out $outApk `
  'build\aligned.apk'
if ($LASTEXITCODE -ne 0) { Fail 'apksigner sign' }

Step 11 '校验签名'
& $apksigner verify --verbose --print-certs $outApk
if ($LASTEXITCODE -ne 0) { Fail 'apksigner verify' }

$apk = Get-Item $outApk
Write-Host ''
Write-Host "APK 已生成：$($apk.FullName)" -ForegroundColor Green
Write-Host ("  大小     : {0:N2} MB" -f ($apk.Length / 1MB))
Write-Host "  指向     : $BaseUrl"
Write-Host "  证书指纹 : $pin"
Write-Host ''
Write-Host '装到手机（USB 调试已开）：'
Write-Host "  adb install -r `"$($apk.FullName)`""
Write-Host '或把 dist\pulse-remote.apk 传到手机，用文件管理器点开安装。'

}
finally {
  Pop-Location
}
