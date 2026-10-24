# Builds the launcher and zips a portable release into dist\.
# If bin\ffmpeg.exe and bin\ffprobe.exe are present they are included (see THIRD-PARTY-NOTICES.md).
# Use -NoFfmpeg for a small zip; users then add the two files to bin\ themselves.
param([switch]$NoFfmpeg)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
& (Join-Path $root 'Build.ps1')

$version = (Get-Content -LiteralPath (Join-Path $root 'VERSION')).Trim()
$name = "TunesConverter-v$version"
$stage = Join-Path $root "dist\$name"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'bin') | Out-Null

foreach ($f in 'TunesConverter.exe', 'TunesConverter.ps1', 'TunesConverter.ico', 'settings.example.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md') {
    Copy-Item -LiteralPath (Join-Path $root $f) -Destination $stage
}

$tools = 'ffmpeg.exe', 'ffprobe.exe'
$haveTools = -not $NoFfmpeg -and -not ($tools | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root "bin\$_")) })
if ($haveTools) {
    foreach ($t in $tools) { Copy-Item -LiteralPath (Join-Path $root "bin\$t") -Destination (Join-Path $stage 'bin') }
} else {
    Copy-Item -LiteralPath (Join-Path $root 'bin\README.txt') -Destination (Join-Path $stage 'bin')
    Write-Warning 'ffmpeg not bundled: users must add ffmpeg.exe and ffprobe.exe to bin\.'
}

$zip = Join-Path $root "dist\$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Write-Host ("Created {0} ({1:N0} MB)" -f $zip, ((Get-Item -LiteralPath $zip).Length / 1MB))
