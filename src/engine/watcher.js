'use strict';
const fs = require('fs');
const path = require('path');
const { EXTENSIONS, canon, sameFolder } = require('./batch');

const MAX_DEPTH = 20;

// Watches the songs folder for NEW music files. Files that already exist when watching starts are never converted
// (they belong to a normal START run); only files that appear afterwards are, once their size has stopped changing
// for `stableMs`. Each file is handled once per watch session. While `isBusy()` is true, ready files wait and are
// handed over afterwards in one list. fs.watch is only a hint to look sooner; if it fails (or is not supported for
// the folder) a scan every `pollMs` finds the files instead.
function createWatcher({ dir, recurse = false, outDir = '', isBusy = () => false, onFiles, onLog = () => {}, onMissing = () => {}, stableMs = 2000, pollMs = 3000, tickMs = 500 }) {
  // Canonical keys (symlinks, junctions and 8.3 names resolved) so another spelling of the same place compares equal.
  const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const key = (p) => fold(canon(p).replace(/[\\/]+$/, ''));
  const outAbs = outDir ? key(outDir) : '';
  const inOut = (p) => { if (!outAbs) return false; const k = key(p); return k === outAbs || k.startsWith(outAbs + path.sep); };

  const known = new Set(); // handled, or present before the watch started
  const pending = new Map(); // path -> { size, since }
  const ready = [];
  let fsw = null;
  let timer = null;
  let stopped = false;
  let lastScan = 0;
  let hint = false;
  let missing = false;

  function walk(current, depth, out) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase())) { if (!inOut(full)) out.push(full); }
      else if (recurse && e.isDirectory() && depth < MAX_DEPTH && !inOut(full)) walk(full, depth + 1, out);
    }
    return out;
  }

  for (const f of walk(dir, 0, [])) known.add(key(f));

  const dirExists = () => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

  function closeFsw() { if (fsw) { try { fsw.close(); } catch { /* already closed */ } fsw = null; } }

  function startFsw() {
    try {
      // Recursive watching is native on Windows and macOS (and recent Node on Linux); if it throws, polling still covers it.
      fsw = fs.watch(dir, { recursive: Boolean(recurse) }, () => { hint = true; });
      fsw.on('error', () => {
        closeFsw();
        if (!dirExists()) { goMissing(); return; }
        onLog('Folder watching fell back to checking every few seconds.');
      });
    } catch {
      fsw = null;
      if (dirExists()) onLog('Folder watching fell back to checking every few seconds.');
    }
  }

  // The songs folder disappeared (deleted, drive unmounted): stop quietly, tell the owner once, resume if it returns.
  function goMissing() {
    if (missing) return;
    missing = true;
    closeFsw();
    pending.clear();
    ready.length = 0;
    onMissing(true);
  }

  function comeBack() {
    missing = false;
    known.clear(); // whatever is in the returning folder is old, not new
    for (const f of walk(dir, 0, [])) known.add(key(f));
    startFsw();
    onMissing(false);
  }

  function scan() {
    lastScan = Date.now();
    if (!dirExists()) { goMissing(); return; }
    if (missing) comeBack();
    for (const f of walk(dir, 0, [])) if (!known.has(key(f)) && !pending.has(f)) pending.set(f, { size: -1, since: 0 });
  }

  function check() {
    const now = Date.now();
    for (const [f, p] of pending) {
      let size;
      try { size = fs.statSync(f).size; } catch { pending.delete(f); continue; } // vanished (temporary file)
      if (size !== p.size) { p.size = size; p.since = now; continue; }
      if (size > 0 && now - p.since >= stableMs) { pending.delete(f); known.add(key(f)); ready.push(f); }
    }
  }

  function tick() {
    if (stopped) return;
    try {
      if (hint || Date.now() - lastScan >= pollMs) { hint = false; scan(); }
      check();
      if (ready.length && !isBusy()) {
        const files = ready.splice(0, ready.length);
        onFiles(files);
      }
    } catch (err) {
      onLog(`Watch problem: ${err.message}`);
    }
  }

  startFsw();
  timer = setInterval(tick, tickMs);
  if (timer.unref) timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      closeFsw();
      pending.clear();
      ready.length = 0;
    }
  };
}

// Can the folder watch actually run with these settings? -> { ok, reason } (reason '' when ok or when watching is off)
function watchPlan(s) {
  if (!s.WatchFolder) return { ok: false, reason: '' };
  if (!s.In) return { ok: false, reason: 'songs folder not set' };
  let isDir = false;
  try { isDir = fs.statSync(s.In).isDirectory(); } catch { isDir = false; }
  if (!isDir) return { ok: false, reason: 'songs folder missing' };
  if (!s.Out) return { ok: false, reason: 'output folder not set' };
  if (sameFolder(s.In, s.Out)) return { ok: false, reason: 'songs and output folder are the same' };
  return { ok: true, reason: '' };
}

module.exports = { createWatcher, watchPlan };
