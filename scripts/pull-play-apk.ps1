# Pull installed EGWallet APK(s) from a USB-connected Android device and compare
# index.android.bundle SHA256 to the EAS production AAB artifact.
#
# Prerequisites:
#   - USB debugging enabled on phone
#   - adb in PATH or Android SDK platform-tools
#
# Usage:
#   .\scripts\pull-play-apk.ps1
#   .\scripts\pull-play-apk.ps1 -PackageId com.francisco1953.egwalletmobile -ExpectedSha256 f102c6d3edd75122d0bc8f8f8fb18c91aad7f6d04300aa04b6bf9b07ff6a1481

param(
  [string]$PackageId = 'com.francisco1953.egwalletmobile',
  [string]$ExpectedSha256 = 'f102c6d3edd75122d0bc8f8f8fb18c91aad7f6d04300aa04b6bf9b07ff6a1481',
  [string]$OutDir = "$env:TEMP\egwallet-play-pull"
)

$adb = @(
  "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
  "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $adb) {
  Write-Error 'adb not found. Install Android SDK platform-tools.'
  exit 1
}

$devices = & $adb devices | Select-String 'device$'
if (-not $devices) {
  Write-Error 'No Android device connected. Enable USB debugging and reconnect.'
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "Package: $PackageId"
& $adb shell dumpsys package $PackageId | Select-String -Pattern 'versionCode|versionName' | Select-Object -First 4

$paths = & $adb shell pm path $PackageId
if (-not $paths) {
  Write-Error "Package not installed: $PackageId"
  exit 1
}

$i = 0
foreach ($line in $paths) {
  if ($line -match 'package:(.+)') {
    $remote = $Matches[1].Trim()
    $local = Join-Path $OutDir ("split_{0}.apk" -f $i)
    Write-Host "Pulling $remote"
    & $adb pull $remote $local | Out-Null
    $i++
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-BundleSha256($apkPath) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($apkPath)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -like '*index.android.bundle' } | Select-Object -First 1
    if (-not $entry) { return $null }
    $stream = $entry.Open()
    try {
      $sha = [System.Security.Cryptography.SHA256]::Create()
      $hash = $sha.ComputeHash($stream)
      return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
    } finally { $stream.Dispose() }
  } finally { $zip.Dispose() }
}

Write-Host "`n=== Bundle SHA256 on device ==="
Get-ChildItem $OutDir -Filter '*.apk' | ForEach-Object {
  $sha = Get-BundleSha256 $_.FullName
  $match = if ($sha -eq $ExpectedSha256) { 'MATCH v72 EAS artifact' } else { 'MISMATCH - not v72 bundle' }
  Write-Host "$($_.Name): $sha ($match)"
}

Write-Host "`nPulled APKs saved to: $OutDir"
