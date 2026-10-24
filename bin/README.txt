Put ffmpeg.exe and ffprobe.exe in this folder (directly inside it, not in a sub-folder).

Easiest: run the optional helper from the main folder:
    powershell -ExecutionPolicy Bypass -File .\Get-FFmpeg.ps1

Or download a Windows build yourself from https://www.gyan.dev/ffmpeg/builds/ or
https://github.com/BtbN/FFmpeg-Builds/releases, open its "bin" folder and copy the two files here.

If they are missing here, Tunes Converter uses any ffmpeg/ffprobe found on your PATH.
Full instructions: docs\HOWTO.md
