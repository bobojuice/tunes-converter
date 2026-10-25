'use strict';
// Checks on what the window (renderer) is allowed to ask the main process to do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDirectory, rendererSettingsChanges, folderToOpen, createSlot } = require('../src/engine/guards');
const { checkUrl, entriesAreSafe, DEFAULT_URL } = require('../src/engine/download');
const { analyse } = require('../src/engine/specWorker');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-guards-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('openFolder: only directories resolve, files and executables do not', () => {
  const exe = path.join(tmp, 'evil.exe');
  fs.writeFileSync(exe, 'x');
  assert.equal(resolveDirectory(tmp), path.resolve(tmp));
  assert.equal(resolveDirectory(exe), null);
  assert.equal(resolveDirectory(path.join(tmp, 'missing')), null);
  assert.equal(resolveDirectory(''), null);
  assert.equal(resolveDirectory(undefined), null);
  assert.equal(resolveDirectory(`${tmp}\0`), null);
});

test('openFolder: the window names in/out, never a path; a saved file path is refused', () => {
  const file = path.join(tmp, 'a.exe');
  fs.writeFileSync(file, 'x');
  const s = { In: file, Out: tmp };
  assert.equal(folderToOpen('out', s), path.resolve(tmp));
  assert.equal(folderToOpen('in', s), null);
  assert.equal(folderToOpen(tmp, s), null);
  assert.equal(folderToOpen('C:\\Windows\\System32\\calc.exe', s), null);
});

test('settings: the window cannot change FfmpegDir', () => {
  const out = rendererSettingsChanges({ In: 'a', FfmpegDir: '\\\\evil\\share', Bitrate: 192 });
  assert.deepEqual(out, { In: 'a', Bitrate: 192 });
  assert.equal(rendererSettingsChanges(null), null);
  assert.equal(rendererSettingsChanges([1]), null);
});

test('batch slot: second start is refused at once, Stop reaches the reserved run, release frees it', () => {
  const slot = createSlot();
  const a = slot.take();
  assert.ok(a);
  assert.equal(slot.take(), null);
  slot.abort();
  assert.equal(a.signal.aborted, true);
  slot.release(new AbortController()); // not the owner: no effect
  assert.equal(slot.busy, true);
  slot.release(a);
  assert.equal(slot.busy, false);
  assert.ok(slot.take());
});

test('download: https and approved hosts only; http only for loopback overrides', () => {
  assert.ok(checkUrl(DEFAULT_URL, false));
  assert.ok(checkUrl('https://github.com/x', false));
  assert.throws(() => checkUrl('http://www.gyan.dev/a.zip', false), /Blocked/);
  assert.throws(() => checkUrl('https://evil.example/a.zip', false), /Blocked/);
  assert.throws(() => checkUrl('http://127.0.0.1:1/a.zip', false), /Blocked/);
  assert.throws(() => checkUrl('http://evil.example/a.zip', true), /Blocked/);
  assert.throws(() => checkUrl('file:///c:/a.zip', true), /Blocked/);
  assert.ok(checkUrl('http://127.0.0.1:1/a.zip', true));
});

test('download: archive entries with absolute or parent paths are rejected', () => {
  assert.equal(entriesAreSafe('ffmpeg-1/\nffmpeg-1/bin/ffmpeg.exe\n'), true);
  assert.equal(entriesAreSafe('../x.exe\n'), false);
  assert.equal(entriesAreSafe('a/../../x\n'), false);
  assert.equal(entriesAreSafe('/etc/x\n'), false);
  assert.equal(entriesAreSafe('C:\\x\n'), false);
});

test('quality: amplifying the same band-limited signal gives the same cutoff', () => {
  const sr = 44100;
  const n = sr * 4;
  const make = (gain) => {
    const a = new Float32Array(n);
    for (let f = 150; f <= 16000; f += 97) {
      const ph = f * 0.37;
      for (let i = 0; i < n; i++) a[i] += Math.sin((2 * Math.PI * f * i) / sr + ph);
    }
    let seed = 7;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      a[i] = (a[i] / 40 + (seed / 2 ** 32 - 0.5) * 2e-6) * gain; // faint noise floor, as a decoded lossy file has
    }
    return a;
  };
  const quiet = analyse(make(3), sr, 1);
  const loud = analyse(make(30), sr, 1);
  assert.equal(quiet.clamped, false);
  assert.equal(loud.clamped, false);
  assert.ok(quiet.cutoff > 15000 && quiet.cutoff < 17500, String(quiet.cutoff));
  assert.ok(Math.abs(quiet.cutoff - loud.cutoff) < 300, `${quiet.cutoff} vs ${loud.cutoff}`);
});