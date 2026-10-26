'use strict';
// v2.3: presets, duplicate detection, AIFF output, clipping check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const { runBatch } = require('../src/engine/batch');
const { songKey, SeenSongs } = require('../src/engine/duplicates');
const { run: runProc } = require('../src/engine/proc');
const { parseAstats, describeClipping } = require('../src/engine/clipping');
const settings = require('../src/engine/settings');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v230-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function ff(args) {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const sig = () => new AbortController().signal;
const base = { ...settings.defaults(tmp), QualityCheck: 'off' };
const run = (inDir, out, extra) => {
  const events = [];
  return runBatch({ inDir, outDir: out, settings: { ...base, ...extra }, tools, signal: sig(), onEvent: (e) => events.push(e) })
    .then((r) => ({ ...r, events, results: events.filter((e) => e.type === 'result') }));
};

// ---- presets ----
test('presets: only valid fields and entries are kept', () => {
  const s = settings.merge(settings.defaults(tmp), {
    Presets: [
      { name: '  DJ USB  ', options: { Format: 'aiff', BitDepth: 16, In: 'C:\\evil', FfmpegDir: 'C:\\evil', Bitrate: 999, WinW: 900 } },
      { name: 'dj usb', options: { Format: 'mp3' } }, // same name ignoring case
      { name: '', options: {} },
      { name: 'x'.repeat(41), options: {} },
      { name: 'No options' },
      'junk',
      null
    ]
  });
  assert.deepEqual(s.Presets, [{ name: 'DJ USB', options: { Format: 'aiff', BitDepth: 16 } }]);
});

test('presets: capped at the maximum and ignored unless a list', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, options: { Format: 'flac' } }));
  assert.equal(settings.merge(settings.defaults(tmp), { Presets: many }).Presets.length, settings.MAX_PRESETS);
  const kept = settings.merge({ ...settings.defaults(tmp), Presets: [{ name: 'a', options: {} }] }, { Presets: 'nope' });
  assert.equal(kept.Presets.length, 1);
});

test('presets: save to disk and load again, loading applies through merge', () => {
  const file = path.join(tmp, 'settings.json');
  const saved = settings.save(file, settings.defaults(tmp), { Presets: [{ name: 'Phone', options: { Format: 'm4a', Bitrate: 256 } }] });
  assert.equal(saved.Presets[0].name, 'Phone');
  const loaded = settings.load(file, settings.defaults(tmp));
  const applied = settings.merge(loaded, loaded.Presets[0].options);
  assert.equal(applied.Format, 'm4a');
  assert.equal(applied.Bitrate, 256);
  assert.equal(applied.Out, loaded.Out, 'a preset never changes the folders');
});

test('settings: new options are validated', () => {
  const s = settings.merge(settings.defaults(tmp), { ClipCheck: 'yes', DuplicateMode: 'maybe' });
  assert.equal(s.ClipCheck, false);
  assert.equal(s.DuplicateMode, 'warn');
  const t = settings.merge(s, { ClipCheck: true, DuplicateMode: 'skip' });
  assert.equal(t.ClipCheck, true);
  assert.equal(t.DuplicateMode, 'skip');
});

// ---- duplicates ----
test('duplicates: keys ignore case, accents and punctuation; need artist and title', () => {
  assert.equal(songKey('Beyoncé', 'Halo!'), songKey('BEYONCE', 'halo'));
  assert.notEqual(songKey('A', 'Song (Remix)'), songKey('A', 'Song'));
  assert.equal(songKey('', 'Song'), '');
  assert.equal(songKey('A', ''), '');
});

test('duplicates: similar length matches, very different length does not', () => {
  const seen = new SeenSongs();
  seen.add('k', 200, 'first.mp3');
  assert.equal(seen.find('k', 202), 'first.mp3');
  assert.equal(seen.find('k', 260), null);
  assert.equal(seen.find('k', 0), 'first.mp3', 'unknown length still matches');
  assert.equal(seen.find('other', 200), null);
});

function dupFolder(name) {
  const inDir = path.join(tmp, name);
  fs.mkdirSync(inDir);
  const meta = ['-metadata', 'artist=Band', '-metadata', 'title=Tune'];
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', ...meta, path.join(inDir, 'a.flac')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', ...meta, path.join(inDir, 'b.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=9', ...meta, path.join(inDir, 'c-long.flac')]);
  return inDir;
}

test('duplicates: warn converts everything and flags the extra copy', { skip }, async () => {
  const r = await run(dupFolder('in-dup-warn'), path.join(tmp, 'o-dup-warn'), { DuplicateMode: 'warn' });
  assert.equal(r.counts.OK, 3);
  assert.equal(r.counts.DUPLICATE, 1, 'the 9-second version is a different length, so not a duplicate');
  assert.match(r.results.find((x) => /duplicate of/.test(x.note)).note, /possible duplicate of Band - Tune\.mp3/);
  assert.match(r.summary, /1 possible duplicate/);
});

test('duplicates: skip leaves the extra copy out; off ignores it', { skip }, async () => {
  const inDir = dupFolder('in-dup-skip');
  const r = await run(inDir, path.join(tmp, 'o-dup-skip'), { DuplicateMode: 'skip' });
  assert.equal(r.counts.OK, 2);
  assert.equal(r.counts.SKIP, 1);
  assert.match(r.results.find((x) => x.status === 'SKIP').note, /same song as Band - Tune\.mp3/);
  const off = await run(inDir, path.join(tmp, 'o-dup-off'), { DuplicateMode: 'off' });
  assert.equal(off.counts.DUPLICATE, 0);
  assert.equal(off.results.filter((x) => /duplicate of/.test(x.note)).length, 0);
  assert.equal(off.results.filter((x) => /duplicate name/.test(x.note)).length, 2, 'file-name de-duplication is unchanged');
});

// ---- AIFF ----
test('aiff: big-endian PCM with tags and cover art', { skip }, async () => {
  const inDir = path.join(tmp, 'in-aiff');
  fs.mkdirSync(inDir);
  const art = path.join(tmp, 'aiff-art.png');
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', art]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-i', art, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata', 'artist=A;B', '-metadata', 'title=T', '-metadata', 'album=Alb', path.join(inDir, 's.flac')]);
  const probe = (f) => spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type:format_tags=artist,title,album', '-of', 'default=nw=1', f], { encoding: 'utf8' }).stdout;
  for (const [depth, codec] of [[16, 'pcm_s16be'], [24, 'pcm_s24be']]) {
    const out = path.join(tmp, `o-aiff${depth}`);
    const r = await run(inDir, out, { Format: 'aiff', BitDepth: depth });
    assert.equal(r.counts.OK, 1, JSON.stringify(r.results));
    const file = path.join(out, 'A, B - T.aiff');
    assert.ok(fs.existsSync(file));
    const info = probe(file);
    assert.match(info, new RegExp(`codec_name=${codec}`));
    assert.match(info, /title=T/i);
    assert.match(info, /album=Alb/i);
    assert.match(info, /artist=A, B/i);
    assert.match(info, /codec_type=video/, 'cover art kept');
  }
  const stripped = await run(inDir, path.join(tmp, 'o-aiff-strip'), { Format: 'aiff', TagMode: 'strip' });
  assert.equal(stripped.counts.OK, 1);
});

// ---- clipping ----
test('clipping: astats output is parsed and judged', () => {
  const text = (db, n) => `[Parsed_astats_0 @ 0] Channel: 1\n[Parsed_astats_0 @ 0] Peak level dB: -30.0\n[Parsed_astats_0 @ 0] Overall\n[Parsed_astats_0 @ 0] Peak level dB: ${db}\n[Parsed_astats_0 @ 0] Peak count: ${n}.000000\n[Parsed_astats_0 @ 0] Number of samples: 10\n`;
  assert.deepEqual(parseAstats(text('-0.020000', 120)), { peakDb: -0.02, peakCount: 120 });
  assert.match(describeClipping(parseAstats(text('0.000000', 120))), /possible clipping: 120 samples/);
  assert.match(describeClipping(parseAstats(text('2.500000', 1))), /over 0/);
  assert.equal(describeClipping(parseAstats(text('-6.000000', 500))), '');
  assert.equal(describeClipping(parseAstats(text('-0.020000', 2))), '', 'a couple of touches is not clipping');
  assert.equal(parseAstats('nothing here'), null);
});

test('proc: the end of a long stderr is kept (astats summary comes last)', async () => {
  const script = "for (let i = 0; i < 200; i++) process.stderr.write('noise ' + i + '\\\\n'); setTimeout(() => process.stderr.write('Overall\\\\nPeak level dB: 0.0\\\\nPeak count: 50\\\\n'), 50);";
  const r = await runProc(process.execPath, ['-e', script]);
  assert.deepEqual(parseAstats(r.stderr), { peakDb: 0, peakCount: 50 });
});

test('clipping: flags a squashed track and leaves a quiet one alone, only when switched on', { skip }, async () => {
  const inDir = path.join(tmp, 'in-clip');
  fs.mkdirSync(inDir);
  // hard-clipped: gain well past full scale, written as 16-bit so the samples saturate
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-af', 'volume=16', '-c:a', 'pcm_s16le', '-metadata', 'artist=L', '-metadata', 'title=Loud', path.join(inDir, 'loud.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=330:d=3', '-af', 'volume=0.3', '-metadata', 'artist=Q', '-metadata', 'title=Quiet', path.join(inDir, 'quiet.flac')]);
  const on = await run(inDir, path.join(tmp, 'o-clip-on'), { ClipCheck: true });
  assert.equal(on.counts.OK, 2);
  assert.equal(on.counts.CLIPPED, 1);
  assert.match(on.results.find((x) => /Loud/.test(x.name)).note, /possible clipping: \d+ samples/);
  assert.doesNotMatch(on.results.find((x) => /Quiet/.test(x.name)).note, /clipping|dBFS/);
  assert.match(on.summary, /1 with clipping/);
  const off = await run(inDir, path.join(tmp, 'o-clip-off'), { ClipCheck: false });
  assert.equal(off.counts.CLIPPED, 0);
});
