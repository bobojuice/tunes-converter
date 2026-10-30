'use strict';
const fs = require('fs');
const path = require('path');
const { convertOne } = require('./convert');
const { NameAllocator, folderPath } = require('./naming');
const { FORMATS } = require('./formats');
const { hasEncoder } = require('./tools');
const { SeenSongs } = require('./duplicates');
const { PLAYERS, playerPreflight } = require('./players');

const EXTENSIONS = new Set(['.flac', '.wav', '.aiff', '.aif', '.m4a', '.ogg', '.opus', '.wma', '.mp3']);

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// Canonical form of a path: symlinks and junctions resolved. For a path that does not exist yet, the nearest
// existing parent is resolved and the rest appended, so aliases of the same folder compare equal.
function canon(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch { /* go up one level */ }
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.push(path.basename(cur));
    cur = parent;
  }
}
const sameFolder = (a, b) => samePath(canon(a), canon(b));

function summarise(c, playerLabel = '') {
  let s = `Done: ${c.OK + c.WARN} converted, ${c.SKIP} skipped, ${c.FAIL} failed.`;
  if (c.WARN) s += ` ${c.WARN} flagged as low quality.`;
  if (c.CLIPPED) s += ` ${c.CLIPPED} with clipping or peaks over 0 dBFS.`;
  if (c.HEALTH) s += ` ${c.HEALTH} with health flags.`;
  if (c.PLAYER) s += ` ${c.PLAYER} may not play on ${playerLabel || 'the chosen player'}.`;
  if (c.DUPLICATE) s += ` ${c.DUPLICATE} possible duplicate${c.DUPLICATE === 1 ? '' : 's'}.`;
  if (c.FAKE + c.LOW) s += ` ${c.FAKE + c.LOW} not converted (below quality minimum, ${c.FAKE} of them fakes).`;
  if (c.SECOND) s += ` ${c.SECOND} written to the second output.`;
  return s;
}

// Runs a whole folder. `onEvent` receives { type: 'message'|'progress'|'result'|'done', ... }.
// Resolves { ok, stopped, counts, summary }.
const MAX_DEPTH = 20;

// Music files in `dir`, as { full, rel } where rel is the sub-folder path below `dir` ('' at the top).
// With `recurse`, sub-folders are walked too (not symlinks, never the output folder).
function scanFolder(dir, { recurse, skipDir }) {
  const skips = [].concat(skipDir || []); // output folders are never scanned as music
  const found = [];
  const walk = (current, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase())) found.push({ full, rel });
      else if (recurse && e.isDirectory() && depth < MAX_DEPTH && !skips.some((d) => sameFolder(full, d))) walk(full, path.join(rel, e.name), depth + 1);
    }
  };
  walk(dir, '', 0);
  return found;
}

// One output: a folder, a format and the bookkeeping that belongs to it (file names per folder, duplicate songs).
function makeLane(root, settings) {
  const fmt = FORMATS[settings.Format] || FORMATS.mp3;
  const allocators = new Map(); // one per output folder, so the same title in two sub-folders is not a duplicate
  const caseless = process.platform === 'win32' || process.platform === 'darwin';
  const allocatorFor = (dir) => {
    const k = caseless ? dir.toLowerCase() : dir;
    if (!allocators.has(k)) allocators.set(k, new NameAllocator());
    return allocators.get(k);
  };
  return { root, settings, fmt, seen: new SeenSongs(), allocatorFor };
}

// A mirrored sub-folder such as "album.mp3" must not also be the name of a converted file in its parent.
function reserveMirrored(lane, files) {
  for (const f of files) {
    const parts = f.rel ? f.rel.split(path.sep) : [];
    for (let k = 0; k < parts.length; k++) {
      const parent = path.join(lane.root, ...parts.slice(0, k));
      const dirName = parts[k];
      const stem = dirName.toLowerCase().endsWith(lane.fmt.ext) ? dirName.slice(0, -lane.fmt.ext.length) : null;
      if (stem) lane.allocatorFor(parent).reserve(stem);
    }
  }
}

const isInside = (root, dir) => {
  const r = path.relative(root, dir);
  return Boolean(r) && !path.isAbsolute(r) && r.split(path.sep)[0] !== '..';
};

// A sub-folder that is a link (symlink, junction) to somewhere else must not carry files out of the output folder.
// Checked on the real location of the folder, or of its nearest existing parent when it does not exist yet.
function assertInsideCanon(root, dir) {
  const r = path.relative(canon(root), canon(dir));
  if (path.isAbsolute(r) || r.split(path.sep)[0] === '..') throw new Error('folder is a link that leads outside the output folder');
}

// Converts one file into one lane. Returns { res, rel } where rel is the sub-folder below the lane's folder.
// With a folder template the sub-folder comes from the file's tags and replaces the mirrored layout.
async function convertInLane(lane, entry, { tools, signal, onStatus }) {
  const template = lane.settings.FolderTemplate;
  let rel = template ? '' : entry.rel;
  const common = { file: entry.full, tools, settings: lane.settings, signal, seen: lane.seen, onStatus };
  try {
    if (template) {
      const res = await convertOne({
        ...common,
        folderFor: (fields) => {
          rel = folderPath(template, fields);
          const dir = path.join(lane.root, rel);
          if (!isInside(lane.root, dir)) throw new Error('folder would be outside the output folder');
          assertInsideCanon(lane.root, dir);
          return { outDir: dir, allocator: lane.allocatorFor(dir) };
        }
      });
      return { res, rel };
    }
    const target = rel ? path.join(lane.root, rel) : lane.root;
    if (rel) { assertInsideCanon(lane.root, target); fs.mkdirSync(target, { recursive: true }); }
    return { res: await convertOne({ ...common, outDir: target, allocator: lane.allocatorFor(target) }), rel };
  } catch (err) {
    return { res: { status: 'FAIL', name: path.basename(entry.full), note: err.message }, rel };
  }
}

// `inputs` (optional) is a list of individual files, used instead of scanning `inDir`. An entry is a path string
// (written flat into the output folder) or { full, rel } where rel is the sub-folder to mirror below the output folder.
async function runBatch({ inDir, outDir, settings, tools, signal, onEvent, inputs }) {
  const message = (text, level = 'info') => onEvent({ type: 'message', text, level });
  if (!tools) { message('ERROR: ffmpeg not found. Put ffmpeg and ffprobe in the bin folder or pick them in the app (see the instructions).', 'error'); return { ok: false }; }
  const useInputs = Array.isArray(inputs); // an empty list is a selection with nothing in it, never "scan the folder"
  if (useInputs && !inputs.length) { message('No dropped music files are selected. Drop files again or use the folder.', 'error'); return { ok: false }; }
  if (!useInputs && (!inDir || !fs.existsSync(inDir) || !fs.statSync(inDir).isDirectory())) { message(`ERROR: songs folder not found: ${inDir}`, 'error'); return { ok: false }; }
  if (!outDir) { message('ERROR: pick an output folder.', 'error'); return { ok: false }; }
  if (!useInputs && sameFolder(inDir, outDir)) { message('ERROR: output folder must be different from the songs folder.', 'error'); return { ok: false }; }
  const fmt = FORMATS[settings.Format] || FORMATS.mp3;
  if (fmt !== FORMATS.mp3 && !(await hasEncoder(tools.ffmpeg, fmt.encoder))) {
    message(`ERROR: this ffmpeg cannot write ${fmt.label} (no ${fmt.encoder} encoder). Choose another format or install a full ffmpeg build.`, 'error');
    return { ok: false };
  }
  // Second copy: the same songs again in another format and folder. Ignored when it would land in the main output
  // folder or the songs folder.
  let second = null;
  const fmt2 = settings.SecondFormat && settings.SecondFormat !== 'off' && settings.SecondOut ? FORMATS[settings.SecondFormat] : null;
  if (fmt2) {
    // Checked in every input mode: with dropped files the source folders are the parents of the dropped files.
    const sourceDirs = [...(inDir ? [inDir] : []), ...(useInputs ? inputs.map((i) => path.dirname(typeof i === 'string' ? i : i.full)) : [])];
    if (sameFolder(settings.SecondOut, outDir) || sourceDirs.some((d) => sameFolder(settings.SecondOut, d))) {
      message('Second copy is off for this run: its folder must differ from the output folder and the songs folder.');
    } else {
      if (fmt2 !== FORMATS.mp3 && !(await hasEncoder(tools.ffmpeg, fmt2.encoder))) {
        message(`ERROR: this ffmpeg cannot write ${fmt2.label} for the second copy (no ${fmt2.encoder} encoder). Choose another format or install a full ffmpeg build.`, 'error');
        return { ok: false };
      }
      try { fs.mkdirSync(settings.SecondOut, { recursive: true }); } catch (err) { message(`ERROR: cannot create the second output folder: ${err.message}`, 'error'); return { ok: false }; }
      second = makeLane(settings.SecondOut, { ...settings, Format: settings.SecondFormat });
    }
  }
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (err) { message(`ERROR: cannot create the output folder: ${err.message}`, 'error'); return { ok: false }; }

  const files = useInputs
    ? inputs.map((i) => (typeof i === 'string' ? { full: i, rel: '' } : { full: i.full, rel: i.rel || '' }))
    : scanFolder(inDir, { recurse: Boolean(settings.Recurse), skipDir: second ? [outDir, second.root] : outDir });
  if (!files.length) { message(settings.Recurse ? 'No music files found in that folder or its sub-folders.' : 'No music files found in that folder.'); return { ok: false }; }

  const counts = { OK: 0, WARN: 0, FAKE: 0, LOW: 0, SKIP: 0, FAIL: 0, CLIPPED: 0, DUPLICATE: 0, HEALTH: 0, PLAYER: 0, SECOND: 0 };
  // Player check: one informational line up front when the chosen format is not listed. Never blocks the run.
  const player = PLAYERS[settings.PlayerModel] ? settings.PlayerModel : '';
  if (player) for (const m of playerPreflight(player, [settings.Format, ...(second ? [settings.SecondFormat] : [])])) message(m);
  const primary = makeLane(outDir, settings);
  if (!settings.FolderTemplate) {
    reserveMirrored(primary, files);
    if (second) reserveMirrored(second, files);
  }
  let stopped = false;
  onEvent({ type: 'progress', index: 0, total: files.length, file: '' });

  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) { stopped = true; break; }
    const label = path.join(files[i].rel, path.basename(files[i].full));
    onEvent({ type: 'progress', index: i, total: files.length, file: label, text: `Converting ${i + 1} of ${files.length} - ${label}` });
    const onStatus = (text) => onEvent({ type: 'progress', index: i, total: files.length, file: label, text });
    const { res, rel } = await convertInLane(primary, files[i], { tools, signal, onStatus });
    if (res.status === 'STOP') { stopped = true; break; }
    counts[res.status] += 1;
    if (res.clipped) counts.CLIPPED += 1;
    if (res.duplicate) counts.DUPLICATE += 1;
    if (res.health) counts.HEALTH += 1;
    if (res.player) counts.PLAYER += 1;
    // A skipped file still has a converted copy in the output folder (the one it duplicates, or the one that was already there): `play` names it.
    const play = res.twinFile && isInside(primary.root, res.twinFile) ? path.relative(primary.root, res.twinFile) : '';
    onEvent({ type: 'result', status: res.status, name: rel ? path.join(rel, res.name) : res.name, play, note: res.note, health: Boolean(res.health), player: Boolean(res.player),duplicate: Boolean(res.duplicate), peak: typeof res.peakDb === 'number' ? res.peakDb : null });
    // The second copy follows the primary one; a failed or stopped primary file is not repeated.
    if (second && ['OK', 'WARN', 'SKIP'].includes(res.status)) {
      const r2 = await convertInLane(second, files[i], { tools, signal, onStatus: (text) => onStatus(`Second copy - ${text}`) });
      if (r2.res.status === 'STOP') { stopped = true; break; }
      if (r2.res.status === 'OK' || r2.res.status === 'WARN') counts.SECOND += 1; // not added to the main totals
      if (r2.res.player) counts.PLAYER += 1;
      onEvent({ type: 'result', status: r2.res.status, name: r2.rel ? path.join(r2.rel, r2.res.name) : r2.res.name, note: `2nd output: ${r2.res.note || ''}`, second: true, health: false, player: Boolean(r2.res.player), duplicate: false, peak: null });
    }
    onEvent({ type: 'progress', index: i + 1, total: files.length, file: label });
  }

  if (stopped) message('Stopped.');
  const summary = summarise(counts, player ? PLAYERS[player].label : '');
  message(summary, 'summary');
  onEvent({ type: 'done', summary, counts, stopped });
  return { ok: true, stopped, counts, summary };
}

module.exports = { runBatch, summarise, samePath, canon, sameFolder, EXTENSIONS };
