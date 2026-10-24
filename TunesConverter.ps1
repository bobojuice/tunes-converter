# Tunes Converter: converts a folder of music to MP3 320 kbps with correct "Artist - Title" names.
# Merges multi-value artist tags ("A" + "B" -> "A, B"), keeps cover art, never touches the originals.
# Optional quality check: measures where the audio's high end really stops to spot fake 320/lossless files.
# Portable: ffmpeg/ffprobe live in .\bin next to this file. Start it with TunesConverter.exe.
# Works in Windows PowerShell 5.1 and PowerShell 7. Keep this file ASCII-only (5.1 reads it as ANSI).
# Headless test: powershell -File TunesConverter.ps1 -NoGui -In <folder> -Out <folder>
param([switch]$NoGui, [string]$In, [string]$Out)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$AppDir       = $PSScriptRoot
$SettingsFile = Join-Path $AppDir 'settings.json'
$LogFile      = Join-Path $AppDir 'last-run.log'
$Extensions   = '.flac', '.wav', '.aiff', '.aif', '.m4a', '.ogg', '.opus', '.wma', '.mp3'

function Find-Tool([string]$n) {
    $local = Join-Path (Join-Path $AppDir 'bin') "$n.exe"
    if (Test-Path -LiteralPath $local) { return $local }
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
}
$Ffmpeg  = Find-Tool 'ffmpeg'
$Ffprobe = Find-Tool 'ffprobe'

$script:Gui    = -not $NoGui
$script:Cancel = $false
$script:Proc   = $null
$script:Ratio  = 0.0

# Palette (matches the Design canvas)
function C([string]$hex) { [Drawing.ColorTranslator]::FromHtml($hex) }
$Bg = C '#0f1115'; $Card = C '#171a21'; $Field = C '#1f232b'; $Border = C '#262b35'; $FieldBorder = C '#2a2f3a'
$Ink = C '#e8eaee'; $Muted = C '#8a919e'; $ChipInk = C '#a7aebb'
$Accent = C '#2fbf71'; $AccentHover = C '#3bd682'; $AccentDark = C '#0b1a12'
$Ghost = C '#262b35'; $GhostHover = C '#303644'; $GhostOff = C '#1a1e25'; $GhostOffText = C '#5f636a'
$Green = C '#3ddc84'; $Amber = C '#f0b95a'; $Red = C '#ff8585'

function Append-Log([string]$s, $color) {
    $txtLog.SelectionStart = $txtLog.TextLength
    $txtLog.SelectionColor = $color
    $txtLog.AppendText($s)
}

function Show-Log {
    if (-not $txtLog.Visible) { $lblEmpty.Visible = $false; $txtLog.Visible = $true }
}

function Log([string]$text) {
    Add-Content -LiteralPath $LogFile -Value $text -Encoding UTF8
    if (-not $script:Gui) { Write-Host $text; return }
    Show-Log
    $color = if ($text -match '^ERROR') { $Red } elseif ($text -match '^Done') { $Ink } else { $Muted }
    Append-Log ($text + "`n") $color
    $txtLog.ScrollToCaret()
    [Windows.Forms.Application]::DoEvents()
}

function Log-Result([string]$status, [string]$name, [string]$note) {
    $line = '{0,-6}{1}  {2}' -f $status, $name, $note
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    if (-not $script:Gui) { Write-Host $line; return }
    Show-Log
    $col = switch ($status) { 'OK' { $Green } 'SKIP' { $Amber } 'WARN' { $Amber } 'LOW' { $Amber } default { $Red } }
    Append-Log ('{0,-6}' -f $status) $col
    Append-Log $name $Ink
    Append-Log ("  $note`n") $Muted
    $txtLog.ScrollToCaret()
    [Windows.Forms.Application]::DoEvents()
}

function Set-Progress([double]$value, [double]$max) {
    $script:Ratio = if ($max -gt 0) { $value / $max } else { 0 }
    $fill.Width = [int]($track.Width * $script:Ratio)
}

function Q([string]$s) {
    # Windows command-line quoting: double backslashes that precede a quote or the closing quote
    $s = [regex]::Replace($s, '(\\*)"', '$1$1\"')
    $s = [regex]::Replace($s, '(\\+)$', '$1$1')
    '"' + $s + '"'
}

function Run-Proc([string]$exe, [string]$argLine) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $exe; $psi.Arguments = $argLine
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $p = [Diagnostics.Process]::Start($psi)
    $script:Proc = $p
    try {
        $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
        while (-not $p.WaitForExit(100)) {
            [Windows.Forms.Application]::DoEvents()
            if ($script:Cancel) { try { $p.Kill() } catch {} }
        }
        $p.WaitForExit()
        [pscustomobject]@{ Code = $p.ExitCode; Out = $o.Result; Err = $e.Result }
    } finally {
        $script:Proc = $null
        $p.Dispose()
    }
}

# ---- Quality check: where does the audio's high end stop? ----
# A lossy file (or a lossless file made from one) has a hard lowpass whose frequency betrays the real bitrate.
# Calibrated against LAME encodes of a lossless track (cutoff by bitrate): 128k ~16.8 kHz, 160k ~17.6, 192k ~18.9,
# 224k/256k ~19.6, 320k ~20.3 kHz, lossless ~22 kHz. It is an estimate, not proof.
function Ensure-SpecCheck {
    if ('SpecCheck' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;

public static class SpecCheck {
    const int N = 4096;

    // Highest frequency (Hz) that still carries real signal; -1 when there is not enough audio.
    // raw = interleaved float32 samples. Each channel is analysed on its own and the loudest result per frequency
    // is kept, so opposite-phase stereo cannot hide anything. The threshold is relative to the track's own
    // level, so a quiet copy of a track gives the same answer as the loud one.
    public static double Cutoff(byte[] raw, int byteCount, int sampleRate, int channels) {
        if (channels < 1) channels = 1;
        int total = byteCount / (4 * channels);
        if (total < N * 12) return -1;

        double[] win = new double[N];
        double winSum = 0;
        for (int i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (N - 1)); winSum += win[i]; }
        double norm = winSum / 2.0;

        int lo = (int)(total * 0.03), hi = (int)(total * 0.97) - N;
        int maxFrames = 240;
        int step = Math.Max(N / 2, (hi - lo) / maxFrames);
        int bins = N / 2 + 1;
        List<float[]> frames = new List<float[]>();
        double[] re = new double[N], im = new double[N];
        for (int pos = lo; pos <= hi && frames.Count < maxFrames; pos += step) {
            double loud = 0;
            for (int c = 0; c < channels; c++) {
                double e = 0;
                for (int i = 0; i < N; i++) { double s = Sample(raw, pos + i, c, channels); e += s * s; }
                loud = Math.Max(loud, Math.Sqrt(e / N));
            }
            if (loud < 0.005) continue;
            float[] lv = new float[bins];
            for (int b = 0; b < bins; b++) lv[b] = -300f;
            for (int c = 0; c < channels; c++) {
                for (int i = 0; i < N; i++) { re[i] = Sample(raw, pos + i, c, channels) * win[i]; im[i] = 0; }
                Fft(re, im);
                for (int b = 0; b < bins; b++) {
                    double mag = Math.Sqrt(re[b] * re[b] + im[b] * im[b]) / norm;
                    float db = (float)(20 * Math.Log10(mag + 1e-12));
                    if (db > lv[b]) lv[b] = db;
                }
            }
            frames.Add(lv);
        }
        if (frames.Count < 8) return -1;

        float[] p = new float[bins];
        float[] col = new float[frames.Count];
        int idx = (int)(0.9 * (frames.Count - 1));
        for (int b = 0; b < bins; b++) {
            for (int f = 0; f < frames.Count; f++) col[f] = frames[f][b];
            Array.Sort(col);
            p[b] = col[idx];
        }
        float[] sm = new float[bins];
        int w = 12;
        for (int b = 0; b < bins; b++) {
            int a = Math.Max(0, b - w), c2 = Math.Min(bins - 1, b + w);
            double sum = 0;
            for (int k = a; k <= c2; k++) sum += p[k];
            sm[b] = (float)(sum / (c2 - a + 1));
        }

        // Reference level = the track's own mid-band level (1-8 kHz); signal must stay within 65 dB of it.
        int r0 = (int)(1000.0 * N / sampleRate), r1 = Math.Min(bins - 1, (int)(8000.0 * N / sampleRate));
        double refSum = 0;
        for (int b = r0; b <= r1; b++) refSum += sm[b];
        double reference = refSum / (r1 - r0 + 1);
        double threshold = Math.Min(-90.0, Math.Max(-118.0, reference - 65.0));

        for (int b = bins - 1; b > 0; b--) {
            if (sm[b] > threshold) return b * (double)sampleRate / N;
        }
        return 0;
    }

    static double Sample(byte[] raw, int index, int channel, int channels) {
        return BitConverter.ToSingle(raw, (index * channels + channel) * 4);
    }

    static void Fft(double[] re, double[] im) {
        int n = re.Length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2 * Math.PI / len;
            double wr = Math.Cos(ang), wi = Math.Sin(ang);
            for (int i = 0; i < n; i += len) {
                double cr = 1, ci = 0;
                for (int k = 0; k < len / 2; k++) {
                    int u = i + k, v = i + k + len / 2;
                    double tr = re[v] * cr - im[v] * ci, ti = re[v] * ci + im[v] * cr;
                    re[v] = re[u] - tr; im[v] = im[u] - ti;
                    re[u] += tr; im[u] += ti;
                    double ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
                }
            }
        }
    }
}
'@
}

# Returns the cutoff in Hz, -1 (too short or quiet), -2 (could not decode) or $null (cancelled).
function Measure-Cutoff([string]$path, [int]$sampleRate, [double]$duration, [int]$channels) {
    Ensure-SpecCheck
    $inv = [Globalization.CultureInfo]::InvariantCulture
    # Always bound the decode: a 3-minute slice from the middle, or the first 4 minutes when the length is unknown.
    $limit = ''
    if ($duration -gt 240) { $limit = [string]::Format($inv, '-ss {0:0.0} -t 180 ', [Math]::Max(0, $duration / 2 - 90)) }
    elseif (-not ($duration -gt 0)) { $limit = '-t 240 ' }
    $ch = [Math]::Max(1, [Math]::Min($channels, 2))
    $rate = [Math]::Min($sampleRate, 48000)
    $resample = if ($sampleRate -gt 48000) { '-ar 48000 ' } else { '' }
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Ffmpeg
    $psi.Arguments = '-v error ' + $limit + '-i ' + (Q $path) + ' -map 0:a:0 -vn -ac ' + $ch + ' ' + $resample + '-f f32le -'
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $p = [Diagnostics.Process]::Start($psi)
    $script:Proc = $p
    $ms = New-Object IO.MemoryStream
    $ok = $false
    try {
        $copy = $p.StandardOutput.BaseStream.CopyToAsync($ms)
        $err = $p.StandardError.ReadToEndAsync()
        while (-not $copy.IsCompleted) {
            [Windows.Forms.Application]::DoEvents()
            if ($script:Cancel) { try { $p.Kill() } catch {} }
            Start-Sleep -Milliseconds 20
        }
        $p.WaitForExit()
        $copy.Wait()
        $ok = ($p.ExitCode -eq 0)
    } catch { $ok = $false }
    finally { $script:Proc = $null; $p.Dispose() }
    if ($script:Cancel) { return $null }
    if (-not $ok -or $ms.Length -eq 0) { return -2 }
    [SpecCheck]::Cutoff($ms.GetBuffer(), [int]$ms.Length, $rate, $ch)
}

function Test-Quality($file, $audio, $j) {
    $none = @{ Low = $false; Msg = '' }
    $sr = [int]$audio.sample_rate
    if ($sr -lt 44100) { return $none }
    $cut = Measure-Cutoff $file.FullName $sr ([double]$j.format.duration) ([int]$audio.channels)
    if ($null -eq $cut) { return $none }
    if ($cut -eq -2) { return @{ Low = $false; Msg = 'quality not checked (could not decode the audio)' } }
    if ($cut -lt 0) { return @{ Low = $false; Msg = 'quality not checked (too short or quiet)' } }
    $est = if ($cut -ge 19950) { 320 } elseif ($cut -ge 19250) { 256 } elseif ($cut -ge 18250) { 192 } elseif ($cut -ge 17200) { 160 } else { 128 }
    $label = switch ($est) { 320 { '320k or better' } 256 { '~224-256k' } 192 { '~192k' } 160 { '~160k' } default { '~128k or lower' } }
    $khz = '{0:N1}' -f ($cut / 1000)
    $lossless = $audio.codec_name -match '^(flac|alac|pcm_|wavpack|ape|tta)'
    $claim = if ($lossless) { 'claims lossless' } elseif ($audio.bit_rate) { 'says ' + [int]([double]$audio.bit_rate / 1000) + 'k' } else { '' }
    if ($est -lt $script:QMin) {
        # Fake = the file claims more than its spectrum supports; otherwise it is honest but below your minimum.
        $claimedK = if ($audio.bit_rate) { [double]$audio.bit_rate / 1000 } else { 0 }
        if ($lossless -or $claimedK -gt $est * 1.15) {
            $lead = if ($claim) { "$claim but " } else { '' }
            return @{ Low = $true; Kind = 'FAKE'; Msg = "fakin' the funk: ${lead}looks like $label (cutoff $khz kHz)" }
        }
        return @{ Low = $true; Kind = 'LOW'; Msg = "below your $($script:QMin)k minimum: looks like $label (cutoff $khz kHz)" }
    }
    $msg = "source ok: $label (cutoff $khz kHz)"
    if ($lossless -and $cut -lt 20800) { $msg += ', but a lossless file this band-limited was probably made from a lossy one' }
    @{ Low = $false; Msg = $msg }
}

function Get-Tag($tags, [string]$name) {
    if (-not $tags) { return $null }
    foreach ($p in $tags.PSObject.Properties) { if ($p.Name -ieq $name) { return [string]$p.Value } }
}

function Join-Artists([string]$v) {
    if (-not $v) { return '' }
    (($v -split ';') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ', '
}

function Safe-Name([string]$s) {
    $s = $s -replace '[\\/:*?"<>|]', '-' -replace '[\x00-\x1f]', ''
    ($s -replace '\s+', ' ').Trim().TrimEnd('.', ' ')
}

function Convert-One($file, [string]$outDir) {
    if ($script:Cancel) { return @{ Status = 'STOP' } }
    $pr = Run-Proc $Ffprobe ('-v error -print_format json -show_format -show_streams ' + (Q $file.FullName))
    if ($script:Cancel) { return @{ Status = 'STOP' } }
    if ($pr.Code -ne 0) { return @{ Status = 'FAIL'; Name = $file.Name; Note = 'unreadable file' } }
    $j = $pr.Out | ConvertFrom-Json
    $audio = $j.streams | Where-Object codec_type -eq 'audio' | Select-Object -First 1
    if (-not $audio) { return @{ Status = 'FAIL'; Name = $file.Name; Note = 'no audio stream' } }


    $tagsets = @($j.format.tags, $audio.tags)
    function Pick([string]$n) { foreach ($t in $tagsets) { $v = Get-Tag $t $n; if ($v) { return $v } } }
    $artist      = Join-Artists (Pick 'artist')
    $albumArtist = Join-Artists (Pick 'album_artist')
    $title       = (Pick 'title')

    $base = if ($artist -and $title) { "$artist - $title" } else { [IO.Path]::GetFileNameWithoutExtension($file.Name) }
    $name = Safe-Name $base
    if (-not $name) { return @{ Status = 'FAIL'; Name = $file.Name; Note = 'empty file name' } }
    if ($name -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') { $name = "_$name" }
    $maxLen = [Math]::Max(20, 240 - $outDir.Length - 30)
    if ($name.Length -gt $maxLen) { $name = $name.Substring(0, $maxLen).TrimEnd('.', ' ') }
    # Same name within one run = different songs: number them in source order ("Name", "Name (2)", ...) so reruns line up.
    # Every name handed out in this batch is tracked, so a generated "(2)" can never clash with a real title.
    $dupNote = ''
    $cand = $name; $n = 1
    while ($script:Used.Contains($cand.ToLower())) { $n++; $cand = "$name ($n)" }
    [void]$script:Used.Add($cand.ToLower())
    if ($n -gt 1) { $dupNote = 'duplicate name; ' }
    $name = $cand
    $dest = Join-Path $outDir ($name + '.mp3')
    if (Test-Path -LiteralPath $dest) { return @{ Status = 'SKIP'; Name = "$name.mp3"; Note = 'already exists' } }
    $q = $null
    if ($script:QMode -ne 'off') {
        if ($script:Gui) { $lblStatus.Text = "Checking quality - $($file.Name)" }
        $q = Test-Quality $file $audio $j
        if ($script:Cancel) { return @{ Status = 'STOP' } }
        if ($q.Low -and $script:QMode -eq 'skip') { return @{ Status = $q.Kind; Name = $file.Name; Note = $q.Msg } }
    }
    $part = $dest + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.part'

    $isMp3 = $audio.codec_name -eq 'mp3'
    $a = @('-v', 'error', '-y', '-i', (Q $file.FullName), '-map', '0:a:0', '-map', '0:v?', '-map_metadata', '0')
    if ($isMp3) { $a += '-c', 'copy' }
    else        { $a += '-c:a', 'libmp3lame', '-b:a', "$($script:Bitrate)k", '-ar', "$($script:SampleRate)", '-c:v', 'copy', '-disposition:v', 'attached_pic' }
    $a += '-id3v2_version', '3'
    if ($artist)      { $a += '-metadata', (Q "artist=$artist") }
    if ($albumArtist) { $a += '-metadata', (Q "album_artist=$albumArtist") }
    $a += '-f', 'mp3', (Q $part)

    try {
        $r = Run-Proc $Ffmpeg ($a -join ' ')
        if ($script:Cancel) { return @{ Status = 'STOP' } }
        if ($r.Code -ne 0 -or -not (Test-Path -LiteralPath $part)) {
            return @{ Status = 'FAIL'; Name = $file.Name; Note = ($r.Err.Trim() -split "`n" | Select-Object -Last 1) }
        }
        try { Move-Item -LiteralPath $part -Destination $dest -ErrorAction Stop }
        catch {
            if (Test-Path -LiteralPath $dest) { return @{ Status = 'SKIP'; Name = "$name.mp3"; Note = 'already exists' } }
            throw
        }
        $note = $dupNote + $(if ($isMp3) { 'MP3 kept as is' } else { "$($script:Bitrate)k" })
        if ($q -and $q.Msg) { $note += " | $($q.Msg)" }
        $status = if ($q -and $q.Low) { 'WARN' } else { 'OK' }
        @{ Status = $status; Name = "$name.mp3"; Note = $note }
    } finally {
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Batch([string]$in, [string]$out) {
    Set-Content -LiteralPath $LogFile -Value '' -Encoding UTF8
    $conf = Load-Settings
    $script:Bitrate = $conf.Bitrate; $script:SampleRate = $conf.SampleRate
    $script:QMode = $conf.QualityCheck; $script:QMin = $conf.MinKbps
    if (-not $Ffmpeg -or -not $Ffprobe) { Log 'ERROR: ffmpeg not found. Put ffmpeg.exe and ffprobe.exe in the bin folder (see docs\HOWTO.md) or run Get-FFmpeg.ps1.'; return }
    if (-not (Test-Path -LiteralPath $in -PathType Container)) { Log "ERROR: songs folder not found: $in"; return }
    if (-not $out) { Log 'ERROR: pick an output folder.'; return }
    if ((Resolve-Path -LiteralPath $in).Path.TrimEnd('\') -ieq $out.TrimEnd('\')) { Log 'ERROR: output folder must be different from the songs folder.'; return }
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    $files = @(Get-ChildItem -LiteralPath $in -File | Where-Object { $Extensions -contains $_.Extension.ToLower() } | Sort-Object Name)
    if (-not $files) { Log 'No music files found in that folder.'; return }
    $count = @{ OK = 0; WARN = 0; FAKE = 0; LOW = 0; SKIP = 0; FAIL = 0 }
    if ($script:Gui) { Set-Progress 0 $files.Count; $lblCount.Text = "0 / $($files.Count)" }
    $script:Used = New-Object 'System.Collections.Generic.HashSet[string]'
    $i = 0
    foreach ($f in $files) {
        if ($script:Cancel) { Log 'Stopped.'; break }
        $i++
        if ($script:Gui) { $lblStatus.Text = "Converting $i of $($files.Count) - $($f.Name)" }
        try { $res = Convert-One $f $out }
        catch { $res = @{ Status = 'FAIL'; Name = $f.Name; Note = $_.Exception.Message } }
        if ($res.Status -eq 'STOP') { Log 'Stopped.'; break }
        $count[$res.Status]++
        Log-Result $res.Status $res.Name $res.Note
        if ($script:Gui) { Set-Progress $i $files.Count; $lblCount.Text = "$i / $($files.Count)" }
    }
    $summary = "Done: $($count.OK + $count.WARN) converted, $($count.SKIP) skipped, $($count.FAIL) failed."
    if ($count.WARN) { $summary += " $($count.WARN) flagged as low quality." }
    if ($count.FAKE + $count.LOW) { $summary += " $($count.FAKE + $count.LOW) not converted (below quality minimum, $($count.FAKE) of them fakes)." }
    Log $summary
    if ($script:Gui) { $lblStatus.Text = $summary }
}

function Load-Settings {
    $desk = [Environment]::GetFolderPath('Desktop')
    $d = @{ In = (Join-Path $desk 'NewTunes'); Out = (Join-Path $desk 'converted'); Bitrate = 320; SampleRate = 44100; QualityCheck = 'warn'; MinKbps = 320 }
    if (Test-Path -LiteralPath $SettingsFile) {
        try {
            $s = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json
            if ($s.In)  { $d.In  = $s.In }
            if ($s.Out) { $d.Out = $s.Out }
            if (@(128, 160, 192, 224, 256, 320) -contains [int]$s.Bitrate) { $d.Bitrate = [int]$s.Bitrate }
            if (@(44100, 48000) -contains [int]$s.SampleRate) { $d.SampleRate = [int]$s.SampleRate }
            if (@('off', 'warn', 'skip') -contains [string]$s.QualityCheck) { $d.QualityCheck = [string]$s.QualityCheck }
            if (@(128, 160, 192, 224, 256, 320) -contains [int]$s.MinKbps) { $d.MinKbps = [int]$s.MinKbps }
        } catch {}
    }
    $d
}

function Save-Settings([hashtable]$changes) {
    $s = Load-Settings
    foreach ($k in $changes.Keys) { $s[$k] = $changes[$k] }
    $s | ConvertTo-Json | Set-Content -LiteralPath $SettingsFile -Encoding UTF8
}

if ($NoGui) {
    Invoke-Batch $In $Out
    return
}

# The custom controls compile against Windows PowerShell's .NET Framework; hand off from PowerShell 7.
if ($PSVersionTable.PSVersion.Major -ge 6) {
    $psi = New-Object Diagnostics.ProcessStartInfo("$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe",
        ('-NoProfile -ExecutionPolicy Bypass -File ' + (Q $PSCommandPath)))
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    [void][Diagnostics.Process]::Start($psi)
    return
}

# ---- Custom-drawn controls (anti-aliased rounded corners) ----
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public static class UiShape {
    public static GraphicsPath Round(Rectangle r, int radius) {
        int d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        GraphicsPath p = new GraphicsPath();
        if (d <= 0) { p.AddRectangle(r); return p; }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}

public class RoundPanel : Panel {
    public int Radius = 10;
    public Color BorderColor = Color.Empty;
    public RoundPanel() {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Parent != null ? Parent.BackColor : Color.Black);
        if (Width < 2 || Height < 2) { base.OnPaint(e); return; }
        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath p = UiShape.Round(r, Radius)) {
            using (SolidBrush b = new SolidBrush(BackColor)) g.FillPath(b, p);
            if (BorderColor != Color.Empty) using (Pen pen = new Pen(BorderColor)) g.DrawPath(pen, p);
        }
        base.OnPaint(e);
    }
}

public class RoundButton : Button {
    public int Radius = 8;
    public Color Fill = Color.Gray, HoverFill = Color.Gray, DisabledFill = Color.DimGray;
    public Color TextColor = Color.White, DisabledText = Color.Gray;
    private bool hover, down;
    public RoundButton() {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        Cursor = Cursors.Hand;
    }
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { hover = false; down = false; Cursor = Enabled ? Cursors.Hand : Cursors.Default; Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }
    protected override void OnPaint(PaintEventArgs e) {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Parent != null ? Parent.BackColor : Color.Black);
        Color f = !Enabled ? DisabledFill : ((hover || down) ? HoverFill : Fill);
        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath p = UiShape.Round(r, Radius)) using (SolidBrush b = new SolidBrush(f)) g.FillPath(b, p);
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, Enabled ? TextColor : DisabledText,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
    }
}
'@

Add-Type -Namespace Win -Name Dwm -MemberDefinition '[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);'
$cfg = Load-Settings
[Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object Windows.Forms.Form
$form.Text = 'Tunes Converter'
$form.ClientSize = New-Object Drawing.Size(800, 716)
$form.MinimumSize = $form.Size
$form.StartPosition = 'CenterScreen'
$form.BackColor = $Bg; $form.ForeColor = $Ink
$form.Font = New-Object Drawing.Font('Segoe UI', 10)
$iconFile = Join-Path $AppDir 'TunesConverter.ico'
if (Test-Path -LiteralPath $iconFile) { $form.Icon = New-Object Drawing.Icon($iconFile) }
$form.Add_HandleCreated({ $v = 1; [Win.Dwm]::DwmSetWindowAttribute($form.Handle, 20, [ref]$v, 4) | Out-Null })

function Add-Label($parent, [string]$text, [int]$x, [int]$y, $font, $color) {
    $l = New-Object Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object Drawing.Point($x, $y); $l.AutoSize = $true
    $l.Font = $font; $l.ForeColor = $color; $l.BackColor = $parent.BackColor
    $parent.Controls.Add($l); $l
}

function Add-Panel($parent, [int]$x, [int]$y, [int]$w, [int]$h, $fill, $border, [int]$radius, [string]$anchor) {
    $p = New-Object RoundPanel
    $p.Location = New-Object Drawing.Point($x, $y); $p.Size = New-Object Drawing.Size($w, $h)
    $p.BackColor = $fill; $p.Radius = $radius
    if ($border) { $p.BorderColor = $border }
    if ($anchor) { $p.Anchor = $anchor }
    $parent.Controls.Add($p); $p
}

function Add-Button($parent, [string]$text, [int]$x, [int]$y, [int]$w, [int]$h, $fill, $hover, $fg, $offFill, $offFg, [int]$radius, [string]$anchor) {
    $b = New-Object RoundButton
    $b.Text = $text; $b.Location = New-Object Drawing.Point($x, $y); $b.Size = New-Object Drawing.Size($w, $h)
    $b.Fill = $fill; $b.HoverFill = $hover; $b.TextColor = $fg; $b.DisabledFill = $offFill; $b.DisabledText = $offFg; $b.Radius = $radius
    $b.Font = New-Object Drawing.Font('Segoe UI', 10.5)
    if ($anchor) { $b.Anchor = $anchor }
    $parent.Controls.Add($b); $b
}

# Header
$logo = Add-Panel $form 28 28 42 42 $Accent $null 10 'Top,Left'
$logo.Add_Paint({
    param($s, $e)
    $g = $e.Graphics
    $pen = New-Object Drawing.Pen($AccentDark, 2.2)
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    $k = 22.0 / 24.0; $ox = 10; $oy = 10
    $pts = @(@(9, 18), @(9, 5), @(21, 3), @(21, 16)) | ForEach-Object { New-Object Drawing.PointF(($ox + $_[0] * $k), ($oy + $_[1] * $k)) }
    $g.DrawLines($pen, [Drawing.PointF[]]$pts)
    $g.DrawEllipse($pen, ($ox + 3 * $k), ($oy + 15 * $k), (6 * $k), (6 * $k))
    $g.DrawEllipse($pen, ($ox + 15 * $k), ($oy + 13 * $k), (6 * $k), (6 * $k))
    $pen.Dispose()
})
[void](Add-Label $form 'Tunes Converter' 84 24 (New-Object Drawing.Font('Segoe UI Semibold', 16.5)) $Ink)
[void](Add-Label $form 'Pick a folder, press start, get tidy MP3s.' 86 57(New-Object Drawing.Font('Segoe UI', 9.75)) $Muted)

# Folder card
$cardFolders = Add-Panel $form 28 90 744 180 $Card $Border 10 'Top,Left,Right'

function Add-FolderRow([string]$label, [int]$y, [string]$value) {
    [void](Add-Label $cardFolders $label 18 $y (New-Object Drawing.Font('Segoe UI Semibold', 8.5)) $Muted)
    $wrap = Add-Panel $cardFolders 18 ($y + 24) 606 40 $Field $FieldBorder 6 'Top,Left,Right'
    $wrap.Padding = New-Object Windows.Forms.Padding(12, 11, 12, 0)
    $t = New-Object Windows.Forms.TextBox
    $t.Text = $value; $t.BorderStyle = 'None'; $t.BackColor = $Field; $t.ForeColor = $Ink; $t.Dock = 'Fill'
    $t.Font = New-Object Drawing.Font('Segoe UI', 10.5)
    $wrap.Controls.Add($t)
    $b = Add-Button $cardFolders 'Browse' 634 ($y + 24) 92 40 $Ghost $GhostHover $Ink $GhostOff $GhostOffText 6 'Top,Right'
    $b.Add_Click({
        $d = New-Object Windows.Forms.FolderBrowserDialog
        if (Test-Path -LiteralPath $t.Text) { $d.SelectedPath = $t.Text }
        if ($d.ShowDialog() -eq 'OK') { $t.Text = $d.SelectedPath }
    }.GetNewClosure())
    [pscustomobject]@{ Text = $t; Browse = $b }
}
$rowIn  = Add-FolderRow 'SONGS FOLDER' 18 $cfg.In
$rowOut = Add-FolderRow 'SAVE MP3s TO' 98 $cfg.Out
$txtIn = $rowIn.Text; $txtOut = $rowOut.Text

# Setting chips
function Add-Chip([string]$text, [int]$x) {
    $font = New-Object Drawing.Font('Segoe UI', 9.4)
    $w = [Windows.Forms.TextRenderer]::MeasureText($text, $font).Width
    $chip = Add-Panel $form $x 290 ($w + 48) 30 $Card $Border 15 'Top,Left'
    [void](Add-Panel $chip 12 12 6 6 $Accent $null 3 $null)
    [void](Add-Label $chip $text 24 4 $font $ChipInk)
    $chip.Right + 8
}
$cx = 28
foreach ($t in "MP3 $($cfg.Bitrate) kbps",'Full artist names', 'Cover art kept', 'Originals untouched') { $cx = Add-Chip $t $cx }

# Quality-check toggles (click to change; saved to settings.json)
$script:QMode = $cfg.QualityCheck; $script:QMin = $cfg.MinKbps
$tip = New-Object Windows.Forms.ToolTip
function Add-ToggleChip([int]$x, [int]$w, [string]$tooltip) {
    $chip = Add-Panel $form $x 326 $w 30 $Card $FieldBorder 15 'Top,Left'
    $chip.Cursor = 'Hand'
    $lbl = Add-Label $chip '' 14 4 (New-Object Drawing.Font('Segoe UI', 9.4)) $ChipInk
    $lbl.Cursor = 'Hand'
    $tip.SetToolTip($chip, $tooltip); $tip.SetToolTip($lbl, $tooltip)
    [pscustomobject]@{ Chip = $chip; Label = $lbl }
}
$modeChip = Add-ToggleChip 28 216 'Click to change. Off: no check. Warn: convert everything but flag low-quality files. Skip: do not convert files below the minimum.'
$minChip  = Add-ToggleChip 252 160 'Click to change the lowest real quality you accept (judged from the audio, not the file label).'
function Update-QualityChips {
    $modeChip.Label.Text = switch ($script:QMode) { 'off' { 'Quality check: off' } 'warn' { 'Quality check: warn' } default { 'Quality check: skip fakes' } }
    $modeChip.Label.ForeColor = switch ($script:QMode) { 'off' { $Muted } 'warn' { $Amber } default { $Accent } }
    $minChip.Label.Text = "Minimum: $($script:QMin) kbps"
    $minChip.Label.ForeColor = if ($script:QMode -eq 'off') { $GhostOffText } else { $ChipInk }
}
Update-QualityChips
$cycleMode = {
    $order = 'off', 'warn', 'skip'
    $script:QMode = $order[([Array]::IndexOf($order, $script:QMode) + 1) % 3]
    Save-Settings @{ QualityCheck = $script:QMode }
    Update-QualityChips
}
$cycleMin = {
    $order = 320, 256, 224, 192, 160, 128
    $script:QMin = $order[([Array]::IndexOf($order, [int]$script:QMin) + 1) % $order.Count]
    Save-Settings @{ MinKbps = $script:QMin }
    Update-QualityChips
}
foreach ($c in $modeChip.Chip, $modeChip.Label) { $c.Add_Click($cycleMode) }
foreach ($c in $minChip.Chip, $minChip.Label) { $c.Add_Click($cycleMin) }

# Actions
$btnStart = Add-Button $form 'START' 28 376 200 54 $Accent $AccentHover $AccentDark (C '#1d3a2b') (C '#7fd6a6') 8 'Top,Left'
$btnStart.Font = New-Object Drawing.Font('Segoe UI Semibold', 12)
$btnStop = Add-Button $form 'Stop' 240 376 96 54 $Ghost $GhostHover (C '#ff9a9a') $GhostOff $GhostOffText 8 'Top,Left'
$btnStop.Enabled = $false
$btnOpen = Add-Button $form 'Open output folder' 582 376 190 54 $Ghost $GhostHover $Ink $GhostOff $GhostOffText 8 'Top,Right'

# Status + progress
$lblStatus = New-Object Windows.Forms.Label
$lblStatus.Text = 'Ready.'; $lblStatus.Location = New-Object Drawing.Point(28, 450); $lblStatus.Size = New-Object Drawing.Size(650, 20)
$lblStatus.Font = New-Object Drawing.Font('Segoe UI', 9.75); $lblStatus.ForeColor = $Muted; $lblStatus.BackColor = $Bg
$lblStatus.AutoEllipsis = $true; $lblStatus.Anchor = 'Top,Left,Right'
$lblCount = New-Object Windows.Forms.Label
$lblCount.Text = '0 / 0'; $lblCount.Location = New-Object Drawing.Point(682, 450); $lblCount.Size = New-Object Drawing.Size(90, 20)
$lblCount.TextAlign = 'TopRight'; $lblCount.Font = New-Object Drawing.Font('Segoe UI', 9.75); $lblCount.ForeColor = $Ink; $lblCount.BackColor = $Bg; $lblCount.Anchor = 'Top,Right'
$form.Controls.AddRange(@($lblStatus, $lblCount))
$track = Add-Panel $form 28 478 744 6 $Field $null 3 'Top,Left,Right'
$fill  = Add-Panel $track 0 0 0 6 $Accent $null 3 $null
$track.Add_Resize({ $fill.Width = [int]($track.Width * $script:Ratio) })

# Log card
$cardLog = Add-Panel $form 28 504 744 184 $Card $Border 10 'Top,Bottom,Left,Right'
$cardLog.Padding = New-Object Windows.Forms.Padding(16, 14, 16, 14)
$lblEmpty = New-Object Windows.Forms.Label
$lblEmpty.Text = 'Conversion log appears here.'; $lblEmpty.Dock = 'Fill'; $lblEmpty.TextAlign = 'MiddleCenter'
$lblEmpty.Font = New-Object Drawing.Font('Consolas', 9.4); $lblEmpty.ForeColor = $Muted; $lblEmpty.BackColor = $Card
$txtLog = New-Object Windows.Forms.RichTextBox
$txtLog.ReadOnly = $true; $txtLog.BorderStyle = 'None'; $txtLog.BackColor = $Card; $txtLog.ForeColor = $Muted
$txtLog.Font = New-Object Drawing.Font('Consolas', 9.4); $txtLog.WordWrap = $false; $txtLog.Dock = 'Fill'
$txtLog.DetectUrls = $false; $txtLog.Visible = $false
$cardLog.Controls.AddRange(@($txtLog, $lblEmpty))

function Set-Running([bool]$running) {
    $btnStart.Enabled = -not $running
    $btnStart.Text = if ($running) { 'Converting...' } else { 'START' }
    $btnStop.Enabled = $running
    $rowIn.Browse.Enabled = -not $running; $rowOut.Browse.Enabled = -not $running
    $txtIn.ReadOnly = $running; $txtOut.ReadOnly = $running
    $modeChip.Chip.Enabled = -not $running; $minChip.Chip.Enabled = -not $running
}

$btnStart.Add_Click({
    $script:Cancel = $false
    Set-Running $true
    $txtLog.Clear(); Set-Progress 0 1; $lblCount.Text = '0 / 0'
    try {
        Save-Settings @{ In = $txtIn.Text; Out = $txtOut.Text }
        Invoke-Batch $txtIn.Text.Trim() $txtOut.Text.Trim()
    } catch { Log "ERROR: $($_.Exception.Message)" }
    finally { Set-Running $false }
})
$btnStop.Add_Click({ $script:Cancel = $true; $lblStatus.Text = 'Stopping...' })
$btnOpen.Add_Click({ if (Test-Path -LiteralPath $txtOut.Text) { Start-Process explorer.exe -ArgumentList (Q $txtOut.Text) } })
$form.Add_FormClosing({ $script:Cancel = $true; if ($script:Proc) { try { $script:Proc.Kill() } catch {} } })
$form.Add_Shown({ $txtIn.SelectionLength = 0; $btnStart.Select() })

[void]$form.ShowDialog()
