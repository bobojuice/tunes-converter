# Third-party notices

Tunes Converter (MIT, see `LICENSE`) runs **FFmpeg** (`ffmpeg.exe`, `ffprobe.exe`) as a separate program.
It does not link against FFmpeg or include its code.

## FFmpeg

- Project: https://ffmpeg.org (legal information: https://ffmpeg.org/legal.html)
- The release zip may bundle a Windows build from https://github.com/BtbN/FFmpeg-Builds.
  That build is configured with `--enable-gpl --enable-version3`, so the binaries are licensed under the
  **GNU GPL v3**. MP3 encoding uses LAME (`libmp3lame`).
- Source code for FFmpeg is available from https://ffmpeg.org/download.html and the build scripts from the
  BtbN repository above.
- If you redistribute the bundled binaries, you are responsible for meeting the GPL's terms. A zip made with
  `Make-Release.ps1 -NoFfmpeg` contains no FFmpeg code.
