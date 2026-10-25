'use strict';
// Optional helper (Windows): downloads ffmpeg.exe and ffprobe.exe from gyan.dev, checks the SHA-256 that site
// publishes, and copies the two files into destDir. Nothing is installed. The URL can be overridden for tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { run } = require('./proc');

const DEFAULT_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

function get(url, signal, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'TunesConverter' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), signal, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Download failed (HTTP ${res.statusCode}).`)); return; }
      resolve(res);
    });
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('Cancelled.')), { once: true });
  });
}

async function fetchText(url, signal) {
  const res = await get(url, signal);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchToFile(url, dest, onProgress, signal) {
  const res = await get(url, signal);
  const total = Number(res.headers['content-length']) || 0;
  let done = 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.on('data', (d) => { done += d.length; hash.update(d); if (onProgress) onProgress(done, total); });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  return hash.digest('hex');
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name.toLowerCase() === name && path.basename(dir).toLowerCase() === 'bin') return p;
  }
  return null;
}

async function downloadFfmpeg({ destDir, url = process.env.TC_FFMPEG_URL || DEFAULT_URL, onProgress, signal }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunesconverter-ffmpeg-'));
  try {
    const zip = path.join(tmp, 'ffmpeg.zip');
    const actual = await fetchToFile(url, zip, onProgress, signal);
    const expected = (await fetchText(`${url}.sha256`, signal)).trim().split(/\s+/)[0].toLowerCase();
    if (actual.toLowerCase() !== expected) throw new Error('Checksum mismatch. The download was discarded.');

    const extractDir = path.join(tmp, 'x');
    fs.mkdirSync(extractDir);
    const r = await run('tar', ['-xf', zip, '-C', extractDir], { signal });
    if (r.code !== 0) throw new Error(`Could not unpack the download: ${r.stderr.trim() || 'tar failed'}`);

    fs.mkdirSync(destDir, { recursive: true });
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const src = findFile(extractDir, name);
      if (!src) throw new Error(`${name} was not found in the download.`);
      fs.copyFileSync(src, path.join(destDir, name));
    }
    return destDir;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { downloadFfmpeg, DEFAULT_URL };
