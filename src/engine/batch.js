'use strict';
const fs = require('fs');
const path = require('path');
const { convertOne } = require('./convert');
const { NameAllocator } = require('./naming');
const { FORMATS } = require('./formats');
const { hasEncoder } = require('./tools');
const { SeenSongs } = require('./duplicates');

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

function summarise(c) {
  let s = `Done: ${c.OK + c.WARN} converted, ${c.SKIP} skipped, ${c.FAIL} failed.`;
  if (c.WARN) s += ` ${c.WARN} flagged as low quality.`;
  if (c.CLIPPED) s += ` ${c.CLIPPED} with clipping or peaks over 0 dBFS.`;
  if (c.HEALTH) s += ` ${c.HEALTH} with health flags.`;
  if (c.DUPLICATE) s += ` ${c.DUPLICATE} possible duplicate${c.DUPLICATE === 1 ? '' : 's'}.`;
  if (c.FAKE + c.LOW) s += ` ${c.FAKE + c.LOW} not converted (below quality minimum, ${c.FAKE} of them fakes).`;
  return s;
}

// Runs a whole folder. `onEvent` receives { type: 'message'|'progress'|'result'|'done', ... }.
// Resolves { ok, stopped, counts, summary }.
const MAX_DEPTH = 20;

// Music files in `dir`, as { full, rel } where rel is the sub-folder path below `dir` ('' at the top).
// With `recurse`, sub-folders are walked too (not symlinks, never the output folder).
function scanFolder(dir, { recurse, skipDir }) {
  const found = [];
  const walk = (current, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase())) found.push({ full, rel });
      else if (recurse && e.isDirectory() && depth < MAX_DEPTH && !(skipDir && sameFolder(full, skipDir))) walk(full, path.join(rel, e.name), depth + 1);
    }
  };
  walk(dir, '', 0);
  return found;
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
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (err) { message(`ERROR: cannot create the output folder: ${err.message}`, 'error'); return { ok: false }; }

  const files = useInputs
    ? inputs.map((i) => (typeof i === 'string' ? { full: i, rel: '' } : { full: i.full, rel: i.rel || '' }))
    : scanFolder(inDir, { recurse: Boolean(settings.Recurse), skipDir: outDir });
  if (!files.length) { message(settings.Recurse ? 'No music files found in that folder or its sub-folders.' : 'No music files found in that folder.'); return { ok: false }; }

  const counts = { OK: 0, WARN: 0, FAKE: 0, LOW: 0, SKIP: 0, FAIL: 0, CLIPPED: 0, DUPLICATE: 0, HEALTH: 0 };
  const seen = new SeenSongs(); // songs already converted in this run
  const allocators = new Map(); // one per output folder, so the same title in two sub-folders is not a duplicate
  const allocatorFor = (dir) => {
    if (!allocators.has(dir)) allocators.set(dir, new NameAllocator());
    return allocators.get(dir);
  };
  // A mirrored sub-folder such as "album.mp3" must not also be the name of a converted file in its parent.
  for (const f of files) {
    const parts = f.rel ? f.rel.split(path.sep) : [];
    for (let k = 0; k < parts.length; k++) {
      const parent = path.join(outDir, ...parts.slice(0, k));
      const dirName = parts[k];
      const stem = dirName.toLowerCase().endsWith(fmt.ext) ? dirName.slice(0, -fmt.ext.length) : null;
      if (stem) allocatorFor(parent).reserve(stem);
    }
  }
  let stopped = false;
  onEvent({ type: 'progress', index: 0, total: files.length, file: '' });

  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) { stopped = true; break; }
    const file = files[i].full;
    const label = path.join(files[i].rel, path.basename(file));
    const target = files[i].rel ? path.join(outDir, files[i].rel) : outDir;
    onEvent({ type: 'progress', index: i, total: files.length, file: label, text: `Converting ${i + 1} of ${files.length} - ${label}` });
    let res;
    try {
      if (files[i].rel) fs.mkdirSync(target, { recursive: true });
      res = await convertOne({
        file, outDir: target, tools, settings, allocator: allocatorFor(target), signal, seen,
        onStatus: (text) => onEvent({ type: 'progress', index: i, total: files.length, file: label, text })
      });
    } catch (err) {
      res = { status: 'FAIL', name: label, note: err.message };
    }
    if (res.status === 'STOP') { stopped = true; break; }
    counts[res.status] += 1;
    if (res.clipped) counts.CLIPPED += 1;
    if (res.duplicate) counts.DUPLICATE += 1;
    if (res.health) counts.HEALTH += 1;
    onEvent({ type: 'result', status: res.status, name: files[i].rel ? path.join(files[i].rel, res.name) : res.name, note: res.note, health: Boolean(res.health), duplicate: Boolean(res.duplicate), peak: typeof res.peakDb === 'number' ? res.peakDb : null });
    onEvent({ type: 'progress', index: i + 1, total: files.length, file: label });
  }

  if (stopped) message('Stopped.');
  const summary = summarise(counts);
  message(summary, 'summary');
  onEvent({ type: 'done', summary, counts, stopped });
  return { ok: true, stopped, counts, summary };
}

module.exports = { runBatch, summarise, samePath, canon, sameFolder, EXTENSIONS };
