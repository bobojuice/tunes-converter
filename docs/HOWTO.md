# How to install and use Tunes Converter

Tunes Converter turns a folder of music files into MP3s with correct `Artist - Title` file names. It is a small,
portable Windows app: there is nothing to install, and deleting its folder removes it completely.

![Tunes Converter](screenshot.png)

**Contents**
[What you need](#what-you-need) |
[Install](#install) |
[Get ffmpeg](#get-ffmpeg-one-time) |
[Use it](#use-it) |
[What it does to your files](#what-it-does-to-your-files) |
[Quality check](#quality-check-spot-fake-files) |
[Settings](#settings) |
[Command line](#command-line) |
[Troubleshooting](#troubleshooting) |
[Uninstall](#uninstall) |
[Build from source](#build-from-source) |
[Status and license](#status-and-license)

---

## What you need

- Windows 10 or 11. It uses the Windows PowerShell that comes with Windows.
- About 300 MB free if you add ffmpeg (the app itself is tiny).
- Your music files. Supported: FLAC, WAV, AIFF, M4A, OGG, Opus, WMA, MP3.

## Install

1. Go to the project's **Releases** page and download `TunesConverter-vX.Y.Z.zip`.
2. Right-click the zip, choose **Extract All...**, and pick any folder (a USB stick works too).
3. You should now have a folder like this:

   ```
   TunesConverter\
     TunesConverter.exe      <- double-click this to start
     TunesConverter.ps1      <- the program itself (the .exe just opens this)
     TunesConverter.ico
     Get-FFmpeg.ps1          <- optional helper, see below
     settings.example.json
     bin\                    <- ffmpeg goes here
     docs\HOWTO.md  README.md  LICENSE  THIRD-PARTY-NOTICES.md
   ```

Keep everything together. `TunesConverter.exe` is only a launcher, so copying it on its own will not work.

**First launch:** Windows SmartScreen may say "Windows protected your PC" because the file is not code-signed.
Click **More info**, then **Run anyway**. If you would rather not run the `.exe`, you can read its few lines of
source in `src/Launcher.cs` on GitHub, or start the app without it (see [Command line](#command-line)).

## Get ffmpeg (one time)

The app uses **ffmpeg** (a free, widely used audio tool) to do the actual converting. It is not included in the
zip, so add it once, using whichever option suits you.

**Option A: automatic (optional helper).** Open the `TunesConverter` folder, click the address bar, type
`powershell` and press Enter, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Get-FFmpeg.ps1
```

It downloads about 100 MB from <https://www.gyan.dev/ffmpeg/builds/>, checks the file against the checksum
published there, and copies two files into `bin\`. Nothing is installed. To preview what it would do without
downloading, add `-DryRun`.

**Option B: manual.**
1. Download a Windows build, for example the "release essentials" zip from <https://www.gyan.dev/ffmpeg/builds/>
   or one from <https://github.com/BtbN/FFmpeg-Builds/releases>.
2. Open the zip, go into its `bin` folder, and copy **`ffmpeg.exe`** and **`ffprobe.exe`** into the app's `bin\`
   folder.

**Option C: you already have ffmpeg.** If `ffmpeg` and `ffprobe` work from any command prompt (they are on your
`PATH`), the app finds them automatically. Files in `bin\` are preferred when both exist.

## Use it

1. Double-click `TunesConverter.exe`.
2. **Songs folder:** click **Browse** and choose the folder with your music (files directly in it are converted;
   subfolders are not searched).
3. **Save MP3s to:** choose where the MP3s go. It must be a different folder from the songs folder. It is created
   if it does not exist.
4. Press **START**. The progress bar and log show each file as it finishes.
5. **Stop** ends the batch after cancelling the current file cleanly (no half-written files are left behind).
6. **Open output folder** jumps to the results.

Log colours: green **OK** = converted, amber **SKIP** = already there, red **FAIL** = problem with that file (the
reason is shown; the rest of the batch continues). Amber **WARN**/**LOW** and red **FAKE** come from the
[quality check](#quality-check-spot-fake-files).

The app remembers your two folders for next time.

## What it does to your files

- **Originals are never changed or deleted.** Everything is written to the output folder.
- **Format:** MP3, 320 kbps constant bitrate, 44.1 kHz (configurable, see [Settings](#settings)). Tags are written
  as ID3v2.3, which works with DJ software, phones and car stereos. Cover art is kept.
- **File names:** `Artist - Title.mp3`, built from the file's tags. If a file has no artist or title tag, its
  original name is used.
- **Several artists:** many files store each artist as a separate tag (for example `ARTIST=Pola & Bryson` and
  `ARTIST=Cimone`). Some tools keep only one of them. Tunes Converter joins them: `Pola & Bryson, Cimone - Twilight.mp3`.
- **MP3 files** are copied as they are (no re-encoding, so no quality loss); their tags and file name are still
  tidied up.
- **Characters Windows does not allow** in file names (`\ / : * ? " < > |`) are replaced with `-`. Very long names are
  shortened, and reserved Windows names (such as `CON`) get a leading underscore.
- **Safe to re-run.** A file that already exists in the output folder is skipped, never overwritten.
- **Same name twice in one batch** (two different songs with identical artist and title) are numbered in order:
  `Name.mp3`, `Name (2).mp3`, and so on.

## Quality check (spot fake files)

A file can claim to be 320 kbps (or lossless) and still be a low-quality file in disguise, for example a 128 kbps
MP3 that was converted to FLAC or re-encoded at 320. The tag says one thing; the audio says another.

Tunes Converter can check this before converting. Real full-quality audio keeps going up to about 22 kHz. Lossy
encoders chop off everything above a fixed frequency, and that cutoff gives away the real bitrate. The app measures
where each file's audio actually stops (from a spectrum analysis of the file itself, not from its tags) and
estimates the likely real quality:

| Audio stops at | Looks like |
| -------------- | ---------- |
| about 20 kHz or higher | 320 kbps or better (including lossless) |
| about 19.3 - 20 kHz | roughly 224 - 256 kbps |
| about 18.3 - 19.3 kHz | roughly 192 kbps |
| about 17.2 - 18.3 kHz | roughly 160 kbps |
| below about 17.2 kHz | 128 kbps or lower |

Two settings control it. Click the two chips under the folder box to change them (they are saved for next time):

- **Quality check:** `off`, `warn` or `skip fakes`.
  - `off`: no check (fastest).
  - `warn` (default): every file is converted, but low-quality files are flagged in the log.
  - `skip fakes`: files below your minimum are **not converted**. Nothing is deleted; your originals stay where they are.
- **Minimum:** the lowest real quality you accept: 320, 256, 224, 192, 160 or 128 kbps. Use 320 for strict, or 256 for
  hard-to-find tracks you are willing to accept at a slightly lower level.

What you will see in the log:

- `OK ... source ok: 320k or better (cutoff 22.1 kHz)`: passed.
- `FAKE ... fakin' the funk: claims lossless but looks like ~128k or lower (cutoff 16.7 kHz)`: the file claims more
  than its audio supports.
- `LOW ... below your 320k minimum: looks like ~192k (cutoff 18.8 kHz)`: honest about being lossy, but below your minimum.
- `WARN ...`: same findings in `warn` mode, where the file was still converted.

Good to know:

- It is a careful estimate, not a guarantee. The cutoff table was calibrated on LAME encodes of real music. Other
  encoders (for example AAC) cut off at slightly different frequencies, 224 and 256 kbps cannot be told apart, and a
  genuinely dull or band-limited recording (some old or heavily filtered masters) can look low quality.
- Long tracks are checked on a 3-minute slice from the middle (the first 4 minutes if the length is unknown). Stereo
  files are analysed channel by channel, and the result does not depend on how loud the track is. Files below
  44.1 kHz sample rate are not checked, and a file that cannot be decoded is reported as "not checked".
- A lossless file that stops around 20 kHz is passed (it meets a 320 minimum) but gets a note that it was probably
  made from a lossy source.
- Checking adds a few seconds per track.

## Settings

Your folders are saved in `settings.json`, created next to the app the first time you press START. You can also
create or edit it by hand to change more (copy `settings.example.json` to `settings.json`):

```json
{
  "In": "C:\\Music\\Incoming",
  "Out": "C:\\Music\\MP3",
  "Bitrate": 320,
  "SampleRate": 44100,
  "QualityCheck": "warn",
  "MinKbps": 320
}
```

| Key          | Default             | Allowed values                           |
| ------------ | ------------------- | ---------------------------------------- |
| `In`         | `Desktop\NewTunes`  | any folder                               |
| `Out`        | `Desktop\converted` | any folder, different from `In`          |
| `Bitrate`    | `320`               | `128`, `160`, `192`, `224`, `256`, `320` |
| `SampleRate` | `44100`             | `44100`, `48000`                         |
| `QualityCheck` | `warn`            | `off`, `warn`, `skip`                    |
| `MinKbps`    | `320`               | `128`, `160`, `192`, `224`, `256`, `320` |

Use double backslashes (`\\`) in paths inside the JSON file. Invalid values fall back to the defaults. Close and
reopen the app after editing. Deleting `settings.json` resets everything.

## Command line

Run without the window (handy for scripts):

```powershell
powershell -ExecutionPolicy Bypass -File .\TunesConverter.ps1 -NoGui -In "C:\Music\Incoming" -Out "C:\Music\MP3"
```

To open the window without the `.exe`:

```powershell
powershell -ExecutionPolicy Bypass -File .\TunesConverter.ps1
```

## Troubleshooting

| Problem | What to try |
| ------- | ----------- |
| "ffmpeg not found" in the log | Add ffmpeg (see [Get ffmpeg](#get-ffmpeg-one-time)). Make sure `ffmpeg.exe` and `ffprobe.exe` are directly inside `bin\`, not in a sub-folder. |
| Nothing happens when I double-click the `.exe` | Check the whole folder was extracted (the `.ps1` and `bin\` must sit beside the `.exe`). Try the [Command line](#command-line) version to see error messages. |
| SmartScreen or antivirus warns about the `.exe` | It is unsigned and tiny; it only starts `TunesConverter.ps1`. Click **More info > Run anyway**, or skip it and use the command line. Some antivirus tools dislike any unsigned launcher. |
| "Running scripts is disabled" | Start it with `-ExecutionPolicy Bypass` as shown above. The `.exe` already does this. |
| "No music files found" | Files must be directly inside the songs folder (not in sub-folders) and have a supported extension. |
| Everything shows SKIP | Those files already exist in the output folder from an earlier run. Choose a new output folder or delete the old results. |
| A file shows FAIL | The reason is next to it. Usually the file is damaged or not real audio. The rest of the batch still runs. |
| File names look wrong | Names come from the file's tags. Fix the artist/title tags in a tag editor, then convert again into a fresh folder. |
| The window looks wrong at high display scaling | Right-click the `.exe`, **Properties > Compatibility > Change high DPI settings**, and try the override option. |

A plain-text record of the last run is kept in `last-run.log` next to the app.

## Uninstall

Delete the folder. The app stores nothing anywhere else (no registry entries, no installed services). Your converted
MP3s stay wherever you saved them.

## Build from source

```powershell
.\Build.ps1                    # compiles src\Launcher.cs -> TunesConverter.exe
.\Make-Release.ps1             # builds, then zips dist\TunesConverter-vX.Y.Z.zip (no ffmpeg)
```

Notes for developers: `TunesConverter.ps1` must stay ASCII-only (Windows PowerShell 5.1 reads scripts as ANSI).
For development, put `ffmpeg.exe` and `ffprobe.exe` in `bin\` or on your `PATH`.

## Status and license

I built this for myself and I am sharing it in case it is useful. It is not actively maintained, issues are turned
off, and it comes as-is with no warranty. You are welcome to fork it and make it your own.

Licensed under the MIT license (see `LICENSE`). ffmpeg is a separate program with its own license
(see `THIRD-PARTY-NOTICES.md`). Nothing is uploaded anywhere: the app works entirely on your computer.
