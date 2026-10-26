# How to install and use Tunes Converter

Tunes Converter turns a folder of music files into MP3s with correct `Artist - Title` file names. It is a small
app for Windows, macOS and Linux.

![Tunes Converter](screenshot.png)

**Contents**
[Install](#install) |
[Get ffmpeg](#get-ffmpeg-one-time) |
[Use it](#use-it) |
[What it does to your files](#what-it-does-to-your-files) |
[Quality check](#quality-check-spot-fake-files) |
[Settings](#settings) |
[Troubleshooting](#troubleshooting) |
[Uninstall](#uninstall) |
[Build from source](#build-from-source) |
[Status and license](#status-and-license)

---

## Install

Download the file for your system from the project's **Releases** page.

### Windows (10 or 11)

**Installer (easiest):** download `TunesConverter-<version>-win-x64-setup.exe` and run it. It installs for your user
only (it never asks for administrator rights), adds a Start menu entry and a Desktop shortcut, and can be removed from Windows
**Settings > Apps**. Your settings are kept in `%APPDATA%\Tunes Converter` and survive updates.

**Zip (just unzip and run, no installer):**

1. Download `TunesConverter-<version>-win-x64.zip`.
2. Right-click it, **Extract All...**, and pick any folder (a USB stick works too).
3. Double-click **`Tunes Converter.exe`**.

Keep the whole folder together. Your settings are saved next to the app, so it can also run from a USB stick.

Windows SmartScreen may say "Windows protected your PC" because the app is not code-signed: click **More info**, then
**Run anyway**.

### macOS

1. Download the `.dmg` that matches your Mac: **`mac-arm64`** for Apple Silicon (M1 and newer), **`mac-x64`** for Intel.
2. Open it and drag **Tunes Converter** to Applications (or anywhere else; it also runs from a folder or USB drive).
3. The app is not signed with a paid Apple developer certificate, so macOS blocks it the first time. Try to open it
   once, then go to **System Settings > Privacy & Security**, scroll to the message about "Tunes Converter" and click
   **Open Anyway** (enter your password). (On recent macOS, right-click > Open no longer bypasses this.)

If macOS says the app is "damaged" or the button does not appear, remove the download flag once in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Tunes Converter.app"
```

### Linux

Pick one:

- **AppImage:** download `TunesConverter-<version>-linux-x86_64.AppImage`, then
  ```bash
  chmod +x TunesConverter-*.AppImage
  ./TunesConverter-*.AppImage
  ```
  If it complains about FUSE, install `libfuse2` (`sudo apt install libfuse2`), or run it without FUSE:
  `./TunesConverter-*.AppImage --appimage-extract-and-run`.
- **tar.gz:** extract it anywhere and run the `tunes-converter` file inside.

## Get ffmpeg (one time)

The app uses **ffmpeg** (a free, widely used audio tool) to do the actual converting. It is not included, so add
it once. When it is missing, the app shows a yellow box that tells you exactly what to do.

| System | How |
| ------ | --- |
| **Windows** | Press **Download ffmpeg** in the yellow box (about 100 MB from <https://www.gyan.dev/ffmpeg/builds/>, checked against the checksum published there; nothing is installed). Or put `ffmpeg.exe` and `ffprobe.exe` in the `bin` folder next to the app. |
| **macOS** | Install [Homebrew](https://brew.sh), then run `brew install ffmpeg` in Terminal. The app's yellow box has **Get Homebrew** and **Copy command** buttons: paste the command into the Terminal app (Cmd+Space, type Terminal), press Return, then press **Check again**. |
| **Linux** | `sudo apt install ffmpeg` (Debian/Ubuntu), `sudo dnf install ffmpeg` (Fedora, needs RPM Fusion), or `sudo pacman -S ffmpeg` (Arch). The app's yellow box has **Get Homebrew** and **Copy command** buttons: paste the command into the Terminal app (Cmd+Space, type Terminal), press Return, then press **Check again**. |

Already have ffmpeg somewhere else? Press **Locate ffmpeg...** and choose the folder that contains `ffmpeg` and
`ffprobe`. The app also checks its own `bin` folder and your `PATH` (and the usual Homebrew folders on macOS).

## Use it

1. Open Tunes Converter.
2. **Songs folder:** click **Browse** and choose the folder with your music (files directly in it are converted;
   subfolders are not searched).
3. **Save MP3s to:** choose where the MP3s go. It must be a different folder from the songs folder. It is created
   if it does not exist.
4. Press **START**. The progress bar and log show each file as it finishes.
5. **Stop** ends the batch after cancelling the current file cleanly (no half-written files are left behind).
6. **Open output folder** jumps to the results.

**Settings:** the **Settings** button (top right) has every option, including keeping cover art, full artist names and opening the folder when finished.

**Lossless and DJ use:** choose **WAV** or **FLAC** and a **Bit depth** (16-bit is the most compatible with CDJs). This also fixes 32-bit float rips: they are converted to the depth you pick, with dither at 16-bit. **File names** lets you pick a pattern (Artist - Title, Title, Track - Artist - Title, or your own). **Tags** can keep everything, keep only the main fields, or remove all tags.

**Extras:** drag a folder (it becomes the songs folder) or music files onto the window; click the format chip to choose MP3, AAC (M4A), FLAC or Opus (Opus tops out at 256 kbps); click **Subfolders** to include sub-folders (the folder layout is copied); **Check for updates** in the footer only contacts GitHub when you click it.

Log colours: green **OK** = converted, amber **SKIP** = already there, red **FAIL** = problem with that file (the
reason is shown; the rest of the batch continues). Amber **WARN**/**LOW** and red **FAKE** come from the
[quality check](#quality-check-spot-fake-files).

The small pill buttons under the folder boxes are settings you can click: output bitrate, sample rate, quality
check mode and minimum quality. They are saved for next time.

## What it does to your files

- **Originals are never changed or deleted.** Everything is written to the output folder.
- **Format:** MP3, 320 kbps constant bitrate, 44.1 kHz by default. Tags are written as ID3v2.3, which works with
  DJ software, phones and car stereos. Cover art is kept.
- **File names:** `Artist - Title.mp3`, built from the file's tags. If a file has no artist or title tag, its
  original name is used.
- **Several artists:** many files store each artist as a separate tag (for example `ARTIST=Pola & Bryson` and
  `ARTIST=Cimone`). Some tools keep only one of them. Tunes Converter joins them: `Pola & Bryson, Cimone - Twilight.mp3`.
- **MP3 files** are copied as they are (no re-encoding, so no quality loss); their tags and file name are still
  tidied up.
- **Characters that file systems do not allow** (`\ / : * ? " < > |`) are replaced with `-`. Very long names are
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

Two options control it. Click the two pills under the folder boxes to change them:

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
  files are analysed channel by channel. The verdict does not depend on loudness within normal levels. On a very quiet
  track a low result cannot be trusted, so it is reported as "not checked" instead of being flagged. Files below
  44.1 kHz sample rate are not checked, and a file that cannot be decoded is also reported as "not checked".
- A lossless file that stops around 20 kHz is passed (it meets a 320 minimum) but gets a note that it was probably
  made from a lossy source.
- Checking adds a few seconds per track.

## Settings

Settings are saved automatically in `settings.json`:

| System | Where |
| ------ | ----- |
| **Windows** | Installed copy: `%APPDATA%\Tunes Converter`. Unzipped copy: next to `Tunes Converter.exe` (or `%APPDATA%\Tunes Converter` if that location is read-only). |
| **macOS** | `~/Library/Application Support/Tunes Converter/` |
| **Linux** | `~/.config/Tunes Converter/` |

The footer of the window shows the exact folder. You can edit the file by hand (an example, `settings.example.json`, is in the [repository](https://github.com/bobojuice/tunes-converter); it is not included in the download) while
the app is closed:

| Key            | Default             | Allowed values                           |
| -------------- | ------------------- | ---------------------------------------- |
| `In`           | `Desktop/NewTunes`  | any folder                               |
| `Out`          | `Desktop/converted` | any folder, different from `In`          |
| `Bitrate`      | `320`               | `128`, `160`, `192`, `224`, `256`, `320` |
| `SampleRate`   | `44100`             | `44100`, `48000`                         |
| `QualityCheck` | `warn`              | `off`, `warn`, `skip`                    |
| `MinKbps`      | `320`               | `128`, `160`, `192`, `224`, `256`, `320` |
| `Format`       | `mp3`               | `mp3`, `m4a`, `flac`, `wav`, `opus` (click the format chip) |
| `BitDepth`     | `16`                | `16` or `24`; used for `flac` and `wav` (a 32-bit float source is converted down) |
| `NameTemplate` | `{artist} - {title}` | any text with `{artist}` `{title}` `{album}` `{albumartist}` `{track}` `{year}`; if a tag it uses is missing, the original file name is kept |
| `TagMode`      | `keep`              | `keep` all tags, `clean` (artist, album artist, title, album, track, date, genre only), `strip` (none) |
| `CoverArt`     | `true`              | `false` drops embedded cover art |
| `JoinArtists`  | `true`              | `false` leaves multi-artist tags as they are |
| `OpenWhenDone` | `false`             | `true` opens the output folder after a run |
| `Recurse`      | `false`             | `true` also converts sub-folders and mirrors them in the output |
| `WinW`, `WinH` | `820`, `840`        | window size, saved when you close the app |
| `FfmpegDir`    | empty               | folder containing `ffmpeg` and `ffprobe` (set by **Locate ffmpeg...**) |

Use double backslashes (`\\`) in Windows paths inside the JSON file. Each value is checked on its own; an invalid
one falls back to its default. Deleting `settings.json` resets everything. A plain-text record of the last run is kept
in `last-run.log` in the same folder.

## Troubleshooting

| Problem | What to try |
| ------- | ----------- |
| Yellow "ffmpeg not found" box | Follow [Get ffmpeg](#get-ffmpeg-one-time). Make sure `ffmpeg` and `ffprobe` are both in the same folder. |
| "This ffmpeg cannot write MP3" | That build has no MP3 encoder (`libmp3lame`). Install a full build (Homebrew, your distro, or the gyan.dev build on Windows). |
| macOS: "cannot be opened" / "damaged" | **System Settings > Privacy & Security > Open Anyway**, or run the `xattr` command in [Install](#macos). |
| Linux: window never appears / "sandbox" error | The app keeps Chromium's sandbox on. If your system cannot start it (some containers, restricted user namespaces), run once with `--no-sandbox` as a last resort. |
| Windows SmartScreen warning | The app is unsigned. **More info > Run anyway**. |
| Linux: AppImage will not start | Install `libfuse2`, or run with `--appimage-extract-and-run`. |
| "No music files found" | Files must be directly inside the songs folder (not in sub-folders) and have a supported extension. |
| Everything shows SKIP | Those files already exist in the output folder from an earlier run. Choose a new output folder or delete the old results. |
| A file shows FAIL | The reason is next to it. Usually the file is damaged or not real audio. The rest of the batch still runs. |
| File names look wrong | Names come from the file's tags. Fix the artist/title tags in a tag editor, then convert again into a fresh folder. |
| Quality check says "not checked" | The track is very quiet, very short, below 44.1 kHz, or could not be decoded. See [Quality check](#quality-check-spot-fake-files). |

## Uninstall

Remove the app: on Windows uninstall it from **Settings > Apps** (or delete the folder if you used the zip); on macOS delete the app; on Linux delete the AppImage. Settings live in the folders listed
under [Settings](#settings); delete those too if you want no trace. Your converted MP3s stay wherever you saved them.

## Build from source

```bash
npm ci
npm start        # run the app
npm test         # needs ffmpeg and ffprobe on your PATH or in ./bin
npm run dist     # package for the OS you are on, into ./dist
```

Needs Node.js 22 or newer. GitHub Actions (`.github/workflows/build.yml`) builds Windows, macOS and Linux and runs
the tests on each.

## Status and license

I built this for myself and I am sharing it in case it is useful. It is not actively maintained, issues are turned
off, and it comes as-is with no warranty. You are welcome to fork it and make it your own.

Licensed under the MIT license (see `LICENSE`). The app is built on Electron; ffmpeg is a separate program with its
own license (see `THIRD-PARTY-NOTICES.md`). Nothing is uploaded anywhere: the app works entirely on your computer.
