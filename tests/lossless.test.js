'use strict';
// WAV / FLAC bit depth (32-bit float sources), naming templates, tag modes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const { runBatch } = require('../src/engine/batch');
const naming = require('../src/engine/naming');
const settings = require('../src/engine/settings');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lossless-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const base = settings.defaults(tmp);
const sig = () => new AbortController().signal;

function ff(args) {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function probeStream(file) {
  const out = spawnSync(tools.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_fmt,bits_per_raw_sample,bits_per_sample', '-of', 'json', file], { encoding: 'utf8' }).stdout;
  return JSON.parse(out).streams[0];
}
function tagsOf(file) {
  const out = spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', file], { encoding: 'utf8' }).stdout;
  const j = JSON.parse(out);
  const all = { ...(j.format && j.format.tags), ...((j.streams && j.streams[0] && j.streams[0].tags) || {}) };
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]));
}

function makeFloatWav(dir, name = 'float.wav') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:a', 'pcm_f32le', '-metadata', 'artist=A', '-metadata', 'title=T', file]);
  assert.equal(probeStream(file).sample_fmt, 'flt', 'the test source must really be 32-bit float');
  return dir;
}

for (const [format, depth, check] of [
  ['wav', 16, (s) => assert.equal(s.codec_name, 'pcm_s16le')],
  ['wav', 24, (s) => assert.equal(s.codec_name, 'pcm_s24le')],
  ['flac', 16, (s) => { assert.equal(s.sample_fmt, 's16'); assert.equal(String(s.bits_per_raw_sample), '16'); }],
  ['flac', 24, (s) => { assert.equal(s.sample_fmt, 's32'); assert.equal(String(s.bits_per_raw_sample), '24'); }]
]) {
  test(`${format}: a 32-bit float source comes out ${depth}-bit`, { skip }, async () => {
    const inDir = makeFloatWav(path.join(tmp, `in-${format}-${depth}`));
    const out = path.join(tmp, `out-${format}-${depth}`);
    const r = await runBatch({ inDir, outDir: out, settings: { ...base, Format: format, BitDepth: depth, QualityCheck: 'off' }, tools, signal: sig(), onEvent: () => {} });
    assert.equal(r.counts.OK, 1, JSON.stringify(r.counts));
    const file = path.join(out, `A - T.${format}`);
    assert.ok(fs.existsSync(file));
    check(probeStream(file));
  });
}

test('wav keeps artist and title tags', { skip }, async () => {
  const inDir = makeFloatWav(path.join(tmp, 'in-wavtags'));
  const out = path.join(tmp, 'out-wavtags');
  await runBatch({ inDir, outDir: out, settings: { ...base, Format: 'wav', QualityCheck: 'off' }, tools, signal: sig(), onEvent: () => {} });
  const t = tagsOf(path.join(out, 'A - T.wav'));
  assert.equal(t.artist, 'A');
  assert.equal(t.title, 'T');
});

test('naming: template validation, filling, and track/year helpers', () => {
  assert.equal(naming.validTemplate('{artist} - {title}'), true);
  assert.equal(naming.validTemplate('{track} {artist} - {title} ({year})'), true);
  assert.equal(naming.validTemplate('no placeholders'), false);
  assert.equal(naming.validTemplate('{bogus}'), false);
  assert.equal(naming.validTemplate('{artist'), false);
  assert.equal(naming.validTemplate('x'.repeat(200) + '{artist}'), false);
  assert.equal(naming.validTemplate(5), false);
  const f = { artist: 'A', title: 'T', album: '', track: '03', year: '2020' };
  assert.equal(naming.applyTemplate('{track} - {artist} - {title}', f), '03 - A - T');
  assert.equal(naming.applyTemplate('{artist} - {album}', f), '', 'a missing field means "use the file name"');
  assert.equal(naming.trackNumber('3/12'), '03');
  assert.equal(naming.trackNumber('abc'), '');
  assert.equal(naming.yearOf('2019-05-01'), '2019');
  const s = settings.merge(settings.defaults(tmp), { NameTemplate: '{bogus}', TagMode: 'x', BitDepth: 32 });
  assert.equal(s.NameTemplate, '{artist} - {title}');
  assert.equal(s.TagMode, 'keep');
  assert.equal(s.BitDepth, 16);
  assert.equal(settings.merge(s, { NameTemplate: '{title}', TagMode: 'strip', BitDepth: 24 }).BitDepth, 24);
});

function makeTagged(dir) {
  fs.mkdirSync(dir, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-metadata', 'artist=A', '-metadata', 'title=T', '-metadata', 'album=Alb', '-metadata', 'track=3/12',
    '-metadata', 'comment=secret note', '-metadata', 'date=2020', path.join(dir, 'orig-name.flac')]);
  fs.writeFileSync(path.join(dir, 'untagged-source.txt'), 'ignored');
  return dir;
}

test('naming template is used for file names, and falls back to the file name when a field is missing', { skip }, async () => {
  const inDir = makeTagged(path.join(tmp, 'in-template'));
  const run = async (name, template) => {
    const out = path.join(tmp, name);
    await runBatch({ inDir, outDir: out, settings: { ...base, Format: 'flac', QualityCheck: 'off', NameTemplate: template }, tools, signal: sig(), onEvent: () => {} });
    return fs.readdirSync(out);
  };
  assert.deepEqual(await run('o-t1', '{track} - {artist} - {title}'), ['03 - A - T.flac']);
  assert.deepEqual(await run('o-t2', '{title}'), ['T.flac']);
  assert.deepEqual(await run('o-t3', '{albumartist} - {title}'), ['orig-name.flac'], 'no album artist tag: file name is kept');
});

test('tag modes: keep everything, keep the main fields only, or strip all', { skip }, async () => {
  const inDir = makeTagged(path.join(tmp, 'in-tagmode'));
  const run = async (mode) => {
    const out = path.join(tmp, `o-${mode}`);
    await runBatch({ inDir, outDir: out, settings: { ...base, Format: 'mp3', QualityCheck: 'off', TagMode: mode, NameTemplate: '{artist} - {title}' }, tools, signal: sig(), onEvent: () => {} });
    const names = fs.readdirSync(out);
    assert.equal(names.length, 1);
    return tagsOf(path.join(out, names[0]));
  };
  const keep = await run('keep');
  assert.equal(keep.comment, 'secret note');
  assert.equal(keep.album, 'Alb');
  const clean = await run('clean');
  assert.equal(clean.artist, 'A');
  assert.equal(clean.title, 'T');
  assert.equal(clean.album, 'Alb');
  assert.equal(clean.comment, undefined, 'comments are dropped');
  const strip = await run('strip');
  assert.equal(strip.artist, undefined);
  assert.equal(strip.title, undefined);
  assert.equal(strip.album, undefined);
});

test('naming: a reserved Windows name created by truncation is still escaped', () => {
  const outDir = path.join(tmp, 'x'.repeat(200)); // long output path, so the name is cut short
  const name = naming.buildName({ artist: '', title: '', fallbackBase: `CON ${'.'.repeat(30)}X`, outDir });
  assert.doesNotMatch(name, /^(CON|PRN|AUX|NUL)$/i);
  assert.equal(name, '_CON');
});
