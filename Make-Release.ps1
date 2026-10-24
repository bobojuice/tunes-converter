# Builds the launcher and zips a portable release into dist\.
# By default ffmpeg is NOT included; users add it themselves (docs\HOWTO.md).
# -IncludeFfmpeg bundles bin\ffmpeg.exe and bin\ffprobe.exe (GPL v3 build, see THIRD-PARTY-NOTICES.md).
param([switch]$IncludeFfmpeg)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
& (Join-Path $root 'Build.ps1')

$version = (Get-Content -LiteralPath (Join-Path $root 'VERSION')).Trim()
$name = "TunesConverter-v$version"
$stage = Join-Path $root "dist\$name"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'bin') | Out-Null

foreach ($f in 'TunesConverter.exe', 'TunesConverter.ps1', 'TunesConverter.ico', 'Get-FFmpeg.ps1', 'settings.example.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md') {
    Copy-Item -LiteralPath (Join-Path $root $f) -Destination $stage
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'docs') | Out-Null
foreach ($f in 'HOWTO.md', 'screenshot.png') { Copy-Item -LiteralPath (Join-Path $root "docs\$f") -Destination (Join-Path $stage 'docs') }

$tools = 'ffmpeg.exe', 'ffprobe.exe'
$haveTools = $IncludeFfmpeg -and -not ($tools | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root "bin\$_")) })
if ($haveTools) {
    foreach ($t in $tools) { Copy-Item -LiteralPath (Join-Path $root "bin\$t") -Destination (Join-Path $stage 'bin') }
} else {
    Copy-Item -LiteralPath (Join-Path $root 'bin\README.txt') -Destination (Join-Path $stage 'bin')
    Write-Host 'ffmpeg not bundled (users add it themselves).'
}

$zip = Join-Path $root "dist\$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Write-Host ("Created {0} ({1:N0} MB)" -f $zip, ((Get-Item -LiteralPath $zip).Length / 1MB))
