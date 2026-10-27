'use strict';
// v2.5 part c: review fixes (health output size, watch run terminal event, watcher canonical paths, watch status).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { run } = require('../src/engine/proc');
const { checkHealth } = require('../src/engine/health');
const { findTools } = require('../src/engine/tools');
const { createWatcher, watchPlan } = require('../src/engine/watcher');
const { withTerminalEvent } = require('../src/engine/guards');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v250c-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); };

// ---- 1. health: output stays small, a size limit is never "corrupt" ----
test('proc: tailBytes keeps only the end of a huge stdout and never kills the process', async () => {
  const script = 'let s="";for(let i=0;i<300000;i++){s+="line "+i+"\\n";if(s.length>60000){process.stdout.write(s);s=""}}process.stdout.write(s+"LAST\\n")';
  const r = await run(process.execPath, ['-e', script], { tailBytes: 64 * 1024, maxBytes: 1024 });
  assert.equal(r.code, 0);
  assert.equal(r.truncated, false);
  assert.ok(r.stdout.length < 256 * 1024, `kept ${r.stdout.length} bytes`);
  assert.ok(r.stdout.trimEnd().endsWith('LAST'));
});

test('health: a long file is not flagged corrupt (output stays small)', { skip }, async () => {
  const file = path.join(tmp, 'long.flac');
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=900', '-f', 'lavfi', '-i', 'sine=f=660:d=900',
    '-filter_complex', 'amerge=inputs=2', '-c:a', 'flac', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=sample_rate,channels:format=duration', '-of', 'json', file], { encoding: 'utf8' }).stdout;
  const j = JSON.parse(out);
  const h = await checkHealth({ ffmpeg: tools.ffmpeg, file, audio: j.streams[0], format: j.format, signal: new AbortController().signal });
  assert.deepEqual(h.flags, []);
});

// ---- 2. a watch run always ends with a terminal event ----
test('withTerminalEvent: early return, throw and cancel each send one done; a normal run sends none extra', async () => {
  const run1 = async (work) => {
    const evs = [];
    let err = null;
    try { await withTerminalEvent((e) => evs.push(e), work); } catch (e) { err = e; }
    return { evs, err };
  };
  const early = await run1(async () => ({ ok: false, cancelled: true }));
  assert.deepEqual(early.evs.map((e) => e.type), ['done']);
  assert.equal(early.evs[0].stopped, true);
  const noTools = await run1(async (emit) => { emit({ type: 'message', text: 'x', level: 'error' }); return { ok: false }; });
  assert.deepEqual(noTools.evs.map((e) => e.type), ['message', 'done']);
  const thrown = await run1(async () => { throw new Error('boom'); });
  assert.equal(thrown.err.message, 'boom');
  assert.deepEqual(thrown.evs.map((e) => e.type), ['done']);
  const normal = await run1(async (emit) => { emit({ type: 'done', summary: 's', counts: {}, stopped: false }); return { ok: true }; });
  assert.equal(normal.evs.length, 1);
  assert.equal(normal.evs[0].synthetic, undefined);
});

// ---- 3. watcher compares canonical paths ----
function makeDirLink(target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}

test('watcher: an alias (junction/symlink) of the output folder inside the input tree is not re-enqueued', async (t) => {
  const real = path.join(tmp, 'w-real');
  const out = path.join(real, 'out');
  fs.mkdirSync(out, { recursive: true });
  const alias = path.join(tmp, 'w-alias');
  if (!makeDirLink(real, alias)) return t.skip('cannot create a directory link here');
  const got = [];
  // the output folder is given through the alias, the songs folder by its real path
  const w = createWatcher({ dir: real, recurse: true, outDir: path.join(alias, 'out'), onFiles: (f) => got.push(...f), stableMs: 300, pollMs: 200, tickMs: 80 });
  try {
    await sleep(150);
    fs.writeFileSync(path.join(out, 'converted.mp3'), 'x');
    fs.writeFileSync(path.join(real, 'new.mp3'), 'audio');
    assert.ok(await until(() => got.length >= 1));
    await sleep(900);
    assert.deepEqual(got.map((f) => path.basename(f)), ['new.mp3']);
  } finally { w.stop(); }
});

test('watcher: the same file reached through an alias is handled once', async (t) => {
  const real = path.join(tmp, 's-real');
  fs.mkdirSync(real, { recursive: true });
  const alias = path.join(tmp, 's-alias');
  if (!makeDirLink(real, alias)) return t.skip('cannot create a directory link here');
  fs.writeFileSync(path.join(real, 'old.mp3'), 'old');
  const got = [];
  const w = createWatcher({ dir: alias, recurse: false, onFiles: (f) => got.push(...f), stableMs: 300, pollMs: 200, tickMs: 80 });
  try {
    await sleep(900);
    assert.equal(got.length, 0, 'a file present before the watch started was reported');
  } finally { w.stop(); }
});

// ---- 4. real watcher status ----
test('watchPlan: reports whether the watch can run, and why not', () => {
  const inDir = path.join(tmp, 'p-in');
  const outDir = path.join(tmp, 'p-out');
  fs.mkdirSync(inDir, { recursive: true });
  assert.deepEqual(watchPlan({ WatchFolder: false, In: inDir, Out: outDir }), { ok: false, reason: '' });
  assert.deepEqual(watchPlan({ WatchFolder: true, In: inDir, Out: outDir }), { ok: true, reason: '' });
  assert.equal(watchPlan({ WatchFolder: true, In: path.join(tmp, 'nope'), Out: outDir }).reason, 'songs folder missing');
  assert.equal(watchPlan({ WatchFolder: true, In: '', Out: outDir }).reason, 'songs folder not set');
  assert.equal(watchPlan({ WatchFolder: true, In: inDir, Out: '' }).reason, 'output folder not set');
  const same = watchPlan({ WatchFolder: true, In: inDir, Out: inDir + path.sep });
  assert.equal(same.ok, false);
  assert.equal(same.reason, 'songs and output folder are the same');
});
