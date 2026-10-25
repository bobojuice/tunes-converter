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

module.exports = { resolveDirectory, rendererSettingsChanges, folderToOpen, createSlot };
