# Tunes Converter

Drop a folder of music in, press **START**, get tidy MP3s out. A small portable Windows app.

![Tunes Converter](docs/screenshot.png)

- **MP3 at 320 kbps** (CBR, 44.1 kHz) by default, via ffmpeg/LAME. Bitrate and sample rate are configurable.
- **Correct names:** files become `Artist - Title.mp3`. Tracks with several artists in separate tags
  (e.g. `ARTIST=Pola & Bryson` + `ARTIST=Cimone`) become `Pola & Bryson, Cimone - Title.mp3` instead of
  keeping only the last artist.
- **Fake-quality check:** measures where each file's audio really stops (not what its tag claims) to estimate the
  true bitrate, and can flag or skip files below a minimum you choose (for example a 128k MP3 passed off as 320 or
  lossless). Off, warn or skip; see [docs/HOWTO.md](docs/HOWTO.md#quality-check-spot-fake-files).
- **Tags and cover art kept**, written as ID3v2.3 (works with DJ software and car stereos).
- **Originals are never touched.** Output goes to a separate folder; existing files are skipped, so reruns are safe.
- Reads FLAC, WAV, AIFF, M4A, OGG, Opus, WMA and MP3. MP3 sources are copied as they are (no re-encoding,
  tags still fixed).
- Nothing is uploaded anywhere. Everything runs locally.

## Use it

**Full instructions: [docs/HOWTO.md](docs/HOWTO.md)** (install, ffmpeg setup, usage, settings, troubleshooting).

The short version:

1. Download the latest zip from **Releases** and unzip it anywhere (USB stick is fine).
2. Add ffmpeg once: put `ffmpeg.exe` and `ffprobe.exe` in the `bin` folder, or run the optional
   `Get-FFmpeg.ps1` helper to fetch them.
3. Double-click `TunesConverter.exe`, pick the songs and output folders, press **START**.

Keep the whole folder together. Requires Windows 10/11 (uses the built-in Windows PowerShell). Windows SmartScreen
may warn about the unsigned `.exe` the first time: **More info > Run anyway**.

## Settings

Folders are remembered in `settings.json` next to the app. Create or edit it by hand to change the rest
(see `settings.example.json`):

| Key          | Default       | Allowed values                          |
| ------------ | ------------- | --------------------------------------- |
| `In`         | `Desktop\NewTunes`   | any folder                      |
| `Out`        | `Desktop\converted`  | any folder (not the same as `In`) |
| `Bitrate`    | `320`         | `128`, `160`, `192`, `224`, `256`, `320` |
| `SampleRate` | `44100`       | `44100`, `48000`                        |
| `QualityCheck` | `warn`      | `off`, `warn`, `skip`                   |
| `MinKbps`    | `320`         | `128`, `160`, `192`, `224`, `256`, `320` |

Invalid values fall back to the defaults. Close and reopen the app after editing.

## Run without the window

```powershell
powershell -File TunesConverter.ps1 -NoGui -In "C:\Music\Incoming" -Out "C:\Music\MP3"
```

## Build from source

```powershell
.\Build.ps1                    # compiles src\Launcher.cs -> TunesConverter.exe
.\Make-Release.ps1             # builds, then zips dist\TunesConverter-vX.Y.Z.zip (no ffmpeg)
```

The repository and release zip do not contain ffmpeg. For development, put `ffmpeg.exe` and `ffprobe.exe` in
`bin\` (see `bin\README.txt`) or have them on your `PATH`.

## Status

I built this for myself and I'm sharing it in case it's useful to you. It works for me, but I'm not actively
maintaining it, so I can't promise fixes, features, or replies. It's provided as-is, with no warranty
(see the MIT license).

Issues are turned off. You're very welcome to fork it and make it your own. Hope it helps!

## Notes

- The script must stay ASCII-only (Windows PowerShell 5.1 reads it as ANSI).
- Duplicate names in one batch are numbered in source order: `Name.mp3`, `Name (2).mp3`, ...
- Licensing: this project is MIT (`LICENSE`). Bundled ffmpeg builds are GPL v3, see `THIRD-PARTY-NOTICES.md`.
