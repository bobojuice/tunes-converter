# OPTIONAL helper. Downloads ffmpeg.exe and ffprobe.exe into .\bin (about 100 MB).
# You do not need this if you already have ffmpeg on your PATH or put the two files in .\bin yourself.
# Source: https://www.gyan.dev/ffmpeg/builds/ (release "essentials" build, GPL v3). The download is checked
# against the SHA-256 that site publishes. Nothing is installed; it only copies two files into .\bin.
# Use -DryRun to see what it would do without downloading anything.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$bin     = Join-Path $PSScriptRoot 'bin'
$url     = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$hashUrl = $url + '.sha256'

if ((Test-Path -LiteralPath (Join-Path $bin 'ffmpeg.exe')) -and (Test-Path -LiteralPath (Join-Path $bin 'ffprobe.exe'))) {
    Write-Host 'ffmpeg.exe and ffprobe.exe are already in the bin folder. Nothing to do.'
    return
}
if ($DryRun) {
    Write-Host "Would download: $url"
    Write-Host "Would verify against: $hashUrl"
    Write-Host "Would copy ffmpeg.exe and ffprobe.exe to: $bin"
    return
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('tunesconverter-ffmpeg-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp 'ffmpeg.zip'
    Write-Host 'Downloading ffmpeg (about 100 MB), please wait...'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

    $raw = (Invoke-WebRequest -Uri $hashUrl -UseBasicParsing).Content
    if ($raw -is [byte[]]) { $raw = [Text.Encoding]::ASCII.GetString($raw) }
    $expected = ([string]$raw).Trim().Split()[0]
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    if ($actual -ine $expected) { throw "Checksum mismatch (expected $expected, got $actual). Download discarded." }
    Write-Host 'Checksum OK.'

    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($name in 'ffmpeg.exe', 'ffprobe.exe') {
            $entry = $archive.Entries | Where-Object { $_.FullName -match "/bin/$([regex]::Escape($name))$" } | Select-Object -First 1
            if (-not $entry) { throw "$name was not found in the download." }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $bin $name), $true)
        }
    } finally { $archive.Dispose() }
    Write-Host "Done. ffmpeg.exe and ffprobe.exe are in: $bin"
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
