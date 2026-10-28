'use strict';
// Playback preview: safe path resolution, the tcplay decision, the temp-WAV player, and the setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const settings = require('../src/engine/settings');
const pb = require('../src/engine/playback');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v270-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (label) => { const d = path.join(tmp, `${label}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

function tone(file) {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('resolvePlayable: accepts a nested audio file, rejects everything unsafe', () => {
  const out = fresh('out');
  fs.mkdirSync(path.join(out, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(out, 'sub', 'deep', 'a.mp3'), 'x');
  fs.writeFileSync(path.join(out, 'note.txt'), 'x');
  fs.mkdirSync(path.join(out, 'dir.mp3'));
  fs.writeFileSync(path.join(tmp, 'outside.mp3'), 'x');
  const ok = pb.resolvePlayable(path.join('sub', 'deep', 'a.mp3'), out);
  assert.ok(ok && path.isAbsolute(ok));
  assert.ok(pb.resolvePlayable('sub/deep/a.mp3', out));
  assert.equal(pb.resolvePlayable('..\\outside.mp3', out), null);
  assert.equal(pb.resolvePlayable('../outside.mp3', out), null);
  assert.equal(pb.resolvePlayable('sub/../sub/deep/a.mp3', out), null);
  assert.equal(pb.resolvePlayable(path.join(tmp, 'outside.mp3'), out), null);
  assert.equal(pb.resolvePlayable('C:\\Windows\\x.mp3', out), null);
  assert.equal(pb.resolvePlayable('C:x.mp3', out), null);
  assert.equal(pb.resolvePlayable('/etc/a.mp3', out), null);
  assert.equal(pb.resolvePlayable('a\0.mp3', out), null);
  assert.equal(pb.resolvePlayable('note.txt', out), null);
  assert.equal(pb.resolvePlayable('missing.mp3', out), null);
  assert.equal(pb.resolvePlayable('dir.mp3', out), null);
  assert.equal(pb.resolvePlayable('', out), null);
  assert.equal(pb.resolvePlayable(42, out), null);
  assert.equal(pb.resolvePlayable(`${'a'.repeat(1030)}.mp3`, out), null);
});

test('insideRoot: junction/symlink escape, prefix sibling, case', (t) => {
  const root = fresh('root');
  const other = fresh('elsewhere');
  fs.writeFileSync(path.join(other, 'secret.mp3'), 'x');
  fs.writeFileSync(path.join(root, 'in.mp3'), 'x');
  assert.equal(pb.insideRoot(root, path.join(root, 'in.mp3')), true);
  assert.equal(pb.insideRoot(root, root), false);
  assert.equal(pb.insideRoot(root, path.join(root, 'nope.mp3')), false);
  // prefix sibling: out vs out2
  const out = fresh('out');
  const out2 = `${out}2`;
  fs.mkdirSync(out2);
  fs.writeFileSync(path.join(out2, 'a.mp3'), 'x');
  assert.equal(pb.insideRoot(out, path.join(out2, 'a.mp3')), false);
  // link pointing outside
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.diagnostic('could not create a link; escape check skipped');
    return;
  }
  assert.equal(pb.insideRoot(root, path.join(link, 'secret.mp3')), false);
  assert.equal(pb.resolvePlayable('link/secret.mp3', root), null);
  // case handling follows the file system
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(pb.insideRoot(root.toUpperCase(), path.join(root, 'in.mp3')), true);
  }
});

test('serveDecision: only a known 24-hex token on host "track"', () => {
  const tok = 'a1b2c3d4e5f60718293a4b5c';
  const resolve = (t) => (t === tok ? 'C:\\tmp\\x.wav' : null);
  assert.deepEqual(pb.serveDecision(`tcplay://track/${tok}`, resolve), { ok: true, file: 'C:\\tmp\\x.wav' });
  assert.equal(pb.serveDecision(`tcplay://other/${tok}`, resolve).status, 403);
  assert.equal(pb.serveDecision('tcplay://track/abc', resolve).status, 403);
  assert.equal(pb.serveDecision(`tcplay://track/${tok}00`, resolve).status, 403);
  assert.equal(pb.serveDecision(`tcplay://track/${tok.toUpperCase()}`, resolve).status, 403);
  assert.equal(pb.serveDecision(`tcplay://track/${tok}/extra`, resolve).status, 403);
  assert.equal(pb.serveDecision(`tcplay://track/${tok}?x=1`, resolve).status, 403);
  assert.equal(pb.serveDecision(`tcplay://track/${tok}#h`, resolve).status, 403);
  assert.equal(pb.serveDecision(`tcplay://user:pw@track/${tok}`, resolve).status, 403);
  assert.equal(pb.serveDecision(`tcplay://track@evil/${tok}`, resolve).status, 403);
  assert.equal(pb.serveDecision(`http://track/${tok}`, resolve).status, 403);
  assert.equal(pb.serveDecision(null, resolve).status, 403);
  assert.equal(pb.serveDecision('tcplay://track/ffffffffffffffffffffffff', resolve).status, 404);
});

test('createPlayer: prepare, replace, stop, dispose', { skip }, async () => {
  const base = fresh('tempbase');
  const src = path.join(fresh('src'), 'a.flac');
  tone(src);
  const p = pb.createPlayer({ tempBase: base });
  const r1 = await p.prepare(tools.ffmpeg, src);
  assert.equal(r1.ok, true, r1.error);
  const f1 = p.resolveToken(r1.token);
  assert.ok(f1 && pb.insideRoot(p.tempRoot, f1));
  const head = fs.readFileSync(f1).subarray(0, 4).toString('latin1');
  assert.equal(head, 'RIFF');
  const r2 = await p.prepare(tools.ffmpeg, src);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(fs.existsSync(f1), false);
  assert.equal(p.resolveToken(r1.token), null);
  const f2 = p.resolveToken(r2.token);
  assert.ok(f2 && fs.existsSync(f2));
  p.stop();
  assert.equal(fs.existsSync(f2), false);
  assert.equal(p.resolveToken(r2.token), null);
  const root = p.tempRoot;
  assert.ok(fs.existsSync(root));
  p.dispose();
  assert.equal(fs.existsSync(root), false);
});

test('createPlayer: a newer prepare cancels the older one', { skip }, async () => {
  const base = fresh('tempbase');
  const src = path.join(fresh('src'), 'a.flac');
  tone(src);
  const p = pb.createPlayer({ tempBase: base });
  const a = p.prepare(tools.ffmpeg, src);
  const b = p.prepare(tools.ffmpeg, src);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, false);
  assert.equal(ra.cancelled, true);
  assert.equal(rb.ok, true, rb.error);
  assert.equal(p.resolveToken(ra.token), null);
  assert.equal(fs.readdirSync(p.tempRoot).length, 1);
  p.dispose();
});

test('createPlayer: a garbage file fails and leaves no file', { skip }, async () => {
  const base = fresh('tempbase');
  const bad = path.join(fresh('src'), 'bad.mp3');
  fs.writeFileSync(bad, 'this is not audio');
  const p = pb.createPlayer({ tempBase: base });
  const r = await p.prepare(tools.ffmpeg, bad);
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(fs.readdirSync(p.tempRoot).length, 0);
  p.dispose();
});

test('sweepStale: removes old play folders only', () => {
  const base = fresh('sweep');
  const old = path.join(base, 'tunes-converter-play-1-old');
  const young = path.join(base, 'tunes-converter-play-2-new');
  const other = path.join(base, 'something-else');
  for (const d of [old, young, other]) fs.mkdirSync(d);
  const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  fs.utimesSync(other, past, past);
  pb.sweepStale(base);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(young), true);
  assert.equal(fs.existsSync(other), true);
  assert.doesNotThrow(() => pb.sweepStale(path.join(base, 'does-not-exist')));
});

test('settings: PlayPreview defaults on, boolean only, not a preset key', () => {
  const d = settings.defaults(tmp);
  assert.equal(d.PlayPreview, true);
  assert.equal(settings.merge(d, { PlayPreview: false }).PlayPreview, false);
  assert.equal(settings.merge(d, { PlayPreview: 'no' }).PlayPreview, true);
  assert.equal(settings.merge(d, { PlayPreview: 0 }).PlayPreview, true);
  assert.equal(settings.PRESET_KEYS.includes('PlayPreview'), false);
});

test('rangeFor: whole file, ranges, suffix ranges, bad ranges', () => {
  assert.deepEqual(pb.rangeFor(1000, null), { status: 200, start: 0, end: 999 });
  assert.deepEqual(pb.rangeFor(1000, 'bytes=0-'), { status: 206, start: 0, end: 999 });
  assert.deepEqual(pb.rangeFor(1000, 'bytes=100-199'), { status: 206, start: 100, end: 199 });
  assert.deepEqual(pb.rangeFor(1000, 'bytes=900-5000'), { status: 206, start: 900, end: 999 });
  assert.deepEqual(pb.rangeFor(1000, 'bytes=-100'), { status: 206, start: 900, end: 999 });
  for (const bad of ['bytes=1000-', 'bytes=5-2', 'bytes=-', 'bytes=-0', 'items=0-1', 'bytes=0-1,5-6', 'bytes=a-b']) assert.equal(pb.rangeFor(1000, bad).status, 416, bad);
});
