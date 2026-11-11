<#
.SYNOPSIS
    Assemble the DSH Phone Gateway APK with the raw Android SDK tools.

.DESCRIPTION
    No Gradle: none is installed here and the package registry is unreachable.
    This reproduces what Gradle would do, using the pieces the SDK ships:

        javac -> jar -> d8 -> aapt2 compile/link -> aapt add -> zipalign
              -> keytool (once) -> apksigner

    Every step below was verified end to end before this script was written; the
    notes in ../AGENTS.md record why each workaround exists.

.PARAMETER Clean
    Delete build output before compiling.

.PARAMETER Install
    After a successful build, install onto the connected device with adb.

.EXAMPLE
    pwsh -File build.ps1 -Clean
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---- toolchain ------------------------------------------------------------
# Override any of these with an environment variable of the same name.
$SdkRoot    = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { 'D:\A\Android\Sdk' }
$BuildTools = if ($env:ANDROID_BUILD_TOOLS) { $env:ANDROID_BUILD_TOOLS } else { '36.0.0' }
$Platform   = if ($env:ANDROID_PLATFORM) { $env:ANDROID_PLATFORM } else { 'android-37.0' }
# d8 and apksigner are class-file 55+; the JDK on PATH here is a JRE 8 and fails.
$JdkHome    = if ($env:DSH_APP_JDK) { $env:DSH_APP_JDK } else { 'D:\A\Android\Android Studio\jbr' }

$BtDir   = Join-Path $SdkRoot "build-tools\$BuildTools"
$Jar     = Join-Path $SdkRoot "platforms\$Platform\android.jar"
$Java    = Join-Path $JdkHome 'bin\java.exe'
$Javac   = Join-Path $JdkHome 'bin\javac.exe'
$JarTool = Join-Path $JdkHome 'bin\jar.exe'
$Keytool = Join-Path $JdkHome 'bin\keytool.exe'

$ProjectRoot = Split-Path -Parent $PSCommandPath
$ProjectDir  = Split-Path -Parent $ProjectRoot
$BuildDir    = Join-Path $ProjectDir 'build'
$OutApk      = Join-Path $BuildDir 'dsh-phone-gateway.apk'
$Keystore    = Join-Path $BuildDir 'dsh-phone-gateway.keystore'
# Password lives in a gitignored file so it is never published. Falls back to the
# historical value for a checkout that predates that file.
$secretsFile = Join-Path $ProjectDir '..\.secrets.local'
if (-not (Test-Path -LiteralPath $secretsFile)) {
    throw 'missing ..\.secrets.local - it holds the keystore password and must never be committed. Create it with one line containing the password.'
}
$StorePass   = (Get-Content -LiteralPath $secretsFile -Raw).Trim()
$KeyAlias    = 'dsh-phone-gateway'

function Assert-Tool([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "missing $Name at $Path (set the matching environment variable to override)"
    }
}

function Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

# Preflight: fail loudly before writing anything.
Assert-Tool $Javac   'javac'
Assert-Tool $Java    'java'
Assert-Tool $JarTool 'jar'
Assert-Tool $Keytool 'keytool'
Assert-Tool $Jar     'android.jar'
Assert-Tool (Join-Path $BtDir 'aapt2.exe')    'aapt2'
Assert-Tool (Join-Path $BtDir 'aapt.exe')     'aapt'
Assert-Tool (Join-Path $BtDir 'zipalign.exe') 'zipalign'
Assert-Tool (Join-Path $BtDir 'lib\d8.jar')   'd8.jar'

if ($Clean) {
    # Only the generated artefacts, never the directory: build/ also holds this
    # script, and deleting the tree it runs from fails with "in use".
    foreach ($artifact in @('classes', 'dex', 'res', 'gen', 'classes.jar', 'unaligned.apk', 'aligned.apk', 'dsh-phone-gateway.apk')) {
        $path = Join-Path $BuildDir $artifact
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
}
foreach ($dir in @('classes', 'dex', 'res', 'gen')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $BuildDir $dir) | Out-Null
}

# ---- 1. icons -------------------------------------------------------------
Step 'launcher icons'
$Python = Join-Path $env:DSH_PYTHON_ROOT 'python.exe'
if (Test-Path -LiteralPath (Join-Path $ProjectDir 'make_icons.py')) {
    if ($env:DSH_PYTHON_ROOT -and (Test-Path -LiteralPath $Python)) {
        & $Python (Join-Path $ProjectDir 'make_icons.py') | Out-Null
        Write-Host '    regenerated from make_icons.py'
    } else {
        Write-Host '    using committed PNGs (set DSH_PYTHON_ROOT to regenerate)'
    }
}

# ---- 2. java -> class -----------------------------------------------------
Step 'javac'
$sources = Get-ChildItem -Path (Join-Path $ProjectDir 'src') -Recurse -Filter '*.java' |
    ForEach-Object { $_.FullName }
if ($sources.Count -eq 0) { throw 'no java sources found under src/' }

$classDir = Join-Path $BuildDir 'classes'
# -cp only: android.jar is api 37 while --release pins the language level, so
# neither -bootclasspath (removed in JDK 25) nor a bare -source works.
& $Javac --release 17 -encoding UTF-8 -cp $Jar -d $classDir @sources
if ($LASTEXITCODE -ne 0) { throw "javac failed with $LASTEXITCODE" }

# ---- 3. class -> jar ------------------------------------------------------
# d8 receives ONE jar path: passing many "D:\..." arguments trips PowerShell's
# colon handling when it forwards to a native command.
Step 'jar'
$classesJar = Join-Path $BuildDir 'classes.jar'
if (Test-Path -LiteralPath $classesJar) { Remove-Item -LiteralPath $classesJar -Force }
& $JarTool --create --file $classesJar -C $classDir .
if ($LASTEXITCODE -ne 0) { throw "jar failed with $LASTEXITCODE" }

# ---- 4. jar -> dex --------------------------------------------------------
# d8.bat resolves java from PATH (a JRE 8 here) and cannot run d8; invoke the
# jar's main class directly.
Step 'd8'
$dexDir = Join-Path $BuildDir 'dex'
& $Java -Xmx1g -cp (Join-Path $BtDir 'lib\d8.jar') com.android.tools.r8.D8 `
    --lib $Jar --min-api 24 --output $dexDir $classesJar
if ($LASTEXITCODE -ne 0) { throw "d8 failed with $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath (Join-Path $dexDir 'classes.dex'))) {
    throw 'd8 produced no classes.dex'
}

# ---- 5. resources + manifest ---------------------------------------------
# --auto-add-overlay: our string resource is new to the table, and link
# otherwise refuses it as an overlay that overrides nothing.
Step 'aapt2 compile'
$aapt2   = Join-Path $BtDir 'aapt2.exe'
$resDir  = Join-Path $ProjectDir 'res'
$resOut  = Join-Path $BuildDir 'res'
$compiled = Join-Path $resOut 'compiled.zip'
& $aapt2 compile --dir $resDir -o $compiled
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed with $LASTEXITCODE" }

Step 'aapt2 link'
$unaligned = Join-Path $BuildDir 'unaligned.apk'
& $aapt2 link -o $unaligned -I $Jar `
    --manifest (Join-Path $ProjectDir 'AndroidManifest.xml') `
    -R $compiled `
    --auto-add-overlay `
    --min-sdk-version 24 --target-sdk-version 34
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed with $LASTEXITCODE" }

# ---- 6. dex into the archive ---------------------------------------------
# `aapt add` writes the entry into the existing zip, which is what an APK needs.
Step 'aapt add classes.dex'
Push-Location -LiteralPath $dexDir
try {
    & (Join-Path $BtDir 'aapt.exe') add $unaligned 'classes.dex'
    if ($LASTEXITCODE -ne 0) { throw "aapt add failed with $LASTEXITCODE" }
} finally {
    Pop-Location
}

# ---- 7. align -------------------------------------------------------------
Step 'zipalign'
$aligned = Join-Path $BuildDir 'aligned.apk'
& (Join-Path $BtDir 'zipalign.exe') -f -p 4 $unaligned $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign failed with $LASTEXITCODE" }

# ---- 8. sign --------------------------------------------------------------
# A self-signed key is enough for sideloading; there is no Play Store here.
if (-not (Test-Path -LiteralPath $Keystore)) {
    Step 'keytool (first run)'
    & $Keytool -genkeypair -v -keystore $Keystore -storepass $StorePass -keypass $StorePass `
        -alias $KeyAlias -keyalg RSA -keysize 2048 -validity 10000 `
        -dname 'CN=DSH Phone Gateway, OU=Gateway, O=DSH, L=Local, ST=Local, C=CN'
    if ($LASTEXITCODE -ne 0) { throw "keytool failed with $LASTEXITCODE" }
}

Step 'apksigner'
$env:JAVA_HOME = $JdkHome
$apksigner = Join-Path $BtDir 'apksigner.bat'
& $apksigner sign --ks $Keystore --ks-pass "pass:$StorePass" --key-pass "pass:$StorePass" `
    --out $OutApk $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed with $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $OutApk)) { throw "apksigner produced no APK at $OutApk" }

# apksigner writes JVM warnings to stderr; under $ErrorActionPreference='Stop'
# PowerShell raises those as terminating errors even though the exit code is 0.
# Capture at the process level and judge by exit code and the "Verifies" line.
$verifyOutput = & cmd.exe /c "`"$apksigner`" verify --verbose `"$OutApk`" 2>&1"
$verifyExit = $LASTEXITCODE
$verifyText = ($verifyOutput | Out-String)
if ($verifyExit -ne 0) { throw "apksigner verify failed with $verifyExit`n$verifyText" }
if ($verifyText -notmatch 'Verifies') { throw "apksigner verify did not confirm the signature`n$verifyText" }
Write-Host ('    ' + (($verifyText -split "`r?`n" | Where-Object { $_ -match 'Verified using v\d' }) -join "`n    "))

$info = Get-Item -LiteralPath $OutApk
Write-Host ''
Write-Host ("APK  {0}" -f $info.FullName) -ForegroundColor Green
Write-Host ("     {0:N0} bytes  signed  aligned" -f $info.Length) -ForegroundColor Green

# ---- 9. publish into the gateway so a phone can download it ---------------
# The gateway serves the installer BEFORE pairing (the app keeps its own cookie
# jar), so the file lives inside the plugin package and is refreshed here.
# The signing keystore is deliberately NOT copied: shipping it would let anyone
# sign an update to "this app".
Step 'publish to dsh-phone-gateway/assets'
$assetsDir = Join-Path (Split-Path $ProjectDir -Parent) 'dsh-phone-gateway\assets'
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
$publishedApk = Join-Path $assetsDir 'dsh-phone-gateway.apk'
Copy-Item -LiteralPath $OutApk -Destination $publishedApk -Force

# Metadata lets the UI show the version without parsing the APK's binary XML.
$manifest = Get-Content -LiteralPath (Join-Path $ProjectDir 'AndroidManifest.xml') -Raw
$versionName = if ($manifest -match 'android:versionName="([^"]+)"') { $matches[1] } else { '0.0.0' }
$meta = [ordered]@{
    version = $versionName
    builtAt = (Get-Item -LiteralPath $publishedApk).LastWriteTime.ToUniversalTime().ToString('o')
    size    = (Get-Item -LiteralPath $publishedApk).Length
}
$metaPath = Join-Path $assetsDir 'app.json'
[System.IO.File]::WriteAllText($metaPath, ($meta | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
Write-Host ("     {0}  ({1:N0} bytes)" -f $publishedApk, $meta.size) -ForegroundColor Green
Write-Host ("     download: http://<this-computer>:8791/__lan/app") -ForegroundColor Green

if ($Install) {
    Step 'adb install'
    $adb = Join-Path $SdkRoot 'platform-tools\adb.exe'
    if (-not (Test-Path -LiteralPath $adb)) { throw "adb not found at $adb" }
    & $adb install -r $OutApk
    if ($LASTEXITCODE -ne 0) { throw "adb install failed with $LASTEXITCODE" }
    & $adb shell am start -n 'com.dsh.lan/.MainActivity'
}

# Intermediates come back on the next run, so leaving them behind only makes the tree
# look unfinished — `classes/` alone is a dozen files. The signed APK and the keystore
# are the only artefacts worth keeping beside this script.
Step 'clean intermediates'
foreach ($artifact in @('classes', 'dex', 'res', 'gen', 'classes.jar', 'unaligned.apk', 'aligned.apk', 'dsh-phone-gateway.apk.idsig')) {
    $path = Join-Path $BuildDir $artifact
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-Host '     kept: dsh-phone-gateway.apk, dsh-phone-gateway.keystore' -ForegroundColor DarkGray