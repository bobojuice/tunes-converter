<div align="center">

# 🎵 Tunes Converter

**Drop a folder of music in, press START, get tidy files out.**
MP3 · AAC · FLAC · WAV · AIFF · Opus — with correct names, tags and an optional fake-quality check.

[![Latest release](https://img.shields.io/github/v/release/bobojuice/tunes-converter?style=for-the-badge&color=2dbe6c)](https://github.com/bobojuice/tunes-converter/releases/latest)
![Platforms](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-333?style=for-the-badge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

**[⬇️ Download the latest release](https://github.com/bobojuice/tunes-converter/releases/latest)** ·
**[📖 Full instructions](docs/HOWTO.md)**

<img src="docs/screenshot.png" alt="Tunes Converter main window" width="46%"> <img src="docs/screenshot-settings.png" alt="Tunes Converter menu panel" width="46%">

</div>

## ✨ What it does

**Convert**
- **Pick your format:** MP3 at 320 kbps by default, or AAC (M4A), FLAC, WAV, AIFF or Opus.
  Reads FLAC, WAV, AIFF, M4A, OGG, Opus, WMA and MP3.
- **Made for DJs:** lossless formats come out at 16-bit (most compatible) or 24-bit. AIFF keeps tags and cover art.
- **Copy, don't re-encode:** a file already in the chosen format keeps its audio untouched; only the name, tags and cover are fixed.
- **Presets:** save your settings under a name, load them with one click, and export or import them as a file.
- **Second copy (optional):** write every song in a second format and folder in the same run.

**Names, tags and folders**
- **Correct names:** `Artist - Title` by default, with several artists joined properly. Pick another pattern or write your own.
- **Folders by tags (optional):** sort the output into Artist/Album, Genre and so on.
- **Tag options:** keep all tags, the main fields only, or none. Cover art stays unless you turn it off, and oversized art is shrunk.
- **Original dates:** converted files keep the original file's date.

**Checks (they only flag, nothing is changed)**
- **Fake-quality check (optional):** estimates a file's true quality by where its audio really stops, so a low-quality
  MP3 passed off as 320 or lossless gets caught. [How it works](docs/HOWTO.md#quality-check-spot-fake-files).
- **Health, clipping and duplicate checks:** flag mono-as-stereo, low sample rate, damaged files, clipping and the same song twice.
- **Player check (optional):** pick your CDJ/XDJ model and files it may not play are flagged, from Pioneer's published specs.

**Everything else**
- **Play preview:** click a converted track in the list to hear it, and scrub through it. Your files are never changed.
- **Watch folder (optional):** new files in the songs folder are converted automatically.
- **Save report (optional):** a CSV report after every run.
- **Easy to use:** drag and drop a folder or files, include sub-folders, see the time left.
- **Safe and private:** the audio is never altered, originals are never touched, existing files are skipped, and nothing is
  uploaded. The optional *Check for updates* button only contacts GitHub when you click it.

## 🚀 Install and use

| | Download | Run |
| --- | --- | --- |
| **Windows** | `TunesConverter-<version>-win-x64-setup.exe` (installer) or `...-win-x64.zip` (just unzip and run) | Run the installer, or unzip anywhere and double-click `Tunes Converter.exe`. |
| **macOS** | `TunesConverter-<version>-mac-arm64.dmg` (Apple Silicon) or `-mac-x64.dmg` (Intel) | Open the dmg and drag the app to Applications. The first time, open **System Settings > Privacy & Security** and click **Open Anyway**. *Not yet tested on a real Mac.* |
| **Linux** | `TunesConverter-<version>-linux-x86_64.AppImage` (or `.tar.gz`) | Make it executable and run it. |

Then add **ffmpeg** once (it is not included). The app asks on first launch and tells you what to do.
Step-by-step help and troubleshooting: **[docs/HOWTO.md](docs/HOWTO.md)**.

## ⚙️ Menu and settings

Click **MENU** (top right) for every option, including presets. Your folders and options are saved automatically in
`settings.json`; see [docs/HOWTO.md](docs/HOWTO.md#settings) for what each value means.

## 🛠️ Build from source

Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
npm ci
npm start          # run the app
npm test           # tests (need ffmpeg and ffprobe on your PATH or in ./bin)
npm run dist       # package for the OS you are on, into ./dist
```

GitHub Actions builds all three systems (`.github/workflows/build.yml`); pushing a tag like `v2.8.0` collects them
into a draft release.

## 📝 Status

I built this for myself and I'm sharing it in case it's useful to you. It works for me, but I'm not actively
maintaining it, so I can't promise fixes, features, or replies. It's provided as-is, with no warranty
(see the MIT license).

Issues are turned off. You're very welcome to fork it and make it your own. Hope it helps! 💚

## ⚖️ License

MIT (`LICENSE`). The app is built on Electron (MIT, includes Chromium). ffmpeg is a separate program with its own
license (the common builds are GPL) and is not bundled; see `THIRD-PARTY-NOTICES.md`.
