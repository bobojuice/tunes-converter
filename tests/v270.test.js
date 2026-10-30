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
  assert.deepEqual(pb.serveDecision(`tcplay://track/${tok}`, resolve), { ok: true, file: 'C:\\tmp\\x.wav', kind: 'audio' });
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

test('serveDecision: art URL serves an image, strict host and token', () => {
  const tok = 'a1b2c3d4e5f60718293a4b5c';
  const track = (t) => (t === tok ? 'C:\\tmp\\x.wav' : null);
  const art = (t) => (t === tok ? 'C:\\tmp\\art.jpg' : null);
  assert.deepEqual(pb.serveDecision(`tcplay://art/${tok}`, track, art), { ok: true, file: 'C:\\tmp\\art.jpg', kind: 'image' });
  assert.equal(pb.serveDecision(`tcplay://cover/${tok}`, track, art).status, 403);
  assert.equal(pb.serveDecision(`tcplay://art/${tok}?x=1`, track, art).status, 403);
  assert.equal(pb.serveDecision('tcplay://art/ffffffffffffffffffffffff', track, art).status, 404);
  assert.equal(pb.serveDecision(`tcplay://art/${tok}`, track).status, 404);
  assert.equal(pb.serveDecision(`tcplay://track/${tok}`, track, art).kind, 'audio');
});

function wavBuf(frames, rate, withList) {
  const data = Buffer.alloc(frames * 4); // stereo 16-bit
  for (let i = 0; i < frames; i++) { data.writeInt16LE(i < frames / 2 ? 16384 : 0, i * 4); data.writeInt16LE(i < frames / 2 ? -8000 : 0, i * 4 + 2); }
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * 4, 16); fmt.writeUInt16LE(4, 20); fmt.writeUInt16LE(16, 22);
  const parts = [fmt];
  if (withList) { const l = Buffer.alloc(8 + 5 + 1); l.write('LIST', 0, 'latin1'); l.writeUInt32LE(5, 4); l.write('abcde', 8, 'latin1'); parts.push(l); } // odd length + pad
  const dh = Buffer.alloc(8); dh.write('data', 0, 'latin1'); dh.writeUInt32LE(data.length, 4);
  parts.push(dh, data);
  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(12); riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(body.length + 4, 4); riff.write('WAVE', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

test('waveformPeaks: header walker handles a LIST chunk; bad files give empty', async () => {
  const d = fresh('wf');
  for (const withList of [false, true]) {
    const f = path.join(d, `h${withList}.wav`);
    fs.writeFileSync(f, wavBuf(8000, 8000, withList)); // 1 s
    const r = await pb.waveformPeaks(f);
    assert.ok(Math.abs(r.duration - 1) < 0.001);
    assert.ok(Math.abs(r.peaks.length - 100) <= 2);
    assert.equal(r.peaks[10], Math.round(16384 / 32768 * 255));
    assert.equal(r.peaks[90], 0);
  }
  const bad = path.join(d, 'bad.wav');
  fs.writeFileSync(bad, 'not a wav file at all');
  const rb = await pb.waveformPeaks(bad);
  assert.equal(rb.peaks.length, 0);
  assert.equal(rb.duration, 0);
  const rm = await pb.waveformPeaks(path.join(d, 'missing.wav'));
  assert.equal(rm.peaks.length, 0);
});

test('waveformPeaks: real decoded sine with a quiet second half', { skip }, async () => {
  const d = fresh('wf2');
  const f = path.join(d, 's.wav');
  const r0 = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', "volume=0.05:enable='gte(t,1)'", '-ac', '2', '-c:a', 'pcm_s16le', f], { encoding: 'utf8' });
  assert.equal(r0.status, 0, r0.stderr);
  const r = await pb.waveformPeaks(f);
  assert.ok(Math.abs(r.duration - 2) < 0.05, String(r.duration));
  assert.ok(Math.abs(r.peaks.length - r.duration * 100) <= 2);
  const max = (a, b) => Math.max(...r.peaks.subarray(a, b));
  assert.ok(max(10, 90) > 3 * max(110, 190), `${max(10, 90)} vs ${max(110, 190)}`);
});

function sineWav(file, freq, secs, ampFn) {
  const rate = 22050;
  const n = Math.floor(rate * secs);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 32000 * ampFn(i / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

test('waveformPeaks: rms and low bands match the peaks length and order loud/quiet and bass/treble', async () => {
  const d = fresh('wfrms');
  const loud = path.join(d, 'a.wav');
  sineWav(loud, 440, 2, (t) => (t < 1 ? 1 : 0.05));
  const r = await pb.waveformPeaks(loud);
  assert.ok(r.rms instanceof Uint8Array && r.low instanceof Uint8Array);
  assert.equal(r.rms.length, r.peaks.length);
  assert.equal(r.low.length, r.peaks.length);
  const avg = (a, x, y) => { let s = 0; for (let i = x; i < y; i++) s += a[i]; return s / (y - x); };
  assert.ok(avg(r.rms, 10, 90) > 3 * avg(r.rms, 110, 190), 'loud half has a larger rms');
  const bass = path.join(d, 'b.wav');
  const treble = path.join(d, 't.wav');
  sineWav(bass, 80, 1, () => 1);
  sineWav(treble, 6000, 1, () => 1);
  const rb = await pb.waveformPeaks(bass);
  const rt = await pb.waveformPeaks(treble);
  assert.ok(avg(rb.low, 10, 90) > 4 * avg(rt.low, 10, 90), `${avg(rb.low, 10, 90)} vs ${avg(rt.low, 10, 90)}`);
  const rbad = await pb.waveformPeaks(path.join(d, 'missing.wav'));
  assert.equal(rbad.rms.length, 0);
  assert.equal(rbad.low.length, 0);
});

test('waveformPeaks: opposite-phase stereo still has rms and bass energy', async () => {
  const d = fresh('wfphase');
  const mk = (file, sign) => {
    const rate = 22050; const n = rate;
    const data = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const s = Math.round(Math.sin(2 * Math.PI * 80 * i / rate) * 20000);
      data.writeInt16LE(s, i * 4); data.writeInt16LE(sign * s, i * 4 + 2);
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28);
    h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([h, data]));
  };
  mk(path.join(d, 'in.wav'), 1);
  mk(path.join(d, 'out.wav'), -1);
  const a = await pb.waveformPeaks(path.join(d, 'in.wav'));
  const b = await pb.waveformPeaks(path.join(d, 'out.wav'));
  const avg = (x) => { let s = 0; for (let i = 10; i < 90; i++) s += x[i]; return s / 80; };
  assert.ok(avg(b.rms) > 20 && avg(b.low) > 20, `${avg(b.rms)} ${avg(b.low)}`);
  assert.ok(avg(b.rms) > avg(a.rms) / 1.5 && avg(b.low) > avg(a.low) / 1.5);
});

function makeArtMp3(dir, withArt) {
  const mp3 = path.join(dir, withArt ? 'art.mp3' : 'plain.mp3');
  if (!withArt) {
    const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', mp3], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return mp3;
  }
  const jpg = path.join(dir, 'c.jpg');
  let r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', jpg], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-i', jpg, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic', mp3], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return mp3;
}

test('createPlayer: cover art extracted into the temp folder and removed on stop; none without art', { skip }, async () => {
  const d = fresh('art');
  const p = pb.createPlayer({ tempBase: fresh('tempbase') });
  const r = await p.prepare(tools.ffmpeg, makeArtMp3(d, true));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.hasArt, true);
  assert.ok(r.peaks.length > 80 && r.duration > 0.5 && r.perSec === 100);
  const art = p.resolveArt(r.token);
  assert.ok(art && pb.insideRoot(p.tempRoot, art) && fs.statSync(art).size > 0);
  assert.equal(p.resolveArt('ffffffffffffffffffffffff'), null);
  p.stop();
  assert.equal(fs.existsSync(art), false);
  assert.equal(p.resolveArt(r.token), null);
  const r2 = await p.prepare(tools.ffmpeg, makeArtMp3(d, false));
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.hasArt, false);
  assert.equal(p.resolveArt(r2.token), null);
  assert.equal(fs.readdirSync(p.tempRoot).length, 1);
  p.dispose();
});

test('sweepStale: removes old play folders only', () => {
  const base = fresh('sweep');
  const old = path.join(base, 'tunes-converter-play-2147483000-old');
  const young = path.join(base, 'tunes-converter-play-2-new');
  const other = path.join(base, 'something-else');
  for (const d of [old, young, other]) fs.mkdirSync(d);
  const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  fs.utimesSync(other, past, past);
  const mine = path.join(base, `tunes-converter-play-${process.pid}-live`);
  fs.mkdirSync(mine);
  fs.utimesSync(mine, past, past); // a copy that is still running keeps its folder, however old
  pb.sweepStale(base);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(young), true);
  assert.equal(fs.existsSync(mine), true);
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
  assert.equal(d.PlatterSpin, false);
  assert.equal(settings.merge(d, { PlatterSpin: true }).PlatterSpin, true);
  assert.equal(settings.merge(d, { PlatterSpin: 'yes' }).PlatterSpin, false);
  assert.equal(settings.PRESET_KEYS.includes('PlatterSpin'), false);
});

test('rangeFor: whole file, ranges, suffix ranges, bad ranges', () => {
  assert.deepEqual(pb.rangeFor(1000, null), { status: 200, start: 0, end: 999 });
  assert.deepEqual(pb.rangeFor(1000, 'bytes=0-'), { status: 206, start: 0, end: 999 });
  assert.deepEqual(pb.rangeFor(1000, 'bytes=100-199'), { status: 206, start: 100, end: 199 });
  assert.deepEqual(pb.rangeFor(1000, 'bytes=900-5000'), { status: 206, start: 900, end: 999 });
  assert.deepEqual(pb.rangeFor(1000, 'bytes=-100'), { status: 206, start: 900, end: 999 });
  for (const bad of ['bytes=1000-', 'bytes=5-2', 'bytes=-', 'bytes=-0', 'items=0-1', 'bytes=0-1,5-6', 'bytes=a-b']) assert.equal(pb.rangeFor(1000, bad).status, 416, bad);
});

test('createPlayer: an older reserved request cannot cancel a newer one, and stop voids a reservation', { skip }, async () => {
  const d = fresh('ticket');
  const src = path.join(d, 'a.wav');
  tone(src);
  const p = pb.createPlayer({ tempBase: d });
  const older = p.reserve();
  const newer = p.reserve();
  const [a, b] = await Promise.all([p.prepare(tools.ffmpeg, src, older), p.prepare(tools.ffmpeg, src, newer)]);
  assert.equal(a.ok, false);
  assert.equal(a.cancelled, true);
  assert.equal(b.ok, true);
  const t = p.reserve();
  p.stop();
  assert.equal((await p.prepare(tools.ffmpeg, src, t)).cancelled, true);
  p.dispose();
});
test('batch: a skipped duplicate or an existing file names the converted copy to play', { skip }, async () => {
  const { runBatch } = require('../src/engine/batch');
  const inDir = fresh('dupin');
  for (const f of ['a.flac', 'b.flac']) {
    const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata', 'artist=A', '-metadata', 'title=Same', path.join(inDir, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const out = fresh('dupout');
  const opts = { ...settings.defaults(tmp), QualityCheck: 'off', HealthCheck: false, DuplicateMode: 'skip', FolderTemplate: '{artist}' };
  const events = [];
  await runBatch({ inDir, outDir: out, settings: opts, tools, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  const res = events.filter((e) => e.type === 'result');
  const skipped = res.find((e) => e.status === 'SKIP');
  assert.ok(skipped);
  assert.equal(skipped.play, path.join('A', 'A - Same.mp3'));
  assert.ok(fs.existsSync(path.join(out, skipped.play)));
  // a second run: the files already exist, each row names its existing output
  const again = [];
  await runBatch({ inDir, outDir: out, settings: { ...opts, DuplicateMode: 'off' }, tools, signal: new AbortController().signal, onEvent: (e) => again.push(e) });
  for (const e of again.filter((x) => x.type === 'result' && x.status === 'SKIP')) assert.ok(fs.existsSync(path.join(out, e.play)), e.play);
});

test('waveformPeaks: bins keep true timing at other sample rates and cover tracks over an hour', async () => {
  const d = fresh('wf2');
  const a = path.join(d, 'r22.wav');
  fs.writeFileSync(a, wavBuf(22050 * 20, 22050, false)); // 20 s at 22.05 kHz
  const r = await pb.waveformPeaks(a);
  assert.ok(Math.abs(r.peaks.length / r.perSec - r.duration) < 0.02, `${r.peaks.length} bins at ${r.perSec}/s vs ${r.duration}s`);
  assert.ok(Math.abs(r.perSec - 100) < 0.5);
  const b = path.join(d, 'long.wav'); // 1 h 2 min at 4 kHz: more than the bin cap at 100/s
  fs.writeFileSync(b, wavBuf(4000 * 3720, 4000, false));
  const l = await pb.waveformPeaks(b);
  assert.ok(l.peaks.length <= 360000);
  assert.ok(Math.abs(l.peaks.length / l.perSec - l.duration) < 0.5, 'bins cover the whole track');
  assert.ok(l.peaks[l.peaks.length - 1] === 0 && l.peaks[Math.floor(l.peaks.length * 0.1)] > 0, 'first half loud, end silent');
});
