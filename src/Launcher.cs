using System;
using System.Diagnostics;
using System.IO;

// Tiny launcher: starts TunesConverter.ps1 (next to this exe) in a hidden Windows PowerShell,
// so the app can be opened with a double-click and shows only its own window.
static class Launcher {
    static void Main() {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(dir, "TunesConverter.ps1") + "\"");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process.Start(psi);
    }
}
