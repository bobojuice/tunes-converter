# Third-party notices

Tunes Converter is MIT-licensed (see `LICENSE`).

## Electron and Chromium

The app is built on [Electron](https://www.electronjs.org) (MIT), which bundles Chromium and other open-source
components under their own licenses. The full list ships inside every download (`LICENSES.chromium.html`, and
`LICENSE.electron.txt` on Windows and Linux).

## FFmpeg

Tunes Converter runs **FFmpeg** (`ffmpeg`, `ffprobe`) as a separate program. It does not link against FFmpeg or
include its code, and the downloads do not contain FFmpeg.

- Project: https://ffmpeg.org (legal information: https://ffmpeg.org/legal.html)
- Users add FFmpeg themselves (see `docs/HOWTO.md`). On Windows the app can download a build from
  https://www.gyan.dev/ffmpeg/builds/ onto the user's own computer on request, and checks its published checksum.
- Common builds (gyan.dev, BtbN, Homebrew, most Linux packages) are configured with `--enable-gpl`, so those
  binaries are licensed under the **GNU GPL**. MP3 encoding uses LAME (`libmp3lame`). Source code and build
  details are available from the sites above and from https://ffmpeg.org/download.html.
- If you choose to redistribute FFmpeg binaries together with this app, you are responsible for meeting their
  license terms.
