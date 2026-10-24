# Compiles src\Launcher.cs into TunesConverter.exe using the C# compiler that ships with Windows.
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $csc)) { throw 'C# compiler (csc.exe) not found.' }

& $csc /nologo /target:winexe /out:"$PSScriptRoot\TunesConverter.exe" /win32icon:"$PSScriptRoot\TunesConverter.ico" "$PSScriptRoot\src\Launcher.cs"
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host 'Built TunesConverter.exe'
