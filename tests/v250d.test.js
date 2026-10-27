'use strict';
// v2.5 part d: watch runs keep sub-folder layout; watcher notices a missing songs folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const { runBatch } = require('../src/engine/batch');
const { createWatcher } = require('../src/engine/watcher');
const settings = require('../src/engine/settings');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v250d-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); };
const sig = () => new AbortController().signal;
const base = settings.defaults(tmp);

test('batch: inputs as {full, rel} mirror the sub-folder; strings stay flat', { skip }, async () => {
  const inDir = path.join(tmp, 'in');
  fs.mkdirSync(path.join(inDir, 'A', 'deep'), { recursive: true });
  const meta = ['-metadata', 'artist=Same', '-metadata', 'title=Song'];
  const mk = (f, t) => {
    const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2', ...meta, '-metadata', `title=${t}`, f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const top = path.join(inDir, 'top.flac');
  const sub = path.join(inDir, 'A', 'deep', 'x.flac');
  mk(top, 'Top');
  mk(sub, 'Sub');
  const out = path.join(tmp, 'out-rel');
  const r = await runBatch({
    inDir, outDir: out, tools, signal: sig(), onEvent: () => {},
    settings: { ...base, Format: 'mp3', QualityCheck: 'off' },
    inputs: [{ full: top, rel: '' }, { full: sub, rel: path.join('A', 'deep') }]
  });
  assert.equal(r.counts.OK, 2);
  assert.ok(fs.existsSync(path.join(out, 'Same - Top.mp3')));
  assert.ok(fs.existsSync(path.join(out, 'A', 'deep', 'Same - Sub.mp3')));

  const flat = path.join(tmp, 'out-flat');
  await runBatch({ inDir, outDir: flat, tools, signal: sig(), onEvent: () => {}, settings: { ...base, Format: 'mp3', QualityCheck: 'off' }, inputs: [top, sub] });
  assert.deepEqual(fs.readdirSync(flat).sort(), ['Same - Sub.mp3', 'Same - Top.mp3']);
});

test('watcher: songs folder deleted -> onMissing(true) once, no files; recreated -> onMissing(false) and resumes', async () => {
  const dir = path.join(tmp, 'wm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.mp3'), 'old');
  const events = [];
  const got = [];
  const w = createWatcher({ dir, onFiles: (f) => got.push(...f), onMissing: (m) => events.push(m), stableMs: 300, pollMs: 200, tickMs: 80 });
  try {
    await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(await until(() => events.length >= 1));
    await sleep(600);
    assert.deepEqual(events, [true]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.mp3'), 'old'); // comes back with its old content: not new
    assert.ok(await until(() => events.length >= 2));
    assert.deepEqual(events, [true, false]);
    await sleep(900);
    assert.equal(got.length, 0, 'old files of a returning folder were reported');
    fs.writeFileSync(path.join(dir, 'new.mp3'), 'audio');
    assert.ok(await until(() => got.length >= 1));
    assert.deepEqual(got.map((f) => path.basename(f)), ['new.mp3']);
  } finally { w.stop(); }
});
