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
// Only Windows is folded: realpath already returns the on-disk case, and on a case-sensitive Mac volume two folders
// that differ only in case are different folders.
const FOLD = process.platform === 'win32';

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
    if (current) { rm(current.file); if (current.art) rm(current.art); }
    current = null;
  };
  const cancelRunning = () => {
    gen++;
    if (ctrl) ctrl.abort();
    ctrl = null;
  };

  // Claims "the newest request" synchronously, before the caller awaits anything, so an older request that finishes
  // its setup later cannot cancel a newer one, and a stop() in between voids the claim.
  function reserve() {
    cancelRunning();
    clearCurrent();
    return gen;
  }

  async function prepare(ffmpegExe, srcFile, ticket) {
    if (ticket === undefined) ticket = reserve();
    else if (ticket !== gen) return { ok: false, cancelled: true };
    const mine = ticket;
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
    if (size > MAX_WAV_BYTES) { rm(out); return { ok: false, error: 'That track is too long to preview.' }; }
    if (r.code !== 0 || size < 44) {
      rm(out);
      const detail = (r.stderr || '').trim().split(/\r?\n/).pop() || 'unknown error';
      return { ok: false, error: `Could not decode that track: ${detail}` };
    }
    // Waveform and cover art are extras: either failing just means no waveform / no art.
    const artFile = path.join(tempRoot, `art-${n}.jpg`);
    const cleanup = () => { rm(out); rm(artFile); };
    ctrl = c;
    let wf = { peaks: new Uint8Array(0), perSec: 100, duration: 0 };
    let hasArt = false;
    try {
      wf = await waveformPeaks(out);
      if (mine !== gen) { cleanup(); return { ok: false, cancelled: true }; }
      const ar = await run(ffmpegExe, ['-nostdin', '-v', 'error', '-i', srcFile, '-an', '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=420:420:force_original_aspect_ratio=decrease', '-y', artFile], { signal: c.signal });
      if (mine !== gen || ar.aborted) { cleanup(); return { ok: false, cancelled: true }; }
      let asz = 0;
      try { asz = fs.statSync(artFile).size; } catch { /* no art */ }
      if (ar.code === 0 && asz > 0) hasArt = true; else rm(artFile);
    } catch {
      rm(artFile);
    }
    if (mine !== gen) { cleanup(); return { ok: false, cancelled: true }; }
    ctrl = null;
    const token = crypto.randomBytes(12).toString('hex');
    current = { token, file: out, art: hasArt ? artFile : null };
    return { ok: true, token, peaks: wf.peaks, perSec: wf.perSec, duration: wf.duration, hasArt };
  }

  function resolveToken(token) {
    if (!current || typeof token !== 'string' || token !== current.token) return null;
    if (!tempRoot || !insideRoot(tempRoot, current.file)) return null;
    return current.file;
  }

  function resolveArt(token) {
    if (!current || !current.art || typeof token !== 'string' || token !== current.token) return null;
    if (!tempRoot || !insideRoot(tempRoot, current.art)) return null;
    return current.art;
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

  return { reserve, prepare, resolveToken, resolveArt, stop, dispose, get tempRoot() { return tempRoot; } };
}

// The folder name carries the process id of the copy that made it; a running copy (even a suspended one) keeps it.
function ownerAlive(name) {
  const m = new RegExp(`^${TEMP_PREFIX}(\\d+)-`).exec(name);
  if (!m) return false;
  try { process.kill(Number(m[1]), 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Removes temp folders left by crashed runs. Folders newer than maxAgeMs may belong to another running copy.
function sweepStale(tempBase = os.tmpdir(), maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    for (const e of fs.readdirSync(tempBase, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith(TEMP_PREFIX)) continue;
      try {
        const dir = path.join(tempBase, e.name);
        if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs && !ownerAlive(e.name)) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* skip this one */ }
    }
  } catch { /* nothing to sweep */ }
}

// Decides what the tcplay:// handler serves. Pure: the caller does the file reading.
function serveDecision(url, resolveToken, resolveArt) {
  if (typeof url !== 'string') return { ok: false, status: 403 };
  const m = /^tcplay:\/\/(track|art)\/([0-9a-f]{24})$/.exec(url);
  if (!m) return { ok: false, status: 403 };
  const isArt = m[1] === 'art';
  const resolver = isArt ? resolveArt : resolveToken;
  let file = null;
  try { file = typeof resolver === 'function' ? resolver(m[2]) : null; } catch { file = null; }
  return file ? { ok: true, file, kind: isArt ? 'image' : 'audio' } : { ok: false, status: 404 };
}

const MAX_PEAKS = 100 * 60 * 60;

// Per-bin max |sample| (0..255) of a 16-bit PCM WAV, read as a stream. Never throws.
async function waveformPeaks(wavFile, perSec = 100) {
  const empty = () => ({ peaks: new Uint8Array(0), perSec, duration: 0 });
  let fh;
  try {
    if (!(perSec > 0)) return empty();
    fh = await fs.promises.open(wavFile, 'r');
    const fileSize = (await fh.stat()).size;
    // Walk the RIFF chunks for fmt and data.
    const head = Buffer.alloc(12);
    if ((await fh.read(head, 0, 12, 0)).bytesRead < 12) return empty();
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return empty();
    let pos = 12;
    let channels = 0; let bits = 0; let rate = 0; let fmtTag = 0;
    let dataStart = -1; let dataLen = 0;
    const ch = Buffer.alloc(8);
    while (pos + 8 <= fileSize) {
      if ((await fh.read(ch, 0, 8, pos)).bytesRead < 8) break;
      const id = ch.toString('latin1', 0, 4);
      const len = ch.readUInt32LE(4);
      if (id === 'fmt ') {
        const f = Buffer.alloc(16);
        if ((await fh.read(f, 0, 16, pos + 8)).bytesRead < 16) return empty();
        fmtTag = f.readUInt16LE(0); channels = f.readUInt16LE(2); rate = f.readUInt32LE(4); bits = f.readUInt16LE(14);
      } else if (id === 'data') {
        dataStart = pos + 8;
        dataLen = len;
        break;
      }
      pos += 8 + len + (len & 1);
    }
    if (dataStart < 0 || !channels || !rate || bits !== 16 || (fmtTag !== 1 && fmtTag !== 0xFFFE)) return empty();
    const avail = fileSize - dataStart;
    if (dataLen === 0 || dataLen === 0xFFFFFFFF || dataLen > avail) dataLen = avail;
    const frameBytes = channels * 2;
    const totalFrames = Math.floor(dataLen / frameBytes);
    if (totalFrames <= 0) return empty();
    // Exact (fractional) bin length, widened for very long tracks so the bins always cover the whole duration;
    // `effPerSec` is the true bin rate the window must use for timing.
    const binFrames = Math.max(1, rate / perSec, totalFrames / MAX_PEAKS);
    const effPerSec = rate / binFrames;
    const bins = Math.min(MAX_PEAKS, Math.ceil(totalFrames / binFrames));
    const peaks = new Uint8Array(bins);
    const maxArr = new Int32Array(bins);
    const CHUNK = 1024 * 1024 - ((1024 * 1024) % frameBytes);
    let frame = 0; // global frame index
    let carry = Buffer.alloc(0);
    const end = dataStart + totalFrames * frameBytes - 1;
    const stream = fs.createReadStream(wavFile, { start: dataStart, end, highWaterMark: CHUNK });
    for await (let buf of stream) {
      if (carry.length) { buf = Buffer.concat([carry, buf]); carry = Buffer.alloc(0); }
      const whole = buf.length - (buf.length % frameBytes);
      if (whole < buf.length) carry = Buffer.from(buf.subarray(whole));
      const samples = whole / 2;
      for (let i = 0; i < samples; i++) {
        const bin = Math.floor((frame + Math.floor(i / channels)) / binFrames);
        if (bin >= bins) break;
        let v = buf.readInt16LE(i * 2);
        if (v < 0) v = -v;
        if (v > maxArr[bin]) maxArr[bin] = v;
      }
      frame += whole / frameBytes;
    }
    for (let b = 0; b < bins; b++) peaks[b] = Math.min(255, Math.max(0, Math.round(maxArr[b] / 32768 * 255)));
    return { peaks, perSec: effPerSec, duration: totalFrames / rate };
  } catch {
    return empty();
  } finally {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
  }
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

module.exports = { rangeFor, AUDIO_EXTS, insideRoot, resolvePlayable, createPlayer, sweepStale, serveDecision, waveformPeaks, MAX_WAV_BYTES };
