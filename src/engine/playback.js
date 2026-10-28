'use strict';
// Playback preview: decodes a converted track to a temporary WAV the window can play. Nothing here ever writes to,
// or changes, a music file or the output folder; only files inside this app's own temp folder are created or deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./proc');

const AUDIO_EXTS = ['.mp3', '.m4a', '.flac', '.wav', '.aiff', '.aif', '.opus'];
const MAX_WAV_BYTES = 1.5 * 1024 * 1024 * 1024;
const TEMP_PREFIX = 'tunes-converter-play-';
const FOLD = process.platform === 'win32' || process.platform === 'darwin';

const real = (p) => fs.realpathSync.native(p);

// True only when the real location of `file` is inside the real location of `root`.
function insideRoot(root, file) {
  try {
    let r = real(root);
    let f = real(file);
    if (FOLD) { r = r.toLowerCase(); f = f.toLowerCase(); }
    const rel = path.relative(r, f);
    if (!rel) return false; // the root itself is not a file inside it
    return !rel.split(/[\\/]/).includes('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

// `rel` comes from the window. Returns the real absolute path of an audio file inside the output folder, or null.
function resolvePlayable(rel, outDir) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\0')) return null;
  if (typeof outDir !== 'string' || !outDir) return null;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || /^[\\/]/.test(rel)) return null;
  if (rel.split(/[\\/]/).includes('..')) return null;
  if (!AUDIO_EXTS.includes(path.extname(rel).toLowerCase())) return null;
  try {
    const file = real(path.join(outDir, rel));
    if (!fs.statSync(file).isFile()) return null;
    return insideRoot(outDir, file) ? file : null;
  } catch {
    return null;
  }
}

function createPlayer({ tempBase = os.tmpdir() } = {}) {
  let tempRoot = null;
  let gen = 0;
  let ctrl = null;
  let current = null; // { token, file }
  let n = 0;

  const rm = (f) => { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } };
  const clearCurrent = () => {
    if (current) rm(current.file);
    current = null;
  };
  const cancelRunning = () => {
    gen++;
    if (ctrl) ctrl.abort();
    ctrl = null;
  };

  async function prepare(ffmpegExe, srcFile) {
    cancelRunning();
    clearCurrent();
    const mine = gen;
    const c = new AbortController();
    ctrl = c;
    let out;
    try {
      if (!tempRoot || !fs.existsSync(tempRoot)) tempRoot = fs.mkdtempSync(path.join(tempBase, `${TEMP_PREFIX}${process.pid}-`));
      out = path.join(tempRoot, `track-${++n}.wav`);
    } catch (err) {
      return { ok: false, error: `Could not create a temporary folder: ${err.message}` };
    }
    let tooBig = false;
    const timer = setInterval(() => {
      try {
        if (fs.statSync(out).size > MAX_WAV_BYTES) { tooBig = true; c.abort(); }
      } catch { /* not created yet */ }
    }, 500);
    let r;
    try {
      r = await run(ffmpegExe, ['-nostdin', '-v', 'error', '-i', srcFile, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', out], { signal: c.signal });
    } finally {
      clearInterval(timer);
    }
    if (mine !== gen) { rm(out); return { ok: false, cancelled: true }; }
    ctrl = null;
    if (tooBig) { rm(out); return { ok: false, error: 'That track is too long to preview.' }; }
    if (r.aborted) { rm(out); return { ok: false, cancelled: true }; }
    let size = 0;
    try { size = fs.statSync(out).size; } catch { /* missing */ }
    if (r.code !== 0 || size < 44) {
      rm(out);
      const detail = (r.stderr || '').trim().split(/\r?\n/).pop() || 'unknown error';
      return { ok: false, error: `Could not decode that track: ${detail}` };
    }
    const token = crypto.randomBytes(12).toString('hex');
    current = { token, file: out };
    return { ok: true, token };
  }

  function resolveToken(token) {
    if (!current || typeof token !== 'string' || token !== current.token) return null;
    if (!tempRoot || !insideRoot(tempRoot, current.file)) return null;
    return current.file;
  }

  function stop() {
    cancelRunning();
    clearCurrent();
  }

  function dispose() {
    stop();
    if (tempRoot) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      tempRoot = null;
    }
  }

  return { prepare, resolveToken, stop, dispose, get tempRoot() { return tempRoot; } };
}

// Removes temp folders left by crashed runs. Folders newer than maxAgeMs may belong to another running copy.
function sweepStale(tempBase = os.tmpdir(), maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    for (const e of fs.readdirSync(tempBase, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith(TEMP_PREFIX)) continue;
      try {
        const dir = path.join(tempBase, e.name);
        if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* skip this one */ }
    }
  } catch { /* nothing to sweep */ }
}

// Decides what the tcplay:// handler serves. Pure: the caller does the file reading.
function serveDecision(url, resolveToken) {
  if (typeof url !== 'string') return { ok: false, status: 403 };
  const m = /^tcplay:\/\/track\/([0-9a-f]{24})$/.exec(url);
  if (!m) return { ok: false, status: 403 };
  let file = null;
  try { file = resolveToken(m[1]); } catch { file = null; }
  return file ? { ok: true, file } : { ok: false, status: 404 };
}

// What to send for a (possibly ranged) request of a file of `size` bytes: a known length and byte ranges let the
// audio element learn the duration and seek.
function rangeFor(size, header) {
  if (!header) return { status: 200, start: 0, end: size - 1 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return { status: 416 };
  let start;
  let end;
  if (m[1] === '') { // last N bytes
    const n = Number(m[2]);
    if (!n) return { status: 416 };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return { status: 416 };
  return { status: 206, start, end };
}

module.exports = { rangeFor, AUDIO_EXTS, insideRoot, resolvePlayable, createPlayer, sweepStale, serveDecision, MAX_WAV_BYTES };
