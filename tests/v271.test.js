'use strict';
// Open folder mode and the PlayNext setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openMode } = require('../src/engine/guards');
const settings = require('../src/engine/settings');

test('openMode: only a .app on macOS is revealed, everything else is opened', () => {
  assert.equal(openMode('/Applications/Foo.app', 'darwin'), 'reveal');
  assert.equal(openMode('/Applications/FOO.APP', 'darwin'), 'reveal');
  assert.equal(openMode('/Applications/Foo.app/', 'darwin'), 'reveal');
  assert.equal(openMode('/Users/me/Music', 'darwin'), 'open');
  assert.equal(openMode('/Users/me/app', 'darwin'), 'open');
  assert.equal(openMode('C:\\Music\\Foo.app', 'win32'), 'open');
  assert.equal(openMode('/home/me/Foo.app', 'linux'), 'open');
});

test('openMode: a neutral-named link to an .app is revealed too', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-openmode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Foo.app');
  const link = path.join(root, 'Music');
  fs.mkdirSync(app);
  fs.symlinkSync(app, link, 'junction');
  assert.equal(openMode(link, 'darwin'), 'reveal');
  assert.equal(openMode(link, 'linux'), 'open');
  assert.equal(openMode(path.join(root, 'missing'), 'darwin'), 'open');
});

test('PlayNext: default true, rejects non-boolean, not a preset key', () => {
  assert.equal(settings.defaults('/d').PlayNext, true);
  const base = settings.defaults('/d');
  assert.equal(settings.merge(base, { PlayNext: false }).PlayNext, false);
  assert.equal(settings.merge(base, { PlayNext: 'no' }).PlayNext, true);
  assert.equal(settings.merge(base, { PlayNext: 0 }).PlayNext, true);
  assert.ok(!settings.PRESET_KEYS.includes('PlayNext'));
});

// ---- Opus cover art (METADATA_BLOCK_PICTURE) ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const { pictureBlock, pictureMetadata } = require('../src/engine/art');
const { convertOne } = require('../src/engine/convert');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp271 = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v271-'));
test.after(() => fs.rmSync(tmp271, { recursive: true, force: true }));
let n271 = 0;
const fresh271 = () => { const d = path.join(tmp271, `d${++n271}`); fs.mkdirSync(d, { recursive: true }); return d; };

test('pictureBlock: FLAC PICTURE layout, big-endian, base64 round trip', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 7, 0, 0, 0, 5]), Buffer.alloc(10, 1)]);
  const b = pictureBlock(png);
  assert.equal(b.length, 4 + 4 + 9 + 4 + 20 + png.length);
  assert.equal(b.readUInt32BE(0), 3);
  assert.equal(b.readUInt32BE(4), 9);
  assert.equal(b.subarray(8, 17).toString(), 'image/png');
  assert.equal(b.readUInt32BE(17), 0);
  assert.equal(b.readUInt32BE(21), 7);
  assert.equal(b.readUInt32BE(25), 5);
  assert.equal(b.readUInt32BE(29), 24);
  assert.equal(b.readUInt32BE(33), 0);
  assert.equal(b.readUInt32BE(37), png.length);
  assert.ok(b.subarray(41).equals(png));
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 9, 0, 12, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  const j = pictureBlock(jpg);
  assert.equal(j.subarray(8, 18).toString(), 'image/jpeg');
  assert.equal(j.readUInt32BE(22), 12); // width
  assert.equal(j.readUInt32BE(26), 9); // height
  assert.equal(pictureBlock(Buffer.from('not an image')), null);
  const meta = pictureMetadata(png);
  const m = /^;FFMETADATA1\nMETADATA_BLOCK_PICTURE=(.*)\n$/.exec(meta);
  assert.ok(m);
  assert.ok(!/(^|[^\\])=/.test(m[1]));
  assert.ok(Buffer.from(m[1].replace(/\\=/g, '='), 'base64').equals(b));
});

function artFlac(dir) {
  const flac = path.join(dir, 'a.flac');
  const jpg = path.join(dir, 'c.jpg');
  let r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', jpg], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-i', jpg, '-map', '0', '-map', '1', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata', 'title=T', '-metadata', 'artist=A', flac], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return flac;
}
function streams(file) {
  const r = spawnSync(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
}
async function toOpus(extra) {
  const dir = fresh271();
  const flac = artFlac(dir);
  const out = fresh271();
  const res = await convertOne({ file: flac, outDir: out, tools, settings: { ...settings.defaults(tmp271), Format: 'opus', QualityCheck: 'off', HealthCheck: false, ...extra }, allocator: { allocate: (s) => ({ name: s, duplicate: false }) }, signal: new AbortController().signal });
  assert.equal(res.status, 'OK', res.note);
  const file = path.join(out, res.name);
  assert.deepEqual(fs.readdirSync(out), [res.name], 'no temp files left behind');
  return file;
}

test('Opus keeps cover art, and the tags stay', { skip }, async () => {
  const f = await toOpus({});
  const p = streams(f);
  assert.ok(p.streams.some((s) => s.codec_type === 'video'), 'video stream present');
  assert.equal(titleOf(p), 'T');
  const png = path.join(fresh271(), 'x.png');
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-i', f, '-an', '-map', '0:v:0', '-frames:v', '1', png], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(png).size > 0);
});

test('Opus: Keep cover art off, or tags removed, gives no art', { skip }, async () => {
  for (const extra of [{ CoverArt: false }, { TagMode: 'strip' }]) {
    const p = streams(await toOpus(extra));
    assert.ok(!p.streams.some((s) => s.codec_type === 'video'), JSON.stringify(extra));
  }
});

test('Opus with TagMode clean keeps the art and the main tags', { skip }, async () => {
  const p = streams(await toOpus({ TagMode: 'clean' }));
  assert.ok(p.streams.some((s) => s.codec_type === 'video'));
  assert.equal(titleOf(p), 'T');
});

function titleOf(p) { const t = Object.assign({}, p.format.tags, ...p.streams.map((s) => s.tags)); return t.title || t.TITLE; }

test('imageSize: skips JPEG markers without a length field before the frame header', () => {
  const { imageSize } = require('../src/engine/art');
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), [600, 300]);
});
