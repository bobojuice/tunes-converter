'use strict';
// Integration tests: need ffmpeg and ffprobe (on PATH or in ./bin); skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools, hasMp3Encoder } = require('../src/engine/tools');
const { measureCutoff, estimateKbps } = require('../src/engine/quality');
const { runBatch } = require('../src/engine/batch');
const settings = require('../src/engine/settings');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function ff(args) {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

// Stereo pink noise has a broad spectrum like music, so a lossy encoder's lowpass shows up clearly.
function makeNoise(file, extra = []) {
  ff([
    '-f', 'lavfi', '-i', 'anoisesrc=d=40:c=pink:a=0.5:r=44100:seed=1',
    '-f', 'lavfi', '-i', 'anoisesrc=d=40:c=pink:a=0.5:r=44100:seed=2',
    '-filter_complex', '[0][1]amerge=inputs=2', ...extra, file
  ]);
}

const ctrl = () => new AbortController();

test('calibration: LAME encodes land in the right class', { skip }, async () => {
  const real = path.join(tmp, 'real.flac');
  makeNoise(real);
  const expectations = [[128, 128], [192, 192], [256, 256], [320, 320]];
  for (const [kbps, expected] of expectations) {
    const mp3 = path.join(tmp, `n${kbps}.mp3`);
    ff(['-i', real, '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, mp3]);
    const m = await measureCutoff({ ffmpeg: tools.ffmpeg, file: mp3, sampleRate: 44100, duration: 40, channels: 2, signal: ctrl().signal });
    assert.equal(m.status, 'ok');
    assert.equal(estimateKbps(m.cutoff), expected, `${kbps}k measured ${m.cutoff} Hz`);
  }
  const m = await measureCutoff({ ffmpeg: tools.ffmpeg, file: real, sampleRate: 44100, duration: 40, channels: 2, signal: ctrl().signal });
  assert.ok(m.cutoff > 21000, `lossless measured ${m.cutoff}`);
});

test('quality verdict does not depend on loudness for genuine files, and anti-phase stereo is analysed', { skip }, async () => {
  const real = path.join(tmp, 'real.flac');
  for (const g of [-6, -12, -18]) {
    const q = path.join(tmp, `q${-g}.flac`);
    ff(['-i', real, '-af', `volume=${g}dB`, q]);
    const m = await measureCutoff({ ffmpeg: tools.ffmpeg, file: q, sampleRate: 44100, duration: 40, channels: 2, signal: ctrl().signal });
    assert.equal(estimateKbps(m.cutoff), 320, `${g} dB measured ${m.cutoff}`);
  }
  const anti = path.join(tmp, 'anti.flac');
  ff(['-i', real, '-af', 'pan=stereo|c0=0.5*c0+0.5*c1|c1=-0.5*c0-0.5*c1', anti]);
  const m = await measureCutoff({ ffmpeg: tools.ffmpeg, file: anti, sampleRate: 44100, duration: 40, channels: 2, signal: ctrl().signal });
  assert.equal(estimateKbps(m.cutoff), 320);
});

test('a track below the silence gate is reported as too quiet, not judged', { skip }, async () => {
  const quiet = path.join(tmp, 'quiet.flac');
  ff(['-i', path.join(tmp, 'real.flac'), '-af', 'volume=-40dB', quiet]);
  const m = await measureCutoff({ ffmpeg: tools.ffmpeg, file: quiet, sampleRate: 44100, duration: 40, channels: 2, signal: ctrl().signal });
  assert.equal(m.status, 'short');
});

test('measureCutoff reports failures and cancellation instead of a verdict', { skip }, async () => {
  const junk = path.join(tmp, 'junk.flac');
  fs.writeFileSync(junk, 'not audio '.repeat(2000));
  const bad = await measureCutoff({ ffmpeg: tools.ffmpeg, file: junk, sampleRate: 44100, duration: 5, channels: 2, signal: ctrl().signal });
  assert.equal(bad.status, 'failed');
  const c = ctrl();
  c.abort();
  const cancelled = await measureCutoff({ ffmpeg: tools.ffmpeg, file: path.join(tmp, 'real.flac'), sampleRate: 44100, duration: 40, channels: 2, signal: c.signal });
  assert.equal(cancelled.status, 'cancelled');
});

test('batch: names, duplicates, quality modes, reruns', { skip }, async () => {
  assert.ok(await hasMp3Encoder(tools.ffmpeg), 'this ffmpeg needs libmp3lame');
  const inDir = path.join(tmp, 'in');
  fs.mkdirSync(inDir);
  const real = path.join(tmp, 'real.flac');
  const lame128 = path.join(tmp, 'n128.mp3');
  ff(['-i', real, '-metadata', 'artist=Real', '-metadata', 'title=Song', path.join(inDir, '1-real.flac')]);
  ff(['-i', real, '-metadata', 'artist=Real', '-metadata', 'title=Song', path.join(inDir, '2-same.flac')]);
  ff(['-i', lame128, '-metadata', 'artist=Fake', '-metadata', 'title=Claim', path.join(inDir, '3-fake.flac')]);
  fs.writeFileSync(path.join(inDir, '4-bad.flac'), 'junk');
  fs.writeFileSync(path.join(inDir, 'notes.txt'), 'ignored');

  const base = settings.defaults(tmp);
  const events = [];
  const run = (out, overrides) => runBatch({
    inDir, outDir: out, settings: { ...base, ...overrides }, tools, signal: ctrl().signal, onEvent: (e) => events.push(e)
  });

  const out1 = path.join(tmp, 'out1');
  const r1 = await run(out1, { QualityCheck: 'skip', MinKbps: 320 });
  assert.equal(r1.ok, true);
  assert.deepEqual(fs.readdirSync(out1).sort(), ['Real - Song (2).mp3', 'Real - Song.mp3']);
  assert.equal(r1.counts.FAKE, 1);
  assert.equal(r1.counts.FAIL, 1);
  assert.equal(r1.counts.OK, 2);

  const again = await run(out1, { QualityCheck: 'skip', MinKbps: 320 });
  assert.equal(again.counts.SKIP, 2, 'a rerun skips what already exists');
  assert.equal(fs.readdirSync(out1).filter((f) => f.endsWith('.part')).length, 0);

  const out2 = path.join(tmp, 'out2');
  const r2 = await run(out2, { QualityCheck: 'warn', MinKbps: 320 });
  assert.equal(r2.counts.WARN, 1);
  assert.ok(fs.existsSync(path.join(out2, 'Fake - Claim.mp3')));

  const out3 = path.join(tmp, 'out3');
  const r3 = await run(out3, { QualityCheck: 'off' });
  assert.equal(r3.counts.OK, 3);

  const tags = spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format_tags=artist,title', '-of', 'default=nw=1', path.join(out3, 'Real - Song.mp3')], { encoding: 'utf8' }).stdout;
  assert.match(tags, /artist=Real/i);
});

test('batch: guards for bad folders and stop', { skip }, async () => {
  const base = settings.defaults(tmp);
  const msgs = [];
  const onEvent = (e) => { if (e.type === 'message') msgs.push(e.text); };
  const sig = ctrl().signal;
  assert.equal((await runBatch({ inDir: path.join(tmp, 'nope'), outDir: path.join(tmp, 'o'), settings: base, tools, signal: sig, onEvent })).ok, false);
  assert.equal((await runBatch({ inDir: tmp, outDir: tmp, settings: base, tools, signal: sig, onEvent })).ok, false);
  assert.equal((await runBatch({ inDir: tmp, outDir: path.join(tmp, 'o'), settings: base, tools: null, signal: sig, onEvent })).ok, false);
  assert.ok(msgs.some((m) => /songs folder not found/.test(m)));
  assert.ok(msgs.some((m) => /must be different/.test(m)));
  assert.ok(msgs.some((m) => /ffmpeg not found/.test(m)));

  const inDir = path.join(tmp, 'stopin');
  fs.mkdirSync(inDir);
  ff(['-i', path.join(tmp, 'real.flac'), '-metadata', 'artist=S', '-metadata', 'title=One', path.join(inDir, 'a.flac')]);
  const c = ctrl();
  c.abort();
  const r = await runBatch({ inDir, outDir: path.join(tmp, 'stopout'), settings: { ...base, QualityCheck: 'off' }, tools, signal: c.signal, onEvent });
  assert.equal(r.stopped, true);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'stopout')), []);
});
