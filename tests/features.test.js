'use strict';
// Output formats, sub-folders, dropped files, update check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools, hasEncoder } = require('../src/engine/tools');
const { runBatch, EXTENSIONS } = require('../src/engine/batch');
const { classifyDrop } = require('../src/engine/guards');
const { compareVersions, describe } = require('../src/engine/update');
const settings = require('../src/engine/settings');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-feat-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function ff(args) {
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const sig = () => new AbortController().signal;
const base = settings.defaults(tmp);

let treeN = 0;
function makeTree() {
  const inDir = path.join(tmp, `tree${++treeN}`);
  fs.mkdirSync(path.join(inDir, 'A'), { recursive: true });
  fs.mkdirSync(path.join(inDir, 'B'), { recursive: true });
  const meta = ['-metadata', 'artist=Same', '-metadata', 'title=Song'];
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', ...meta, path.join(inDir, 'top.flac')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', ...meta, path.join(inDir, 'A', 'x.flac')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', ...meta, path.join(inDir, 'B', 'y.flac')]);
  return inDir;
}

test('settings: new keys are validated', () => {
  const s = settings.merge(settings.defaults(tmp), { Format: 'ogg', Recurse: 'yes', WinW: 5, WinH: 900 });
  assert.equal(s.Format, 'mp3');
  assert.equal(s.Recurse, false);
  assert.equal(s.WinW, 820);
  assert.equal(s.WinH, 900);
  assert.equal(settings.merge(s, { Format: 'flac', Recurse: true }).Format, 'flac');
});

test('batch: sub-folders are mirrored and not counted as duplicates of each other', { skip }, async () => {
  const inDir = makeTree();
  const off = [];
  await runBatch({ inDir, outDir: path.join(tmp, 'o-flat'), settings: { ...base, Format: 'mp3', QualityCheck: 'off' }, tools, signal: sig(), onEvent: (e) => off.push(e) });
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'o-flat')), ['Same - Song.mp3'], 'only the top folder without Recurse');

  const out = path.join(tmp, 'o-rec');
  const r = await runBatch({ inDir, outDir: out, settings: { ...base, Format: 'mp3', QualityCheck: 'off', Recurse: true }, tools, signal: sig(), onEvent: () => {} });
  assert.equal(r.counts.OK, 3);
  assert.ok(fs.existsSync(path.join(out, 'Same - Song.mp3')));
  assert.ok(fs.existsSync(path.join(out, 'A', 'Same - Song.mp3')));
  assert.ok(fs.existsSync(path.join(out, 'B', 'Same - Song.mp3')));
});

test('batch: output folder inside the songs folder is not scanned again', { skip }, async () => {
  const inDir = makeTree();
  const out = path.join(inDir, 'out');
  const opts = { ...base, Format: 'flac', QualityCheck: 'off', Recurse: true };
  await runBatch({ inDir, outDir: out, settings: opts, tools, signal: sig(), onEvent: () => {} });
  const again = await runBatch({ inDir, outDir: out, settings: opts, tools, signal: sig(), onEvent: () => {} });
  assert.equal(again.counts.SKIP, 3);
  assert.equal(again.counts.OK, 0);
});

for (const [format, ext, codec] of [['m4a', '.m4a', 'aac'], ['flac', '.flac', 'flac'], ['opus', '.opus', 'opus']]) {
  test(`batch: ${format} output has the right codec and tags`, { skip }, async () => {
    if (!(await hasEncoder(tools.ffmpeg, { m4a: 'aac', flac: 'flac', opus: 'libopus' }[format]))) return;
    const inDir = path.join(tmp, `in-${format}`);
    fs.mkdirSync(inDir);
    ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-metadata', 'artist=A;B', '-metadata', 'title=T', path.join(inDir, 's.flac')]);
    const out = path.join(tmp, `out-${format}`);
    const r = await runBatch({ inDir, outDir: out, settings: { ...base, Format: format, QualityCheck: 'off' }, tools, signal: sig(), onEvent: () => {} });
    assert.equal(r.counts.OK, 1, JSON.stringify(r.counts));
    const file = path.join(out, `A, B - T${ext}`);
    assert.ok(fs.existsSync(file));
    const probe = spawnSync(tools.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name:format_tags=artist,title:stream_tags=artist,title', '-of', 'default=nw=1', file], { encoding: 'utf8' }).stdout;
    assert.match(probe, new RegExp(`codec_name=${codec}`));
    assert.match(probe, /title=T/i);
  });
}

test('batch: dropped files are converted instead of scanning the folder', { skip }, async () => {
  const inDir = path.join(tmp, 'in-drop');
  fs.mkdirSync(inDir);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-metadata', 'artist=D', '-metadata', 'title=One', path.join(inDir, 'one.flac')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-metadata', 'artist=D', '-metadata', 'title=Two', path.join(inDir, 'two.flac')]);
  const out = path.join(tmp, 'out-drop');
  const r = await runBatch({
    inDir: path.join(tmp, 'does-not-matter'), outDir: out, inputs: [path.join(inDir, 'two.flac')],
    settings: { ...base, QualityCheck: 'off' }, tools, signal: sig(), onEvent: () => {}
  });
  assert.equal(r.counts.OK, 1);
  assert.deepEqual(fs.readdirSync(out), ['D - Two.mp3']);
});

test('drop: a folder wins, music files are kept, everything else is ignored', () => {
  const d = path.join(tmp, 'drop');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'a.flac'), 'x');
  fs.writeFileSync(path.join(d, 'b.txt'), 'x');
  fs.writeFileSync(path.join(d, 'c.exe'), 'x');
  assert.deepEqual(classifyDrop([d], EXTENSIONS), { kind: 'folder', dir: path.resolve(d) });
  assert.deepEqual(classifyDrop([path.join(d, 'a.flac'), path.join(d, 'b.txt'), path.join(d, 'c.exe')], EXTENSIONS),
    { kind: 'files', files: [path.resolve(d, 'a.flac')] });
  assert.equal(classifyDrop([path.join(d, 'b.txt')], EXTENSIONS).kind, 'none');
  assert.equal(classifyDrop('nope', EXTENSIONS).kind, 'none');
  assert.equal(classifyDrop([null, 5, ''], EXTENSIONS).kind, 'none');
});

test('update: version comparison and release parsing', () => {
  assert.ok(compareVersions('v2.1.0', '2.0.0') > 0);
  assert.ok(compareVersions('2.0.0', '2.0.0') === 0);
  assert.ok(compareVersions('1.9.9', '2.0.0') < 0);
  assert.equal(compareVersions('junk', '2.0.0'), 0);
  const r = describe({ tag_name: 'v2.1.0', html_url: 'https://github.com/bobojuice/tunes-converter/releases/tag/v2.1.0' }, '2.0.0');
  assert.deepEqual(r, { ok: true, latest: '2.1.0', newer: true, url: 'https://github.com/bobojuice/tunes-converter/releases/tag/v2.1.0' });
  assert.equal(describe({ tag_name: 'v2.0.0', html_url: 'https://evil.example/x' }, '2.0.0').url, 'https://github.com/bobojuice/tunes-converter/releases');
  assert.equal(describe({}, '2.0.0').ok, false);
});

test('update: oversized, interrupted and silent servers settle instead of hanging', async () => {
  const { fetchLatest } = require('../src/engine/update');
  const http = require('http');
  const serve = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/x` }));
  });
  const cases = [
    ['oversized', (req, res) => { res.writeHead(200); res.write('x'.repeat(2_000_000)); /* never ends */ }],
    ['interrupted', (req, res) => { res.writeHead(200, { 'Content-Length': 100 }); res.write('{'); res.destroy(); }],
    ['silent', () => { /* never answers */ }]
  ];
  for (const [name, handler] of cases) {
    const { server, url } = await serve(handler);
    const r = await fetchLatest('2.0.0', { url, timeoutMs: 800 });
    server.closeAllConnections();
    server.close();
    assert.equal(r.ok, false, name);
  }
  const { server, url } = await serve((req, res) => { res.writeHead(200); res.end(JSON.stringify({ tag_name: 'v9.0.0' })); });
  assert.equal((await fetchLatest('2.0.0', { url })).newer, true);
  server.close();
});

test('batch: an empty dropped selection never falls back to scanning the folder', { skip }, async () => {
  const inDir = makeTree();
  const out = path.join(tmp, 'o-empty');
  const msgs = [];
  const r = await runBatch({ inDir, outDir: out, inputs: [], settings: { ...base, QualityCheck: 'off' }, tools, signal: sig(), onEvent: (e) => msgs.push(e) });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(out) ? fs.readdirSync(out).length : 0, 0);
});

test('batch: an output path that is an alias of a folder inside the songs folder is not rescanned', { skip }, async () => {
  const inDir = makeTree();
  const real = path.join(inDir, 'results');
  fs.mkdirSync(real);
  const alias = path.join(tmp, 'alias-to-results');
  try { fs.symlinkSync(real, alias, 'junction'); } catch { return; } // junctions need no rights on Windows; skip where unsupported
  const opts = { ...base, Format: 'mp3', QualityCheck: 'off', Recurse: true };
  await runBatch({ inDir, outDir: alias, settings: opts, tools, signal: sig(), onEvent: () => {} });
  const again = await runBatch({ inDir, outDir: alias, settings: opts, tools, signal: sig(), onEvent: () => {} });
  assert.equal(again.counts.OK, 0);
  assert.equal(again.counts.SKIP, 3);
  assert.equal(fs.existsSync(path.join(real, 'results')), false, 'no nested copy of the output');
});

test('batch: a mirrored folder named like a converted file does not make that file "already exist"', { skip }, async () => {
  const inDir = path.join(tmp, 'in-clash');
  fs.mkdirSync(path.join(inDir, 'album.mp3'), { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', path.join(inDir, 'album.flac')]); // untagged: output is album.mp3
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', path.join(inDir, 'album.mp3', 'track.flac')]);
  const out = path.join(tmp, 'o-clash');
  const r = await runBatch({ inDir, outDir: out, settings: { ...base, Format: 'mp3', QualityCheck: 'off', Recurse: true }, tools, signal: sig(), onEvent: () => {} });
  assert.equal(r.counts.OK, 2, JSON.stringify(r.counts));
  assert.ok(fs.statSync(path.join(out, 'album.mp3')).isDirectory());
  assert.ok(fs.existsSync(path.join(out, 'album (2).mp3')));
  assert.ok(fs.existsSync(path.join(out, 'album.mp3', 'track.mp3')));
});
