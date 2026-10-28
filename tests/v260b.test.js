'use strict';
// Player compatibility check (Pioneer CDJ/XDJ): data, notes, a real conversion, settings, watcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const { convertOne } = require('../src/engine/convert');
const { runBatch, summarise } = require('../src/engine/batch');
const { NameAllocator } = require('../src/engine/naming');
const { FORMAT_KEYS } = require('../src/engine/formats');
const { createWatcher } = require('../src/engine/watcher');
const settings = require('../src/engine/settings');
const { PLAYERS, PLAYER_KEYS, playerIssues, playerNote, playerPreflight } = require('../src/engine/players');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v260b-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = { ...settings.defaults(tmp), QualityCheck: 'off', HealthCheck: false, DuplicateMode: 'off' };
let n = 0;
const fresh = (label) => { const d = path.join(tmp, `${label}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- data ----

test('players: every model has a label, formats, valid limits and the right flags', () => {
  assert.equal(PLAYER_KEYS.length, 10);
  for (const k of PLAYER_KEYS) {
    const p = PLAYERS[k];
    assert.ok(p.label && p.short, k);
    assert.ok(['manual', 'spec'].includes(p.confirmed), k);
    assert.ok(Object.keys(p.formats).length > 0, k);
    assert.ok(p.fs === null || (Array.isArray(p.fs) && p.fs.length > 0), k);
    for (const [fmt, f] of Object.entries(p.formats)) {
      assert.ok(FORMAT_KEYS.includes(fmt), `${k}: ${fmt}`);
      assert.ok(f.rate >= 44100 && f.rate <= 96000, k);
      assert.ok(f.depth === null || [16, 24].includes(f.depth), k);
    }
    assert.ok(p.formats.mp3 && p.formats.mp3.maxKbps === 320, k);
    assert.ok(!p.formats.opus, `${k}: Opus is listed by no model`);
    assert.ok(p.formats.wav && p.formats.aiff, k);
  }
});

test('players: no format claims beyond the published specs', () => {
  const has = (k, f) => Boolean(PLAYERS[k].formats[f]);
  for (const k of ['cdj2000', 'cdj850', 'cdj900nxs', 'cdj2000nxs']) assert.ok(!has(k, 'flac'), `${k}: no FLAC`);
  for (const k of ['cdj2000nxs2', 'cdj3000', 'cdjtour1', 'xdj1000mk2', 'xdjxz', 'xdjrx3']) assert.ok(has(k, 'flac'), `${k}: FLAC`);
  assert.equal(PLAYERS.cdj2000nxs2.formats.flac.rate, 96000);
  assert.equal(PLAYERS.cdj2000nxs.formats.wav.rate, 48000);
  assert.equal(PLAYERS.xdjrx3.formats.aiff.rate, 48000);
  assert.ok(!PLAYER_KEYS.includes('xdjrx2'));
  assert.deepEqual(PLAYERS.cdj2000nxs.fs, ['FAT16', 'FAT32', 'HFS+']);
  assert.equal(PLAYERS.cdj3000.fs, null);
  assert.equal(PLAYERS.cdj2000.fs, null);
  assert.ok(PLAYERS.xdjrx3.fs.includes('exFAT'));
});

// ---- notes ----

test('notes: formats, sample rates and bit depth', () => {
  assert.equal(playerNote('xdjrx3', { format: 'aiff', rate: 44100, depth: 16 }), '');
  assert.equal(playerNote('xdjrx3', { format: 'flac', rate: 48000, depth: 24 }), '');
  assert.equal(playerNote('cdj2000nxs', { format: 'aiff', rate: 44100, depth: 16 }), '');
  assert.equal(playerNote('cdj2000nxs', { format: 'flac', rate: 44100, depth: 16 }), 'CDJ-2000NXS: FLAC not supported');
  for (const k of PLAYER_KEYS) assert.equal(playerNote(k, { format: 'opus', rate: 48000 }), `${PLAYERS[k].short}: Opus not supported`);
  assert.equal(playerNote('cdj900nxs', { format: 'wav', rate: 96000, depth: 24 }), 'CDJ-900NXS: 96 kHz above the 48 kHz limit');
  assert.equal(playerNote('cdj2000nxs2', { format: 'wav', rate: 96000, depth: 24 }), '');
  assert.equal(playerNote('cdj2000nxs2', { format: 'wav', rate: 192000, depth: 24 }), 'CDJ-2000NXS2: 192 kHz above the 96 kHz limit');
  assert.equal(playerNote('cdj850', { format: 'wav', rate: 44100, depth: 24 }), 'CDJ-850: 24-bit not supported');
  assert.deepEqual(playerIssues('cdj850', { format: 'aiff', rate: 96000, depth: 24 }), ['96 kHz above the 48 kHz limit', '24-bit not supported']);
  assert.deepEqual(playerIssues('cdj850', { format: 'mp3', rate: 44100, depth: null }), []);
  assert.deepEqual(playerIssues('cdj850', { format: 'mp3', rate: 44100, depth: 24 }), [], 'bit depth does not apply to lossy output');
  assert.deepEqual(playerIssues('off', { format: 'opus' }), []);
  assert.equal(playerNote('nope', { format: 'opus' }), '');
});

test('preflight: one line per unlisted format, nothing for listed ones', () => {
  assert.deepEqual(playerPreflight('cdj2000nxs', ['flac', 'flac']), ["CDJ-2000NXS does not list FLAC as supported. Files will still be converted."]);
  assert.deepEqual(playerPreflight('cdj2000nxs', ['mp3', 'aiff']), []);
  assert.equal(playerPreflight('xdjxz', ['opus', 'flac']).length, 1);
  assert.deepEqual(playerPreflight('off', ['opus']), []);
});

test('summary mentions how many may not play', () => {
  const c = { OK: 3, WARN: 0, FAKE: 0, LOW: 0, SKIP: 0, FAIL: 0, PLAYER: 2 };
  assert.match(summarise(c, 'CDJ-2000NXS'), / 2 may not play on CDJ-2000NXS\./);
  assert.ok(!/may not play/.test(summarise({ ...c, PLAYER: 0 }, 'CDJ-2000NXS')));
});

// ---- settings ----

test('settings: PlayerModel is validated per key and is a preset key', () => {
  const d = settings.defaults(tmp);
  assert.equal(d.PlayerModel, 'off');
  assert.equal(settings.merge(d, { PlayerModel: 'cdj3000' }).PlayerModel, 'cdj3000');
  assert.equal(settings.merge({ ...d, PlayerModel: 'cdj3000' }, { PlayerModel: 'off' }).PlayerModel, 'off');
  for (const bad of ['xdjrx2', 'CDJ3000', '', 5, null, {}, ['cdj3000']]) assert.equal(settings.merge(d, { PlayerModel: bad }).PlayerModel, 'off', String(bad));
  assert.equal(settings.merge(d, { PlayerModel: 'bad', Bitrate: 256 }).Bitrate, 256, 'other keys survive');
  assert.ok(settings.PRESET_KEYS.includes('PlayerModel'));
  const list = settings.cleanPresets([{ name: 'p', options: { PlayerModel: 'xdjxz' } }, { name: 'q', options: { PlayerModel: 'zzz' } }]);
  assert.equal(list[0].options.PlayerModel, 'xdjxz');
  assert.equal(list[1].options.PlayerModel, undefined);
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const keys = /const PRESET_KEYS = \[([^\]]*)\]/.exec(rendererSrc)[1].match(/'(\w+)'/g).map((k) => k.slice(1, -1));
  assert.deepEqual(keys, settings.PRESET_KEYS, 'renderer and settings lists match');
});

test('menu select lists every model key and nothing else', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const sel = /<select id="setPlayer"[^>]*>(.*?)<\/select>/.exec(html)[1];
  const vals = [...sel.matchAll(/value="(\w+)">([^<]*)</g)];
  assert.deepEqual(vals.map((m) => m[1]), ['off', ...PLAYER_KEYS]);
  for (const [, k, label] of vals.slice(1)) assert.equal(label, PLAYERS[k].label);
});

// ---- real conversion ----

function tone(file, extra = []) {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...extra, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return file;
}
async function one(file, over) {
  const outDir = fresh('o');
  return convertOne({ file, outDir, tools, settings: { ...base, ...over }, allocator: new NameAllocator(), signal: new AbortController().signal });
}

test('convertOne: a format the model does not list is flagged; with the check off nothing is added', { skip }, async () => {
  const src = tone(path.join(fresh('s'), 'a.flac'), ['-metadata', 'artist=A', '-metadata', 'title=T']);
  const on = await one(src, { Format: 'flac', PlayerModel: 'cdj2000nxs' });
  assert.equal(on.status, 'OK');
  assert.equal(on.player, true);
  assert.ok(on.note.endsWith(' | CDJ-2000NXS: FLAC not supported'), on.note);
  const off = await one(src, { Format: 'flac', PlayerModel: 'off' });
  assert.equal(off.player, false);
  assert.ok(!/CDJ|XDJ/.test(off.note), off.note);
  const unset = await one(src, { Format: 'flac' });
  assert.equal(unset.player, false);
  const fine = await one(src, { Format: 'aiff', PlayerModel: 'cdj2000nxs' });
  assert.equal(fine.player, false);
  assert.ok(!/CDJ/.test(fine.note), fine.note);
  const opus = await one(src, { Format: 'opus', PlayerModel: 'xdjrx3' });
  assert.ok(opus.note.includes('XDJ-RX3: Opus not supported'), opus.note);
});

test('convertOne: rate and bit depth come from what was written', { skip }, async () => {
  const dir = fresh('s');
  const hi = tone(path.join(dir, 'hi.wav'), ['-ar', '96000']);
  const a = await one(hi, { Format: 'flac', PlayerModel: 'xdjxz' });
  assert.ok(a.note.includes('XDJ-XZ: 96 kHz above the 48 kHz limit'), a.note);
  const b = await one(hi, { Format: 'flac', PlayerModel: 'cdj2000nxs2' });
  assert.equal(b.player, false, b.note);
  const c = await one(hi, { Format: 'mp3', SampleRate: 44100, PlayerModel: 'cdj850' });
  assert.equal(c.player, false, 'lossy output is resampled to the chosen rate: ' + c.note);
  const d24 = await one(tone(path.join(dir, 'x.flac')), { Format: 'wav', BitDepth: 24, PlayerModel: 'cdj850' });
  assert.ok(d24.note.includes('CDJ-850: 24-bit not supported'), d24.note);
  const d16 = await one(tone(path.join(dir, 'y.flac')), { Format: 'wav', BitDepth: 16, PlayerModel: 'cdj850' });
  assert.equal(d16.player, false, d16.note);
  // copy mode keeps the source rate
  const mp3 = tone(path.join(dir, 'c.mp3'), ['-ar', '48000']);
  const cp = await one(mp3, { Format: 'mp3', CopyMode: true, PlayerModel: 'cdj850' });
  assert.ok(cp.note.startsWith('copied (no re-encode)'), cp.note);
  assert.equal(cp.player, false);
});

test('runBatch: counts, summary, event flag and one preflight line; never blocks', { skip }, async () => {
  const inDir = fresh('in');
  tone(path.join(inDir, 'a.flac'));
  tone(path.join(inDir, 'b.flac'), ['-metadata', 'title=B']);
  const events = [];
  const r = await runBatch({ inDir, outDir: fresh('out'), settings: { ...base, Format: 'opus', PlayerModel: 'cdj3000' }, tools, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  assert.equal(r.counts.OK, 2);
  assert.equal(r.counts.PLAYER, 2);
  assert.match(r.summary, / 2 may not play on CDJ-3000\./);
  const pre = events.filter((e) => e.type === 'message' && /does not list/.test(e.text));
  assert.equal(pre.length, 1);
  assert.equal(pre[0].level, 'info');
  assert.equal(pre[0].text, 'CDJ-3000 does not list Opus as supported. Files will still be converted.');
  const results = events.filter((e) => e.type === 'result');
  assert.ok(results.every((e) => e.player === true));
  const first = events.findIndex((e) => e.type === 'result');
  assert.ok(events.indexOf(pre[0]) < first, 'preflight comes before the first file');

  const quiet = [];
  const r2 = await runBatch({ inDir, outDir: fresh('out'), settings: { ...base, Format: 'flac', PlayerModel: 'cdj3000' }, tools, signal: new AbortController().signal, onEvent: (e) => quiet.push(e) });
  assert.equal(r2.counts.PLAYER, 0);
  assert.ok(!/may not play/.test(r2.summary));
  assert.ok(!quiet.some((e) => e.type === 'message' && /does not list/.test(e.text)));
  assert.ok(quiet.filter((e) => e.type === 'result').every((e) => e.player === false));

  const off = [];
  const r3 = await runBatch({ inDir, outDir: fresh('out'), settings: { ...base, Format: 'opus', PlayerModel: 'off' }, tools, signal: new AbortController().signal, onEvent: (e) => off.push(e) });
  assert.equal(r3.counts.PLAYER, 0);
  assert.ok(!off.some((e) => e.type === 'message' && /does not list/.test(e.text)));
});

// ---- watcher ----

test('watcher: the second output folder is never watched either (also via another spelling)', async () => {
  const dir = path.join(tmp, 'wd');
  const out = path.join(dir, 'out');
  const second = path.join(dir, 'second');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const got = [];
  const w = createWatcher({ dir, recurse: true, outDir: [out, path.join(second, '.', '')], onFiles: (f) => got.push(...f), stableMs: 300, pollMs: 200, tickMs: 80 });
  try {
    await sleep(150);
    fs.writeFileSync(path.join(second, 'copy.mp3'), 'x');
    fs.writeFileSync(path.join(out, 'main.mp3'), 'x');
    fs.mkdirSync(path.join(second, 'sub'));
    fs.writeFileSync(path.join(second, 'sub', 'deep.flac'), 'x');
    fs.writeFileSync(path.join(dir, 'real.mp3'), 'x');
    const deadline = Date.now() + 5000;
    while (!got.length && Date.now() < deadline) await sleep(100);
    await sleep(900);
    assert.deepEqual(got.map((f) => path.basename(f)), ['real.mp3']);
  } finally { w.stop(); }
});
