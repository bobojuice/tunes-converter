'use strict';
const fs = require('fs');
const path = require('path');
const { run } = require('./proc');

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Places to look, in order: a folder the user chose, a "bin" folder next to the app, the PATH, and the usual
// package-manager folders (a Mac app launched from Finder does not inherit the shell PATH).
function candidateDirs({ configuredDir, appDir, extraDirs = [] }) {
  const dirs = [];
  if (configuredDir) {
    dirs.push(isFile(configuredDir) ? path.dirname(configuredDir) : configuredDir);
  }
  if (appDir) dirs.push(path.join(appDir, 'bin'));
  for (const d of extraDirs) if (d) dirs.push(d);
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) dirs.push(d);
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin');
  if (process.platform === 'linux') dirs.push('/usr/local/bin', '/usr/bin', '/snap/bin');
  return [...new Set(dirs)];
}

// Returns { ffmpeg, ffprobe } (absolute paths) or null when either is missing.
function findTools(options) {
  const dirs = candidateDirs(options);
  for (const dir of dirs) {
    const ffmpeg = path.join(dir, exe('ffmpeg'));
    const ffprobe = path.join(dir, exe('ffprobe'));
    if (isFile(ffmpeg) && isFile(ffprobe)) return { ffmpeg, ffprobe };
  }
  let ffmpeg = null;
  let ffprobe = null;
  for (const dir of dirs) {
    if (!ffmpeg && isFile(path.join(dir, exe('ffmpeg')))) ffmpeg = path.join(dir, exe('ffmpeg'));
    if (!ffprobe && isFile(path.join(dir, exe('ffprobe')))) ffprobe = path.join(dir, exe('ffprobe'));
  }
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
}

// True when this ffmpeg has the named encoder (some minimal builds lack libmp3lame or libopus).
async function hasEncoder(ffmpeg, name) {
  const r = await run(ffmpeg, ['-hide_banner', '-encoders']);
  return r.code === 0 && new RegExp(`\\s${name}\\s`).test(r.stdout);
}

const hasMp3Encoder = (ffmpeg) => hasEncoder(ffmpeg, 'libmp3lame');

module.exports = { findTools, hasMp3Encoder, hasEncoder, candidateDirs, exe };
