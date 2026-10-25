'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { joinArtists, safeName, buildName, NameAllocator, pickTag } = require('../src/engine/naming');
const settings = require('../src/engine/settings');
const { placeNoOverwrite } = require('../src/engine/convert');
const { estimateKbps } = require('../src/engine/quality');
const { summarise, samePath } = require('../src/engine/batch');

test('joinArtists merges ffprobe-style multi values', () => {
  assert.equal(joinArtists('Pola & Bryson;Cimone'), 'Pola & Bryson, Cimone');
  assert.equal(joinArtists(' A ; ; B '), 'A, B');
  assert.equal(joinArtists(''), '');
  assert.equal(joinArtists(undefined), '');
});

test('safeName replaces forbidden characters and trims', () => {
  assert.equal(safeName('AC/DC: Back?'), 'AC-DC- Back-');
  assert.equal(safeName('  Name...  '), 'Name');
  assert.equal(safeName('a\u0001b   c'), 'ab c');
});

test('buildName handles reserved names, fallback and length', () => {
  const outDir = path.join(os.tmpdir(), 'out');
  assert.equal(buildName({ artist: 'A', title: 'B', fallbackBase: 'x', outDir }), 'A - B');
  assert.equal(buildName({ artist: '', title: 'B', fallbackBase: 'file name', outDir }), 'file name');
  assert.equal(buildName({ artist: '', title: '', fallbackBase: 'CON', outDir }), '_CON');
  assert.equal(buildName({ artist: '', title: '', fallbackBase: '...', outDir }), '');
  const long = buildName({ artist: 'A'.repeat(300), title: 'T', fallbackBase: 'x', outDir });
  assert.ok(Buffer.byteLength(long) <= 200);
  const emoji = buildName({ artist: 'x', title: '\u{1F3B5}'.repeat(100), fallbackBase: 'x', outDir });
  assert.ok(Buffer.byteLength(emoji) <= 200);
});

test('NameAllocator never lets a generated suffix clash with a real title', () => {
  const a = new NameAllocator();
  assert.deepEqual(a.allocate('A - Song'), { name: 'A - Song', duplicate: false });
  assert.deepEqual(a.allocate('A - Song'), { name: 'A - Song (2)', duplicate: true });
  assert.deepEqual(a.allocate('A - Song (2)'), { name: 'A - Song (2) (2)', duplicate: true });
  assert.equal(a.allocate('a - song').name, 'a - song (3)');
});

test('pickTag is case-insensitive and checks every tag set', () => {
  assert.equal(pickTag([null, { ARTIST: 'X' }], 'artist'), 'X');
  assert.equal(pickTag([{ title: '' }, { TITLE: 'T' }], 'title'), 'T');
  assert.equal(pickTag([], 'artist'), '');
});

test('settings: each key is validated independently', () => {
  const base = settings.defaults('/home/u/Desktop');
  const merged = settings.merge(base, { Bitrate: 'bad', QualityCheck: 'skip', MinKbps: 192, SampleRate: 48000, In: '/x' });
  assert.equal(merged.Bitrate, 320);
  assert.equal(merged.QualityCheck, 'skip');
  assert.equal(merged.MinKbps, 192);
  assert.equal(merged.SampleRate, 48000);
  assert.equal(merged.In, '/x');
  assert.equal(settings.merge(base, { QualityCheck: 'nope', MinKbps: 999 }).QualityCheck, 'warn');
  assert.equal(settings.merge(base, null).Bitrate, 320);
});

test('settings: save/load round trip and corrupt file fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-settings-'));
  const file = path.join(dir, 'settings.json');
  const base = settings.defaults(dir);
  settings.save(file, base, { MinKbps: 256 });
  assert.equal(settings.load(file, base).MinKbps, 256);
  settings.save(file, base, { QualityCheck: 'skip' });
  assert.equal(settings.load(file, base).MinKbps, 256);
  fs.writeFileSync(file, '{not json');
  assert.equal(settings.load(file, base).MinKbps, 320);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('placeNoOverwrite never replaces an existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-place-'));
  const part = path.join(dir, 'a.part');
  const dest = path.join(dir, 'a.mp3');
  fs.writeFileSync(part, 'new');
  assert.equal(placeNoOverwrite(part, dest), true);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new');
  fs.writeFileSync(path.join(dir, 'b.part'), 'newer');
  fs.writeFileSync(path.join(dir, 'b.mp3'), 'old');
  assert.equal(placeNoOverwrite(path.join(dir, 'b.part'), path.join(dir, 'b.mp3')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'b.mp3'), 'utf8'), 'old');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('estimateKbps boundaries match the calibration', () => {
  assert.equal(estimateKbps(22050), 320);
  assert.equal(estimateKbps(20300), 320);
  assert.equal(estimateKbps(19600), 256);
  assert.equal(estimateKbps(18900), 192);
  assert.equal(estimateKbps(17600), 160);
  assert.equal(estimateKbps(16800), 128);
});

test('summarise and samePath', () => {
  assert.equal(summarise({ OK: 3, WARN: 0, FAKE: 0, LOW: 0, SKIP: 1, FAIL: 0 }), 'Done: 3 converted, 1 skipped, 0 failed.');
  assert.match(summarise({ OK: 1, WARN: 1, FAKE: 1, LOW: 1, SKIP: 0, FAIL: 0 }), /2 converted.*1 flagged.*2 not converted.*1 of them fakes/);
  assert.equal(samePath('/a/b', '/a/b/'), true);
  assert.equal(samePath('/a/b', '/a/c'), false);
});
