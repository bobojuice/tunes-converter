'use strict';
// v2.5 part b: report file, sharing presets, folder watch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReport, writeReport } = require('../src/engine/report');
const presetshare = require('../src/engine/presetshare');
const settings = require('../src/engine/settings');
const { createWatcher } = require('../src/engine/watcher');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v250b-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); };

// ---- report ----
test('report: header, rows, quoting', () => {
  const csv = buildReport([
    { status: 'OK', name: 'A - B.mp3', note: 'copied (no re-encode)', peak: -0.34, health: false },
    { status: 'WARN', name: 'Say "hi", ok.mp3', note: 'line1\nline2', peak: null, health: true, duplicate: true }
  ], { startedAt: new Date('2026-10-27T10:00:00Z'), summary: 'Done: 2 converted.', format: 'mp3' });
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], 'status,file,notes,health,peak_db,duplicate');
  assert.equal(lines[1], 'OK,A - B.mp3,copied (no re-encode),no,-0.3,no');
  assert.ok(csv.includes('"Say ""hi"", ok.mp3"'));
  assert.ok(csv.includes('"line1\nline2"'));
  assert.ok(csv.includes(',yes,,yes')); // health yes, no peak, duplicate yes
  assert.ok(csv.includes('# summary,Done: 2 converted.'));
});

test('report: formula injection is defused', () => {
  const csv = buildReport([{ status: 'OK', name: '=HYPERLINK("http://x")', note: '+1', peak: null }, { status: 'OK', name: '@SUM(1)', note: '-2' }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(csv.includes(",'+1,"));
  assert.ok(csv.includes("'@SUM(1)"));
  assert.ok(csv.includes(",'-2,"));
  for (const line of csv.split('\r\n').slice(1)) assert.ok(!/(^|,)[=+\-@]/.test(line.replace(/"[^"]*"/g, '"x"')) || line.startsWith('#'));
});

test('report: never overwrites an existing report', () => {
  const dir = path.join(tmp, 'rep');
  const now = new Date(2026, 9, 27, 14, 5, 9);
  const a = writeReport(dir, 'one', now);
  const b = writeReport(dir, 'two', now);
  const c = writeReport(dir, 'three', now);
  assert.equal(path.basename(a), 'Tunes Converter report 2026-10-27 140509.csv');
  assert.equal(path.basename(b), 'Tunes Converter report 2026-10-27 140509-2.csv');
  assert.equal(path.basename(c), 'Tunes Converter report 2026-10-27 140509-3.csv');
  assert.equal(fs.readFileSync(a, 'utf8'), 'one');
  assert.equal(fs.readFileSync(b, 'utf8'), 'two');
});

// ---- share presets ----
const mk = (name, fmt = 'mp3') => ({ name, options: { Format: fmt, Bitrate: 192 } });

test('presetshare: round trip', () => {
  const list = [mk('DJ USB', 'aiff'), mk('Phone')];
  const text = presetshare.serialize(list);
  const file = JSON.parse(text);
  assert.equal(file.app, 'Tunes Converter');
  assert.equal(file.kind, 'presets');
  assert.equal(file.version, 1);
  const back = presetshare.parse(text);
  assert.deepEqual(back, settings.cleanPresets(list));
  const m = presetshare.merge([], back);
  assert.equal(m.added, 2);
  assert.equal(m.skipped, 0);
});

test('presetshare: name clashes are skipped ignoring case, limit respected', () => {
  const m = presetshare.merge([mk('DJ USB')], [mk('dj usb'), mk('New')]);
  assert.equal(m.added, 1);
  assert.equal(m.skipped, 1);
  assert.deepEqual(m.presets.map((p) => p.name), ['DJ USB', 'New']);
  const full = Array.from({ length: 19 }, (_, i) => mk(`p${i}`));
  const m2 = presetshare.merge(full, [mk('a'), mk('b'), mk('c')]);
  assert.equal(m2.presets.length, settings.MAX_PRESETS);
  assert.equal(m2.added, 1);
  assert.equal(m2.skipped, 2);
});

test('presetshare: hostile input is rejected or cleaned', () => {
  assert.throws(() => presetshare.parse('not json'));
  assert.throws(() => presetshare.parse(JSON.stringify({ app: 'Tunes Converter', kind: 'other', presets: [] })));
  assert.throws(() => presetshare.parse(JSON.stringify({ app: 'x', kind: 'presets', presets: [] })));
  assert.throws(() => presetshare.parse(JSON.stringify({ app: 'Tunes Converter', kind: 'presets', presets: 'no' })));
  assert.throws(() => presetshare.parse('null'));
  assert.throws(() => presetshare.parse('x'.repeat(presetshare.MAX_FILE_BYTES + 1)));
  const many = Array.from({ length: 60 }, (_, i) => mk(`n${i}`));
  const bad = [
    mk('x'.repeat(41)), mk(''), mk('ctl\u0001'), null, 5, { name: 7, options: {} }, { name: 'noopts' },
    { name: 'evil', options: { Format: 'exe', Bitrate: 999, In: 'C:\\evil', FfmpegDir: 'C:\\evil', NameTemplate: '../../{x}', WinW: 1 } },
    ...many
  ];
  const parsed = presetshare.parse(JSON.stringify({ app: 'Tunes Converter', kind: 'presets', version: 1, presets: bad }));
  assert.ok(parsed.length <= settings.MAX_PRESETS);
  const evil = parsed.find((p) => p.name === 'evil');
  assert.deepEqual(evil.options, {});
  assert.ok(!parsed.some((p) => p.name.length > 40 || /[\u0000-\u001f]/.test(p.name)));
});

// ---- watcher ----
const fast = { stableMs: 300, pollMs: 200, tickMs: 80 };

test('watcher: new music file is reported once it is stable; old files, non-music and output are ignored', async () => {
  const dir = path.join(tmp, 'w1');
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.mp3'), 'old');
  const got = [];
  const w = createWatcher({ dir, recurse: true, outDir: out, onFiles: (f) => got.push(...f), ...fast });
  try {
    await sleep(150);
    fs.writeFileSync(path.join(dir, 'new.mp3'), 'audio');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'text');
    fs.writeFileSync(path.join(out, 'converted.mp3'), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'deep.flac'), 'audio');
    assert.ok(await until(() => got.length >= 2));
    await sleep(800);
    assert.deepEqual(got.map((f) => path.basename(f)).sort(), ['deep.flac', 'new.mp3']);
  } finally { w.stop(); }
});

test('watcher: a growing file is waited for', async () => {
  const dir = path.join(tmp, 'w2');
  fs.mkdirSync(dir);
  const got = [];
  const w = createWatcher({ dir, onFiles: (f) => got.push(...f), ...fast });
  try {
    const file = path.join(dir, 'big.wav');
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) { fs.appendFileSync(file, 'chunk'); await sleep(150); }
    assert.equal(got.length, 0, 'reported while still growing');
    assert.ok(await until(() => got.length === 1));
    assert.ok(Date.now() - t0 >= 900 + 250);
  } finally { w.stop(); }
});

test('watcher: files wait while busy, then arrive together; stop() ends it', async () => {
  const dir = path.join(tmp, 'w3');
  fs.mkdirSync(dir);
  let busy = true;
  const batches = [];
  const w = createWatcher({ dir, isBusy: () => busy, onFiles: (f) => batches.push(f), ...fast });
  fs.writeFileSync(path.join(dir, 'a.mp3'), 'a');
  fs.writeFileSync(path.join(dir, 'b.mp3'), 'b');
  await sleep(1000);
  assert.equal(batches.length, 0);
  busy = false;
  assert.ok(await until(() => batches.length === 1));
  assert.equal(batches[0].length, 2);
  w.stop();
  fs.writeFileSync(path.join(dir, 'c.mp3'), 'c');
  await sleep(900);
  assert.equal(batches.length, 1);
});
