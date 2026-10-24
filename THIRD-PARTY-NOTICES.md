# Third-party notices

Tunes Converter (MIT, see `LICENSE`) runs **FFmpeg** (`ffmpeg.exe`, `ffprobe.exe`) as a separate program.
It does not link against FFmpeg or include its code, and the release zips do not contain FFmpeg.

## FFmpeg

- Project: https://ffmpeg.org (legal information: https://ffmpeg.org/legal.html)
- Users add FFmpeg themselves (see `docs/HOWTO.md`). The optional `Get-FFmpeg.ps1` helper downloads a Windows
  build from https://www.gyan.dev/ffmpeg/builds/ onto the user's own computer, and checks its published checksum.
- Common Windows builds (gyan.dev, BtbN) are configured with `--enable-gpl`, so those binaries are licensed under
  the **GNU GPL**. MP3 encoding uses LAME (`libmp3lame`). Source code and build details are available from the
  sites above and from https://ffmpeg.org/download.html.
- If you choose to redistribute FFmpeg binaries together with this app, you are responsible for meeting their
  license terms.
