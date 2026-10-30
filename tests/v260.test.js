'use strict';
// Folder template (folders by tags) and the second output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTools } = require('../src/engine/tools');
const { runBatch } = require('../src/engine/batch');
const settings = require('../src/engine/settings');
const { validFolderTemplate, folderPath, validTemplate, applyTemplate } = require('../src/engine/naming');
const { buildReport } = require('../src/engine/report');

const tools = findTools({ appDir: path.join(__dirname, '..') });
const skip = tools ? false : 'ffmpeg/ffprobe not found';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v260-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const base = { ...settings.defaults(tmp), QualityCheck: 'off', HealthCheck: false };
const sig = () => new AbortController().signal;
let n = 0;
const fresh = (label) => { const d = path.join(tmp, `${label}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const S = path.sep;

// A one-second tone with the given tags, written as FLAC.
function song(dir, file, tags, hz = 440) {
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=1`, ...meta, path.join(dir, file)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function tree(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...tree(dir, p)); else out.push(p);
  }
  return out.sort();
}
function codecOf(file) {
  const r = spawnSync(tools.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.stdout.trim();
}
async function run(inDir, over, outDir = fresh('out')) {
  const events = [];
  const r = await runBatch({ inDir, outDir, settings: { ...base, ...over }, tools, signal: sig(), onEvent: (e) => events.push(e) });
  return { out: outDir, r, events, results: events.filter((e) => e.type === 'result') };
}

// ---- unit: templates and settings ----

test('genre is a name placeholder too', () => {
  assert.ok(validTemplate('{genre} - {title}'));
  assert.equal(applyTemplate('{genre}', { genre: 'House' }), 'House');
});

test('validFolderTemplate: known placeholders, 1 to 3 segments, no absolute or dot segments', () => {
  for (const ok of ['{artist}', '{artist}/{album}', '{albumartist}\\{album}', '{genre}/{artist}/{album}', '{genre}/{year}', 'Music/{artist}']) assert.ok(validFolderTemplate(ok), ok);
  for (const bad of ['', '   ', 'plain', '{nope}', '{artist}/{album}/{genre}/{year}', '/{artist}', '\\{artist}', 'C:/{artist}', '../{artist}', '{artist}/..', '{artist}/./{album}', '{artist', '{artist}}', `{artist}/${'x'.repeat(100)}`, 42, null]) assert.ok(!validFolderTemplate(bad), String(bad));
});

test('settings: FolderTemplate / SecondOut / SecondFormat are validated per key', () => {
  const d = settings.defaults(tmp);
  assert.equal(d.FolderTemplate, '');
  assert.equal(d.SecondOut, '');
  assert.equal(d.SecondFormat, 'off');
  assert.equal(settings.merge(d, { FolderTemplate: ' {artist}/{album} ' }).FolderTemplate, '{artist}/{album}');
  const on = settings.merge(d, { FolderTemplate: '{genre}' });
  assert.equal(settings.merge(on, { FolderTemplate: '../../x' }).FolderTemplate, '{genre}', 'invalid is ignored');
  assert.equal(settings.merge(on, { FolderTemplate: '{bogus}' }).FolderTemplate, '{genre}');
  assert.equal(settings.merge(on, { FolderTemplate: '' }).FolderTemplate, '', 'empty turns it off');
  assert.equal(settings.merge(d, { SecondFormat: 'flac' }).SecondFormat, 'flac');
  assert.equal(settings.merge(d, { SecondFormat: 'ogg' }).SecondFormat, 'off');
  assert.equal(settings.merge(d, { SecondFormat: 7 }).SecondFormat, 'off');
  assert.equal(settings.merge(d, { SecondOut: path.join(tmp, 'x') }).SecondOut, path.join(tmp, 'x'));
  assert.equal(settings.merge(d, { SecondOut: 5 }).SecondOut, '');
  assert.equal(settings.merge(d, { SecondOut: 'a\0b' }).SecondOut, '');
});

test('presets keep FolderTemplate but never SecondOut or SecondFormat', () => {
  assert.ok(settings.PRESET_KEYS.includes('FolderTemplate'));
  assert.ok(!settings.PRESET_KEYS.includes('SecondOut'));
  assert.ok(!settings.PRESET_KEYS.includes('SecondFormat'));
  const list = settings.cleanPresets([{ name: 'p', options: { FolderTemplate: '{artist}', SecondOut: 'C:\\x', SecondFormat: 'mp3' } }]);
  assert.deepEqual(list[0].options, { FolderTemplate: '{artist}' });
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const keys = /const PRESET_KEYS = \[([^\]]*)\]/.exec(rendererSrc)[1].match(/'(\w+)'/g).map((k) => k.slice(1, -1));
  assert.deepEqual(keys, settings.PRESET_KEYS, 'renderer and settings lists match');
});

test('folderPath: tags, fallbacks, album artist falls back to artist', () => {
  assert.equal(folderPath('{artist}/{album}', { artist: 'A', album: 'B' }), `A${S}B`);
  assert.equal(folderPath('{artist}/{album}', {}), `Unknown Artist${S}Unknown Album`);
  assert.equal(folderPath('{genre}', { genre: '  ' }), 'Unknown Genre');
  assert.equal(folderPath('{albumartist}/{album}', { artist: 'Solo', album: 'X' }), `Solo${S}X`);
  assert.equal(folderPath('{albumartist}', {}), 'Unknown Artist');
  assert.equal(folderPath('{year}', {}), 'Unknown');
  assert.equal(folderPath('{genre}\\{artist}', { genre: 'G', artist: 'A' }), `G${S}A`);
  assert.equal(folderPath('{year} - {album}', { year: '1999', album: 'B' }), '1999 - B');
});

test('folderPath: hostile values stay inside one safe folder name each', () => {
  const hostile = ['../../x', '..\\..\\x', '/etc/passwd', 'C:\\Windows', '..', '.', '...', ' . ', 'CON', 'nul.txt', 'a<b>c:d"e|f?g*h', 'trail. . ', '\u0001\u0002', 'x'.repeat(500)];
  for (const v of hostile) {
    const p = folderPath('{artist}/{album}', { artist: v, album: v });
    const segs = p.split(S);
    assert.equal(segs.length, 2, `${v} -> ${p}`);
    for (const seg of segs) {
      assert.ok(seg.length > 0 && seg.length <= 80, `${v}: length of "${seg}"`);
      assert.ok(seg !== '.' && seg !== '..', v);
      assert.ok(!/[\\/:*?"<>|\x00-\x1f]/.test(seg), `${v} -> ${seg}`);
      assert.ok(!/[. ]$/.test(seg) && !/^[. ]/.test(seg), `${v} -> "${seg}"`);
      assert.ok(!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(seg), `${v} -> ${seg}`);
    }
    assert.ok(!path.isAbsolute(p));
  }
  assert.equal(folderPath('{artist}', { artist: '../../x' }), '-..-x');
  assert.equal(folderPath('{artist}', { artist: 'CON' }), '_CON');
  assert.equal(folderPath('{artist}', { artist: '..' }), 'Unknown');
});

// ---- engine: folders by tags ----

test('folder template: files go into Artist/Album, names show the relative path', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'Daft Punk', title: 'One', album: 'Discovery', genre: 'House' });
  song(inDir, 'b.flac', { artist: 'Daft Punk', title: 'Two', album: 'Discovery', genre: 'House' }, 500);
  song(inDir, 'c.flac', { artist: 'Other', title: 'One', album: 'Else', genre: 'Rock' }, 600);
  const { out, r, results } = await run(inDir, { FolderTemplate: '{artist}/{album}' });
  assert.equal(r.counts.OK, 3);
  assert.deepEqual(tree(out), [
    path.join('Daft Punk', 'Discovery', 'Daft Punk - One.mp3'),
    path.join('Daft Punk', 'Discovery', 'Daft Punk - Two.mp3'),
    path.join('Other', 'Else', 'Other - One.mp3')
  ]);
  assert.deepEqual(results.map((x) => x.name).sort(), tree(out));
});

test('folder template: genre, album artist and year work; missing tags use the fallback folders', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'T1', genre: 'Techno', album_artist: 'Various', album: 'Comp', date: '2001-05-05' });
  song(inDir, 'b.flac', { title: 'T2' }, 500);
  const g = await run(inDir, { FolderTemplate: '{genre}' });
  assert.ok(tree(g.out).includes(path.join('Techno', 'A - T1.mp3')), tree(g.out).join('|'));
  assert.ok(tree(g.out).some((p) => p.startsWith(`Unknown Genre${S}`)), tree(g.out).join('|'));
  const aa = await run(inDir, { FolderTemplate: '{albumartist}/{album}' });
  assert.ok(tree(aa.out).includes(path.join('Various', 'Comp', 'A - T1.mp3')));
  assert.ok(tree(aa.out).some((p) => p.startsWith(path.join('Unknown Artist', 'Unknown Album') + S)));
  const y = await run(inDir, { FolderTemplate: '{year}' });
  assert.ok(tree(y.out).some((p) => p.startsWith(`2001${S}`)));
  assert.ok(tree(y.out).some((p) => p.startsWith(`Unknown${S}`)));
});

test('folder template: hostile tags and path traversal never leave the output folder', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: '../../x', title: 'T', album: '..\\..\\y', genre: '/abs/path' });
  song(inDir, 'b.flac', { artist: 'CON', title: 'T2', album: '...', genre: 'C:\\Windows' }, 500);
  const holder = fresh('holder');
  const out = path.join(holder, 'deep', 'out');
  const { r } = await run(inDir, { FolderTemplate: '{artist}/{album}' }, out);
  assert.equal(r.counts.OK, 2);
  // nothing was created next to or above the output folder
  assert.deepEqual(fs.readdirSync(holder), ['deep']);
  assert.deepEqual(fs.readdirSync(path.join(holder, 'deep')), ['out']);
  const files = tree(out);
  assert.equal(files.length, 2);
  for (const f of files) assert.ok(!f.split(S).includes('..'), f);
  assert.ok(files.includes(path.join('-..-x', '-..-y', '..-..-x - T.mp3')), files.join('|'));
  assert.ok(files.some((f) => f.startsWith(`_CON${S}Unknown${S}`)), files.join('|'));
  const g = await run(inDir, { FolderTemplate: '{genre}' });
  assert.ok(tree(g.out).every((f) => f.split(S).length === 2), tree(g.out).join('|'));
});

test('folder template: duplicate names are allocated per final folder', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'Same', album: 'One' });
  song(inDir, 'b.flac', { artist: 'A', title: 'Same', album: 'One' }, 500);
  song(inDir, 'c.flac', { artist: 'A', title: 'Same', album: 'Two' }, 600);
  const { out, r, results } = await run(inDir, { FolderTemplate: '{artist}/{album}', DuplicateMode: 'off' });
  assert.equal(r.counts.OK, 3);
  assert.deepEqual(tree(out), [
    path.join('A', 'One', 'A - Same (2).mp3'),
    path.join('A', 'One', 'A - Same.mp3'),
    path.join('A', 'Two', 'A - Same.mp3')
  ]);
  assert.equal(results.filter((x) => /duplicate name/.test(x.note)).length, 1);
});

test('folder template: replaces the mirrored sub-folder layout of Include sub-folders', { skip }, async () => {
  const inDir = fresh('in');
  fs.mkdirSync(path.join(inDir, 'sub', 'deeper'), { recursive: true });
  song(path.join(inDir, 'sub', 'deeper'), 'a.flac', { artist: 'A', title: 'T', album: 'Al' });
  const mirrored = await run(inDir, { Recurse: true });
  assert.deepEqual(tree(mirrored.out), [path.join('sub', 'deeper', 'A - T.mp3')]);
  const templated = await run(inDir, { Recurse: true, FolderTemplate: '{artist}/{album}' });
  assert.deepEqual(tree(templated.out), [path.join('A', 'Al', 'A - T.mp3')]);
});

test('folder template off: output is flat as before', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'T', album: 'Al' });
  const { out } = await run(inDir, { FolderTemplate: '' });
  assert.deepEqual(tree(out), ['A - T.mp3']);
});

test('folder template: unreadable files fail without creating folders', { skip }, async () => {
  const inDir = fresh('in');
  fs.writeFileSync(path.join(inDir, 'broken.mp3'), 'not audio');
  const { out, r } = await run(inDir, { FolderTemplate: '{artist}' });
  assert.equal(r.counts.FAIL, 1);
  assert.deepEqual(fs.readdirSync(out), []);
});

// ---- engine: second output ----

test('second output: the same songs again in another format and folder', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'One', album: 'X' });
  song(inDir, 'b.flac', { artist: 'B', title: 'Two', album: 'Y' }, 500);
  const second = path.join(fresh('holder'), 'second');
  const { out, r, results } = await run(inDir, { SecondFormat: 'flac', SecondOut: second });
  assert.deepEqual(tree(out), ['A - One.mp3', 'B - Two.mp3']);
  assert.deepEqual(tree(second), ['A - One.flac', 'B - Two.flac']);
  assert.equal(codecOf(path.join(second, 'A - One.flac')), 'flac');
  assert.equal(codecOf(path.join(out, 'A - One.mp3')), 'mp3');
  assert.equal(r.counts.SECOND, 2);
  assert.equal(r.counts.OK, 2, 'second results are not added to the main totals');
  assert.match(r.summary, /Done: 2 converted, 0 skipped, 0 failed\./);
  assert.match(r.summary, / 2 written to the second output\./);
  const seconds = results.filter((x) => x.second);
  assert.equal(seconds.length, 2);
  assert.ok(seconds.every((x) => x.note.startsWith('2nd output: ') && x.name.endsWith('.flac')));
  assert.equal(results.filter((x) => !x.second).length, 2);
});

test('second output: same folder template, own duplicate handling', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'Same', album: 'One' });
  song(inDir, 'b.flac', { artist: 'A', title: 'Same', album: 'One' }, 500);
  const second = path.join(fresh('holder'), 'second');
  const { out, r } = await run(inDir, { FolderTemplate: '{artist}/{album}', SecondFormat: 'wav', SecondOut: second, DuplicateMode: 'off' });
  assert.deepEqual(tree(out), [path.join('A', 'One', 'A - Same (2).mp3'), path.join('A', 'One', 'A - Same.mp3')]);
  assert.deepEqual(tree(second), [path.join('A', 'One', 'A - Same (2).wav'), path.join('A', 'One', 'A - Same.wav')]);
  assert.equal(r.counts.SECOND, 2);
});

test('second output: a skipped song in the main output (duplicate skip) is skipped in the second too', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'Same' });
  song(inDir, 'b.flac', { artist: 'A', title: 'Same' }); // identical length: same song
  const second = path.join(fresh('holder'), 'second');
  const { out, r } = await run(inDir, { DuplicateMode: 'skip', SecondFormat: 'm4a', SecondOut: second });
  assert.equal(r.counts.SKIP, 1);
  assert.equal(r.counts.SECOND, 1);
  assert.deepEqual(tree(out), ['A - Same.mp3']);
  assert.deepEqual(tree(second), ['A - Same.m4a']);
});

test('second output: existing files are never overwritten (second run only skips)', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'T' });
  const out = fresh('out');
  const second = path.join(fresh('holder'), 'second');
  const first = await run(inDir, { SecondFormat: 'flac', SecondOut: second }, out);
  assert.equal(first.r.counts.SECOND, 1);
  const again = await run(inDir, { SecondFormat: 'flac', SecondOut: second }, out);
  assert.equal(again.r.counts.SKIP, 1);
  assert.equal(again.r.counts.SECOND, 0);
  assert.ok(again.results.some((x) => x.second && x.status === 'SKIP'));
});

test('second output: no second run when its folder equals the output or the songs folder', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'T' });
  const out = fresh('out');
  const same = await run(inDir, { SecondFormat: 'flac', SecondOut: out }, out);
  assert.equal(same.r.counts.SECOND, 0);
  assert.deepEqual(tree(out), ['A - T.mp3']);
  assert.ok(same.events.some((e) => e.type === 'message' && /Second copy is off/.test(e.text)));
  const alias = await run(inDir, { SecondFormat: 'flac', SecondOut: `${out}${S}.${S}` }, out);
  assert.equal(alias.r.counts.SECOND, 0);
  const before = tree(inDir);
  const inSame = await run(inDir, { SecondFormat: 'flac', SecondOut: inDir });
  assert.equal(inSame.r.counts.SECOND, 0);
  assert.deepEqual(tree(inDir), before, 'nothing written into the songs folder');
});

test('second output: off by default, or without a folder, or with format off', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'T' });
  const second = path.join(fresh('holder'), 'second');
  for (const over of [{}, { SecondFormat: 'flac' }, { SecondOut: second }, { SecondFormat: 'off', SecondOut: second }]) {
    const { r } = await run(inDir, over);
    assert.equal(r.counts.SECOND, 0);
  }
  assert.ok(!fs.existsSync(second));
});

test('second output: failed primary files are not repeated in the second', { skip }, async () => {
  const inDir = fresh('in');
  fs.writeFileSync(path.join(inDir, 'broken.mp3'), 'not audio');
  song(inDir, 'a.flac', { artist: 'A', title: 'T' });
  const second = path.join(fresh('holder'), 'second');
  const { r, results } = await run(inDir, { SecondFormat: 'flac', SecondOut: second });
  assert.equal(r.counts.FAIL, 1);
  assert.equal(r.counts.SECOND, 1);
  assert.equal(results.filter((x) => x.second).length, 1);
  assert.deepEqual(tree(second), ['A - T.flac']);
});

test('second output: a stopped run stops cleanly', { skip }, async () => {
  const inDir = fresh('in');
  song(inDir, 'a.flac', { artist: 'A', title: 'T' });
  const ctrl = new AbortController();
  ctrl.abort();
  const second = path.join(fresh('holder'), 'second');
  const r = await runBatch({ inDir, outDir: fresh('out'), settings: { ...base, SecondFormat: 'flac', SecondOut: second }, tools, signal: ctrl.signal, onEvent: () => {} });
  assert.equal(r.stopped, true);
  assert.equal(r.counts.SECOND, 0);
});

test('report: second-output rows are marked; reports without a second copy keep their columns', () => {
  const plain = buildReport([{ status: 'OK', name: 'a.mp3', note: '320k' }]);
  assert.ok(plain.includes('status,file,notes,health,peak_db,duplicate\r\n'));
  const withSecond = buildReport([{ status: 'OK', name: 'a.mp3', note: '320k' }, { status: 'OK', name: 'a.flac', note: '2nd output: 16-bit', second: true }]);
  assert.ok(withSecond.includes('status,file,notes,health,peak_db,duplicate,output\r\n'));
  assert.ok(withSecond.includes(',no,,no,main\r\n'));
  assert.ok(withSecond.includes(',no,,no,second\r\n'));
});
