'use strict';
// Checks for values that arrive from the window (renderer) before the main process acts on them.
const fs = require('fs');
const path = require('path');

// A resolved absolute path only if it is an existing directory; anything else (a file, an .exe, a missing path) is null.
function resolveDirectory(p) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  try {
    const abs = path.resolve(p);
    return fs.statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

// Settings the window may change. FfmpegDir selects code to run, so only the native folder picker may set it.
function rendererSettingsChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const { FfmpegDir, ...rest } = changes; // eslint-disable-line no-unused-vars
  return rest;
}

// Which folder "open folder" may open: the saved input or output folder, chosen by name, never a path from the window.
function folderToOpen(which, s) {
  if (which !== 'in' && which !== 'out') return null;
  return resolveDirectory(which === 'in' ? s.In : s.Out);
}

// What was dropped on the window: a folder (becomes the songs folder), music files, or nothing usable.
// `extensions` is a Set of lower-case extensions such as '.flac'.
function classifyDrop(paths, extensions) {
  if (!Array.isArray(paths)) return { kind: 'none' };
  const list = paths.filter((p) => typeof p === 'string' && p && !p.includes('\0')).slice(0, 5000);
  const dir = list.map(resolveDirectory).find(Boolean);
  if (dir) return { kind: 'folder', dir };
  const files = [];
  for (const p of list) {
    try {
      const abs = path.resolve(p);
      if (fs.statSync(abs).isFile() && extensions.has(path.extname(abs).toLowerCase())) files.push(abs);
    } catch { /* not readable: ignore */ }
  }
  return files.length ? { kind: 'files', files } : { kind: 'none' };
}

// One-at-a-time operation slot. take() succeeds synchronously (before any await) or returns null.
function createSlot() {
  let owner = null;
  return {
    take() {
      if (owner) return null;
      owner = new AbortController();
      return owner;
    },
    release(ctrl) { if (owner === ctrl) owner = null; },
    abort() { if (owner) owner.abort(); },
    get busy() { return owner !== null; }
  };
}

// Runs `work(onEvent)` and guarantees the window gets exactly one terminal 'done' event, whatever way the work ends
// (normal finish, early return, cancelled, exception).
async function withTerminalEvent(emit, work) {
  let finished = false;
  const onEvent = (ev) => { if (ev && ev.type === 'done') finished = true; emit(ev); };
  try {
    return await work(onEvent);
  } finally {
    if (!finished) {
      // `synthetic`: not from a finished conversion; the window only uses it to leave its "running" state
      emit({ type: 'done', summary: 'Stopped.', counts: {}, stopped: true, synthetic: true });
    }
  }
}

module.exports = { classifyDrop, resolveDirectory, rendererSettingsChanges, folderToOpen, createSlot, withTerminalEvent };
