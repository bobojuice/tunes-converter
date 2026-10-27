'use strict';
// Copy mode, health check (flags only), cover art resize, keep dates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const { runBatch } = require('../src/engine/batch');
const settings = require('../src/engine/settings');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v250-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const base = { ...settings.defaults(tmp), QualityCheck: 'off' };
const sig = () => new AbortController().signal;
let n = 0;
const fresh = (label) => { const d = path.join(tmp, `${label}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

function ff(args) {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function probeAudio(file) {
  const out = spawnSync(tools.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bits_per_raw_sample,bits_per_sample,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8' }).stdout;
  return JSON.parse(out).streams[0];
}
function probeVideo(file) {
  const out = spawnSync(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' }).stdout;
  return (JSON.parse(out).streams || [])[0];
}
function tagsOf(file) {
  const out = spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', file], { encoding: 'utf8' }).stdout;
  const j = JSON.parse(out);
  const all = { ...(j.format && j.format.tags), ...((j.streams && j.streams[0] && j.streams[0].tags) || {}) };
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]));
}
// md5 of the decoded audio (lossless comparisons) or of the copied packets (lossy comparisons)
function audioHash(file, decoded) {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', ...(decoded ? ['-c:a', 'pcm_s32le'] : ['-c', 'copy']), '-f', 'md5', '-'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function extractArt(file) {
  const out = path.join(tmp, `art-${++n}.bin`);
  ff(['-i', file, '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-update', '1', '-f', 'image2', out]);
  return fs.readFileSync(out);
}

async function convert(inDir, over) {
  const out = fresh('out');
  const events = [];
  const r = await runBatch({ inDir, outDir: out, settings: { ...base, ...over }, tools, signal: sig(), onEvent: (e) => events.push(e) });
  return { out, r, results: events.filter((e) => e.type === 'result') };
}
const META = ['-metadata', 'artist=A', '-metadata', 'title=T'];

// [format, source file, ffmpeg args that create it, settings, expected codec]
const COPY_CASES = [
  ['mp3', 'orig.mp3', ['-c:a', 'libmp3lame', '-b:a', '128k'], {}, 'mp3'],
  ['m4a', 'orig.m4a', ['-c:a', 'aac', '-b:a', '128k'], {}, 'aac'],
  ['opus', 'orig.opus', ['-c:a', 'libopus', '-b:a', '96k'], {}, 'opus'],
  ['flac', 'orig16.flac', ['-c:a', 'flac', '-sample_fmt', 's16'], { BitDepth: 16 }, 'flac'],
  ['flac', 'orig24.flac', ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'], { BitDepth: 24 }, 'flac'],
  ['wav', 'orig16.wav', ['-c:a', 'pcm_s16le'], { BitDepth: 16 }, 'pcm_s16le'],
  ['wav', 'orig24.wav', ['-c:a', 'pcm_s24le'], { BitDepth: 24 }, 'pcm_s24le'],
  ['aiff', 'orig16.aiff', ['-c:a', 'pcm_s16be', '-write_id3v2', '1'], { BitDepth: 16 }, 'pcm_s16be'],
  ['aiff', 'orig24.aiff', ['-c:a', 'pcm_s24be', '-write_id3v2', '1'], { BitDepth: 24 }, 'pcm_s24be']
];
for (const [format, name, enc, over, codec] of COPY_CASES) {
  test(`copy mode: ${name} -> ${format} is copied, not re-encoded, and the name and tags are fixed`, { skip }, async () => {
    const inDir = fresh('in');
    const src = path.join(inDir, name);
    ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', '-ac', '2', ...enc, ...META, '-metadata', 'album=Alb', src]);
    const { out, r, results } = await convert(inDir, { Format: format, ...over });
    assert.equal(r.counts.OK, 1, JSON.stringify(results));
    assert.match(results[0].note, /copied \(no re-encode\)/);
    const file = path.join(out, `A - T.${format}`);
    assert.ok(fs.existsSync(file), fs.readdirSync(out).join());
    assert.equal(probeAudio(file).codec_name, codec);
    const lossless = ['flac', 'wav', 'aiff'].includes(format);
    assert.equal(audioHash(file, lossless), audioHash(src, lossless), 'the audio must be identical');
    const t = tagsOf(file);
    assert.equal(t.artist, 'A');
    assert.equal(t.title, 'T');
  });
}

test('copy mode: a 24-bit source with 16-bit chosen is re-encoded (flac and wav)', { skip }, async () => {
  for (const [format, enc, codec] of [['flac', ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'], 'flac'], ['wav', ['-c:a', 'pcm_s24le'], 'pcm_s16le']]) {
    const inDir = fresh('in');
    ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', ...enc, ...META, path.join(inDir, `o.${format}`)]);
    const { out, results } = await convert(inDir, { Format: format, BitDepth: 16 });
    assert.doesNotMatch(results[0].note, /copied/);
    const s = probeAudio(path.join(out, `A - T.${format}`));
    assert.equal(s.codec_name, codec);
    assert.equal(String(s.bits_per_raw_sample === 'N/A' || !s.bits_per_raw_sample ? s.bits_per_sample : s.bits_per_raw_sample), '16');
  }
});

test('copy mode off: an MP3 is re-encoded at the chosen bitrate', { skip }, async () => {
  const inDir = fresh('in');
  const src = path.join(inDir, 'o.mp3');
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'libmp3lame', '-b:a', '128k', ...META, src]);
  const { out, results } = await convert(inDir, { Format: 'mp3', Bitrate: 192, CopyMode: false });
  assert.doesNotMatch(results[0].note, /copied/);
  assert.match(results[0].note, /^192k/);
  assert.notEqual(audioHash(path.join(out, 'A - T.mp3')), audioHash(src));
});

test('copy mode: rename only and tag strip work on a copy', { skip }, async () => {
  const inDir = fresh('in');
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'libmp3lame', '-metadata', 'artist=A', '-metadata', 'title=T', '-metadata', 'album=Alb', path.join(inDir, 'o.mp3')]);
  const a = await convert(inDir, { Format: 'mp3', NameTemplate: '{title}' });
  assert.deepEqual(fs.readdirSync(a.out), ['T.mp3']);
  assert.match(a.results[0].note, /copied/);
  const b = await convert(inDir, { Format: 'mp3', TagMode: 'strip' });
  const t = tagsOf(path.join(b.out, 'A - T.mp3'));
  assert.equal(t.title, undefined);
  assert.equal(t.album, undefined);
});

// ---- health check ----

const stereoSrc = (file, extra = []) => ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-f', 'lavfi', '-i', 'sine=f=660:d=3', '-filter_complex', 'amerge=inputs=2', '-ar', '44100', ...META, ...extra, file]);

test('health: a normal stereo 44.1 kHz file has no flag', { skip }, async () => {
  const inDir = fresh('in');
  stereoSrc(path.join(inDir, 'ok.flac'));
  const { r, results } = await convert(inDir, { Format: 'mp3' });
  assert.equal(results[0].health, false);
  assert.doesNotMatch(results[0].note, /mono as stereo|low sample rate|corrupt/);
  assert.equal(r.counts.HEALTH, 0);
  assert.doesNotMatch(r.summary, /health/);
});

test('health: mono as stereo is flagged, and the audio is untouched', { skip }, async () => {
  const inDir = fresh('in');
  const src = path.join(inDir, 'm.flac');
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-ac', '2', '-ar', '44100', ...META, src]);
  assert.equal(probeAudio(src).channels, 2);
  const on = await convert(inDir, { Format: 'flac', CopyMode: false, HealthCheck: true });
  const off = await convert(inDir, { Format: 'flac', CopyMode: false, HealthCheck: false });
  assert.match(on.results[0].note, /mono as stereo/);
  assert.equal(on.results[0].health, true);
  assert.equal(on.r.counts.HEALTH, 1);
  assert.match(on.r.summary, /1 with health flags\./);
  assert.doesNotMatch(off.results[0].note, /mono as stereo/);
  assert.equal(probeAudio(path.join(on.out, 'A - T.flac')).channels, 2, 'still two channels');
  assert.equal(audioHash(path.join(on.out, 'A - T.flac'), true), audioHash(path.join(off.out, 'A - T.flac'), true));
});

test('health: a low sample rate is flagged', { skip }, async () => {
  const inDir = fresh('in');
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', '-ar', '22050', ...META, path.join(inDir, 'l.wav')]);
  const { out, results } = await convert(inDir, { Format: 'wav' });
  assert.match(results[0].note, /low sample rate 22050 Hz/);
  assert.equal(results[0].health, true);
  assert.equal(probeAudio(path.join(out, 'A - T.wav')).sample_rate, '22050', 'the rate is not changed');
});

test('health: a truncated file is flagged but still converted', { skip }, async () => {
  const inDir = fresh('in');
  const full = path.join(inDir, 'full.flac');
  stereoSrc(full);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=8', '-f', 'lavfi', '-i', 'sine=f=660:d=8', '-filter_complex', 'amerge=inputs=2', '-ar', '44100', ...META, full]);
  const bytes = fs.readFileSync(full);
  fs.writeFileSync(path.join(inDir, 'cut.flac'), bytes.subarray(0, Math.floor(bytes.length / 3)));
  fs.rmSync(full);
  const { out, r, results } = await convert(inDir, { Format: 'mp3' });
  assert.equal(r.counts.OK, 1, JSON.stringify(results));
  assert.match(results[0].note, /corrupt or truncated/);
  assert.equal(results[0].health, true);
  assert.ok(fs.readdirSync(out).some((f) => f.endsWith('.mp3')));
});

// ---- cover art ----

function withArt(dir, name, art, audioArgs = ['-c:a', 'libmp3lame']) {
  const audio = path.join(dir, `bare-${name}`);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', ...audioArgs, audio]);
  const out = path.join(dir, name);
  ff(['-i', audio, '-i', art, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', ...META, ...(name.endsWith('.mp3') ? ['-id3v2_version', '3'] : []), out]);
  fs.rmSync(audio);
  return out;
}
function makeArt(w, h, ext, noisy) {
  const f = path.join(tmp, `cover-${++n}.${ext}`);
  ff(['-f', 'lavfi', '-i', `color=c=red:s=${w}x${h}:d=1`, ...(noisy ? ['-vf', 'noise=alls=100:allf=t'] : []), '-frames:v', '1', f]);
  return f;
}

test('cover art: oversized art is resized to at most 800 px; no temp files are left', { skip }, async () => {
  for (const [format, srcName, audioArgs] of [['mp3', 'a.mp3', ['-c:a', 'libmp3lame']], ['flac', 'a.flac', ['-c:a', 'flac']], ['m4a', 'a.m4a', ['-c:a', 'aac']]]) {
    const inDir = fresh('in');
    const src = withArt(inDir, srcName, makeArt(1600, 1200, 'jpg'), audioArgs);
    assert.equal(probeVideo(src).width, 1600);
    const { out, results } = await convert(inDir, { Format: format });
    assert.match(results[0].note, /cover art resized/);
    const v = probeVideo(path.join(out, `A - T.${format}`));
    assert.ok(v.width <= 800 && v.height <= 800, `${v.width}x${v.height}`);
    assert.equal(v.codec_name, 'mjpeg');
    assert.deepEqual(fs.readdirSync(out), [`A - T.${format}`], 'no .part or art temp files');
  }
});

test('cover art: art over 1 MB is resized even when under 1000 px', { skip }, async () => {
  const inDir = fresh('in');
  const art = makeArt(900, 900, 'png', true);
  assert.ok(fs.statSync(art).size > 1000 * 1000, 'the test art must be over 1 MB');
  withArt(inDir, 'a.mp3', art);
  const { out, results } = await convert(inDir, { Format: 'mp3' });
  assert.match(results[0].note, /cover art resized/);
  assert.ok(probeVideo(path.join(out, 'A - T.mp3')).width <= 800);
});

test('cover art: normal art is copied byte for byte; ArtResize off leaves big art alone', { skip }, async () => {
  const inDir = fresh('in');
  const src = withArt(inDir, 'a.mp3', makeArt(400, 300, 'jpg'));
  const { out, results } = await convert(inDir, { Format: 'mp3' });
  assert.doesNotMatch(results[0].note, /resized/);
  assert.ok(extractArt(path.join(out, 'A - T.mp3')).equals(extractArt(src)));

  const bigDir = fresh('in');
  const big = withArt(bigDir, 'a.mp3', makeArt(1600, 1200, 'jpg'));
  const off = await convert(bigDir, { Format: 'mp3', ArtResize: false });
  assert.equal(probeVideo(path.join(off.out, 'A - T.mp3')).width, 1600);
  assert.ok(extractArt(path.join(off.out, 'A - T.mp3')).equals(extractArt(big)));
});

// ---- keep dates ----

test('keep dates: the output gets the source modified time (unless switched off)', { skip }, async () => {
  const inDir = fresh('in');
  const src = path.join(inDir, 'o.mp3');
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'libmp3lame', ...META, src]);
  const when = new Date('2019-03-04T05:06:07Z');
  fs.utimesSync(src, when, when);
  const on = await convert(inDir, { Format: 'mp3' });
  assert.equal(Math.floor(fs.statSync(path.join(on.out, 'A - T.mp3')).mtimeMs / 1000), Math.floor(when.getTime() / 1000));
  const off = await convert(inDir, { Format: 'mp3', KeepDates: false });
  assert.ok(fs.statSync(path.join(off.out, 'A - T.mp3')).mtimeMs > when.getTime() + 86400000 * 365);
});
