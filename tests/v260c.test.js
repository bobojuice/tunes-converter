'use strict';
// Review fixes for 2.6.0: folder links, second-output safety for dropped files, watch recovery, rate lists, long folder names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const { convertOne } = require('../src/engine/convert');
const { runBatch } = require('../src/engine/batch');
const { NameAllocator, folderPath } = require('../src/engine/naming');
const { watchAction, watchOutDirs } = require('../src/engine/watcher');
const { PLAYERS, playerNote, playerIssues } = require('../src/engine/players');
const settings = require('../src/engine/settings');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v260c-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const base = { ...settings.defaults(tmp), QualityCheck: 'off', HealthCheck: false, DuplicateMode: 'off' };
const sig = () => new AbortController().signal;
let n = 0;
const fresh = (label) => { const d = path.join(tmp, `${label}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

function song(dir, file, tags = {}, extra = []) {
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...extra, ...meta, path.join(dir, file)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return path.join(dir, file);
}
const files = (dir) => { try { return fs.readdirSync(dir, { recursive: true }); } catch { return []; } };
async function run(args) {
  const events = [];
  const r = await runBatch({ tools, signal: sig(), onEvent: (e) => events.push(e), ...args });
  return { r, events, results: events.filter((e) => e.type === 'result'), messages: events.filter((e) => e.type === 'message').map((e) => e.text) };
}

// ---- 1. folder links ----

test('folder template: a junction/symlink inside the output folder cannot carry files out', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'Linked', title: 'One' });
  song(inDir, 'b.flac', { artist: 'Fine', title: 'Two' });
  const out = fresh('out');
  const elsewhere = fresh('elsewhere');
  try { fs.symlinkSync(elsewhere, path.join(out, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; } // links not supported here
  const { r, results } = await run({ inDir, outDir: out, settings: { ...base, Format: 'mp3', FolderTemplate: '{artist}' } });
  assert.equal(r.counts.FAIL, 1);
  assert.equal(r.counts.OK, 1);
  const bad = results.find((e) => e.status === 'FAIL');
  assert.match(bad.note, /folder is a link that leads outside the output folder/);
  assert.deepEqual(files(elsewhere), [], 'nothing was written through the link');
  assert.ok(fs.existsSync(path.join(out, 'Fine', 'Fine - Two.mp3')));
});

test('mirrored sub-folder that is a link outside the output folder fails that file', { skip }, async () => {
  const src = fresh('src');
  const f = song(src, 'a.flac');
  const out = fresh('out');
  const elsewhere = fresh('elsewhere');
  try { fs.symlinkSync(elsewhere, path.join(out, 'sub'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
  const { results } = await run({ inDir: '', outDir: out, settings: { ...base, Format: 'mp3' }, inputs: [{ full: f, rel: 'sub' }] });
  assert.equal(results[0].status, 'FAIL');
  assert.match(results[0].note, /leads outside the output folder/);
  assert.deepEqual(files(elsewhere), []);
});

// ---- 2. second output with dropped files ----

test('dropped files: the second copy is off when its folder is the folder of a dropped file or the main output', { skip }, async () => {
  const src = fresh('src');
  const f = song(src, 'a.flac', { title: 'A' });
  const out = fresh('out');
  const a = await run({ inDir: '', outDir: out, settings: { ...base, Format: 'mp3', SecondFormat: 'wav', SecondOut: src }, inputs: [f] });
  assert.ok(a.messages.some((m) => /Second copy is off/.test(m)));
  assert.deepEqual(files(src), ['a.flac'], 'nothing written beside the source');
  assert.equal(a.r.counts.SECOND, 0);
  const b = await run({ inDir: '', outDir: out, settings: { ...base, Format: 'mp3', SecondFormat: 'wav', SecondOut: path.join(src, '.', '') }, inputs: [{ full: f, rel: '' }] });
  assert.ok(b.messages.some((m) => /Second copy is off/.test(m)));
  const c = await run({ inDir: '', outDir: out, settings: { ...base, Format: 'mp3', SecondFormat: 'wav', SecondOut: out }, inputs: [f] });
  assert.ok(c.messages.some((m) => /Second copy is off/.test(m)));
  const second = fresh('second');
  const d = await run({ inDir: '', outDir: out, settings: { ...base, Format: 'mp3', SecondFormat: 'wav', SecondOut: second }, inputs: [f] });
  assert.equal(d.r.counts.SECOND, 1, 'a different folder still works');
});

// ---- 3 + 4. watch decisions ----

test('watchAction: a missing songs folder keeps or starts a recovery watcher, also after a settings sync', () => {
  const inDir = fresh('in');
  const out = fresh('out');
  const missing = path.join(tmp, 'gone-songs');
  const on = { WatchFolder: true, In: inDir, Out: out, SecondFormat: 'off', SecondOut: '', Recurse: false };
  const first = watchAction(on, { hasWatcher: false });
  assert.equal(first.action, 'start');
  assert.deepEqual(first.info, { active: true, reason: '' });
  assert.equal(watchAction(on, { hasWatcher: true, key: first.key }).action, 'keep');
  // the folder is missing from the start: a recovery watcher is started, not nothing
  const gone = { ...on, In: missing };
  const g1 = watchAction(gone, { hasWatcher: false });
  assert.equal(g1.action, 'start');
  assert.deepEqual(g1.info, { active: false, reason: 'songs folder missing' });
  // an unrelated settings sync must keep it
  const g2 = watchAction({ ...gone, Format: 'flac' }, { hasWatcher: true, key: g1.key, missing: true });
  assert.equal(g2.action, 'keep');
  assert.deepEqual(g2.info, { active: false, reason: 'songs folder missing' });
  // a changed output folder restarts it (still recovering)
  assert.equal(watchAction({ ...gone, Out: fresh('out2') }, { hasWatcher: true, key: g1.key, missing: true }).action, 'start');
  // things that cannot recover stop the watch
  assert.equal(watchAction({ ...gone, Out: '' }, { hasWatcher: true, key: g1.key }).action, 'stop');
  assert.equal(watchAction({ ...gone, Out: gone.In }, { hasWatcher: true, key: g1.key }).action, 'stop');
  assert.equal(watchAction({ ...on, In: '' }, {}).action, 'stop');
  assert.equal(watchAction({ ...on, WatchFolder: false }, { hasWatcher: true, key: first.key }).action, 'stop');
});

test('watchOutDirs: the second output is excluded only while the second copy is on', () => {
  const s = { Out: 'C:\\out', SecondOut: 'C:\\songs', SecondFormat: 'off' };
  assert.deepEqual(watchOutDirs(s), ['C:\\out'], 'retained SecondOut with the second copy off is ignored');
  assert.deepEqual(watchOutDirs({ ...s, SecondFormat: 'flac' }), ['C:\\out', 'C:\\songs']);
  assert.deepEqual(watchOutDirs({ ...s, SecondFormat: 'flac', SecondOut: '  ' }), ['C:\\out']);
  assert.deepEqual(watchOutDirs({ ...s, SecondFormat: undefined }), ['C:\\out']);
  // a second folder equal to the songs or output folder is switched off by the batch, so it must not hide the songs
  const songs = fresh('songs');
  const outF = fresh('outf');
  assert.deepEqual(watchOutDirs({ In: songs, Out: outF, SecondFormat: 'flac', SecondOut: songs }), [outF]);
  assert.deepEqual(watchOutDirs({ In: songs, Out: outF, SecondFormat: 'flac', SecondOut: outF }), [outF]);
  // turning the second copy on or off restarts the watcher so the exclusion follows
  const inDir = fresh('in');
  const o = fresh('o');
  const w = { WatchFolder: true, In: inDir, Out: o, SecondOut: path.join(tmp, 'x2'), Recurse: false };
  const a = watchAction({ ...w, SecondFormat: 'off' }, {});
  assert.equal(watchAction({ ...w, SecondFormat: 'flac' }, { hasWatcher: true, key: a.key }).action, 'start');
});

// ---- 5 + 6. rate sets and CDJ-850 24-bit ----

test('players: exact rate sets, CDJ-850 24-bit, unknowns are not flagged', () => {
  assert.equal(playerNote('cdj2000nxs2', { format: 'wav', rate: 22050, depth: 16 }), 'CDJ-2000NXS2: 22.05 kHz not in its list of supported rates (44.1, 48, 88.2, 96 kHz)');
  assert.equal(playerNote('cdj2000nxs2', { format: 'wav', rate: 88200, depth: 24 }), '');
  assert.equal(playerNote('xdjrx3', { format: 'wav', rate: 32000, depth: 16 }), 'XDJ-RX3: 32 kHz not in its list of supported rates (44.1, 48 kHz)', '32 kHz is below 48 kHz but not in the list');
  assert.equal(playerNote('xdjrx3', { format: 'mp3', rate: 32000 }), '');
  assert.equal(playerNote('cdj3000', { format: 'mp3', rate: 32000 }), 'CDJ-3000: 32 kHz not in its list of supported rates (44.1, 48 kHz)');
  assert.equal(playerNote('cdj2000nxs', { format: 'mp3', rate: 22050 }), '');
  assert.equal(playerNote('cdj850', { format: 'mp3', rate: 22050 }), 'CDJ-850: 22.05 kHz not in its list of supported rates (32, 44.1, 48 kHz)');
  // CDJ-850 lists 24-bit WAV/AIFF
  assert.equal(playerNote('cdj850', { format: 'wav', rate: 48000, depth: 24 }), '');
  assert.equal(playerNote('cdj850', { format: 'aiff', rate: 44100, depth: 24 }), '');
  // CDJ-TOUR1: lossless rates listed, depths and lossy rates unconfirmed -> never flagged
  assert.deepEqual(playerIssues('cdjtour1', { format: 'wav', rate: 96000, depth: 24 }), []);
  assert.deepEqual(playerIssues('cdjtour1', { format: 'mp3', rate: 22050 }), []);
  assert.equal(playerNote('cdjtour1', { format: 'flac', rate: 192000, depth: 24 }), 'CDJ-TOUR1: 192 kHz not in its list of supported rates (44.1, 48, 88.2, 96 kHz)');
  for (const k of Object.keys(PLAYERS)) for (const f of Object.values(PLAYERS[k].formats)) {
    if (f.rates) assert.ok(f.rates.every((x) => Number.isInteger(x)), k);
  }
});

test('a copied 22.05 kHz WAV on the CDJ-2000NXS2 gets a rate note', { skip }, async () => {
  const dir = fresh('s');
  const wav = song(dir, 'low.wav', {}, ['-ar', '22050']);
  const res = await convertOne({ file: wav, outDir: fresh('o'), tools, settings: { ...base, Format: 'wav', BitDepth: 16, CopyMode: true, PlayerModel: 'cdj2000nxs2' }, allocator: new NameAllocator(), signal: sig() });
  assert.ok(res.note.startsWith('copied (no re-encode)'), res.note);
  assert.equal(res.player, true);
  assert.ok(res.note.includes('22.05 kHz not in its list of supported rates (44.1, 48, 88.2, 96 kHz)'), res.note);
});

// ---- 7. second-output player flag ----

test('second copy: the player flag and count come from the second file too', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { title: 'A' });
  const second = fresh('second');
  // main output MP3 is fine on the CDJ-2000NXS; the second copy FLAC is not listed
  const { r, results, messages } = await run({ inDir, outDir: fresh('out'), settings: { ...base, Format: 'mp3', SecondFormat: 'flac', SecondOut: second, PlayerModel: 'cdj2000nxs' } });
  const two = results.find((e) => e.second);
  assert.equal(two.player, true);
  assert.ok(two.note.includes('FLAC not supported'), two.note);
  assert.equal(results.find((e) => !e.second).player, false);
  assert.equal(r.counts.PLAYER, 1);
  assert.ok(messages.some((m) => /1 may not play on CDJ-2000NXS/.test(m)));
});

// ---- 8. folder name cap ----

test('folder names: a reserved name prefixed with "_" still fits the 80 character cap', () => {
  const longReserved = 'CON.' + 'x'.repeat(76); // exactly 80 characters, reserved
  assert.equal(Array.from(longReserved).length, 80);
  const p = folderPath('{artist}', { artist: longReserved });
  assert.ok(p.startsWith('_CON.'), p);
  assert.ok(Array.from(p).length <= 80, `length ${Array.from(p).length}`);
  assert.equal(folderPath('{artist}', { artist: 'CON' }), '_CON');
  assert.ok(!/[. ]$/.test(folderPath('{artist}', { artist: 'NUL.' + 'y'.repeat(75) + '.' })));
});
