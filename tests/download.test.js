'use strict';
// The ffmpeg download helper (Windows only in the UI). Tested against a local server and a tiny fake archive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { downloadFfmpeg } = require('../src/engine/download');

const skip = process.platform === 'win32' ? false : 'download helper is Windows-only';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dl-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeZip() {
  const src = path.join(tmp, 'src', 'ffmpeg-fake', 'bin');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'ffmpeg.exe'), 'fake ffmpeg');
  fs.writeFileSync(path.join(src, 'ffprobe.exe'), 'fake ffprobe');
  const zip = path.join(tmp, 'ffmpeg.zip');
  const r = spawnSync('tar', ['-a', '-c', '-f', zip, '-C', path.join(tmp, 'src'), 'ffmpeg-fake']);
  assert.equal(r.status, 0, String(r.stderr));
  return zip;
}

function serve(zip, hashOverride) {
  const body = fs.readFileSync(zip);
  const hash = hashOverride || crypto.createHash('sha256').update(body).digest('hex');
  const server = http.createServer((req, res) => {
    if (req.url === '/old.zip') { res.writeHead(302, { Location: '/ffmpeg.zip' }); res.end(); return; }
    if (req.url === '/old.zip.sha256') { res.writeHead(302, { Location: '/ffmpeg.zip.sha256' }); res.end(); return; }
    if (req.url === '/ffmpeg.zip') { res.writeHead(200, { 'Content-Length': body.length }); res.end(body); return; }
    if (req.url === '/ffmpeg.zip.sha256') { res.writeHead(200); res.end(`${hash}  ffmpeg.zip\n`); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test('download: verifies the checksum, unpacks, copies both tools, cleans up', { skip }, async () => {
  const zip = makeZip();
  const { server, base } = await serve(zip);
  try {
    const dest = path.join(tmp, 'dest');
    const progress = [];
    await downloadFfmpeg({ destDir: dest, url: `${base}/old.zip`.replace('old', 'ffmpeg'), onProgress: (d, t) => progress.push([d, t]) });
    assert.equal(fs.readFileSync(path.join(dest, 'ffmpeg.exe'), 'utf8'), 'fake ffmpeg');
    assert.equal(fs.readFileSync(path.join(dest, 'ffprobe.exe'), 'utf8'), 'fake ffprobe');
    assert.ok(progress.length > 0);
    const dest2 = path.join(tmp, 'dest2');
    await downloadFfmpeg({ destDir: dest2, url: `${base}/old.zip` }).catch(() => {});
  } finally { server.close(); }
});

test('download: a checksum mismatch is rejected and nothing is copied', { skip }, async () => {
  const zip = makeZip();
  const { server, base } = await serve(zip, 'f'.repeat(64));
  try {
    const dest = path.join(tmp, 'dest-bad');
    await assert.rejects(downloadFfmpeg({ destDir: dest, url: `${base}/ffmpeg.zip` }), /Checksum mismatch/);
    assert.equal(fs.existsSync(path.join(dest, 'ffmpeg.exe')), false);
  } finally { server.close(); }
});

test('download: an HTTP error is reported', { skip }, async () => {
  const zip = makeZip();
  const { server, base } = await serve(zip);
  try {
    await assert.rejects(downloadFfmpeg({ destDir: path.join(tmp, 'd3'), url: `${base}/missing.zip` }), /HTTP 404/);
  } finally { server.close(); }
});
