'use strict';
const fs = require('fs');
const path = require('path');
const { convertOne } = require('./convert');
const { NameAllocator } = require('./naming');
const { FORMATS } = require('./formats');
const { hasEncoder } = require('./tools');

const EXTENSIONS = new Set(['.flac', '.wav', '.aiff', '.aif', '.m4a', '.ogg', '.opus', '.wma', '.mp3']);

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function summarise(c) {
  let s = `Done: ${c.OK + c.WARN} converted, ${c.SKIP} skipped, ${c.FAIL} failed.`;
  if (c.WARN) s += ` ${c.WARN} flagged as low quality.`;
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
      else if (recurse && e.isDirectory() && depth < MAX_DEPTH && !(skipDir && samePath(full, skipDir))) walk(full, path.join(rel, e.name), depth + 1);
    }
  };
  walk(dir, '', 0);
  return found;
}

// `inputs` (optional) is a list of individual files, used instead of scanning `inDir`.
async function runBatch({ inDir, outDir, settings, tools, signal, onEvent, inputs }) {
  const message = (text, level = 'info') => onEvent({ type: 'message', text, level });
  if (!tools) { message('ERROR: ffmpeg not found. Put ffmpeg and ffprobe in the bin folder or pick them in the app (see the instructions).', 'error'); return { ok: false }; }
  const useInputs = Array.isArray(inputs) && inputs.length > 0;
  if (!useInputs && (!inDir || !fs.existsSync(inDir) || !fs.statSync(inDir).isDirectory())) { message(`ERROR: songs folder not found: ${inDir}`, 'error'); return { ok: false }; }
  if (!outDir) { message('ERROR: pick an output folder.', 'error'); return { ok: false }; }
  if (!useInputs && samePath(inDir, outDir)) { message('ERROR: output folder must be different from the songs folder.', 'error'); return { ok: false }; }
  const fmt = FORMATS[settings.Format] || FORMATS.mp3;
  if (fmt !== FORMATS.mp3 && !(await hasEncoder(tools.ffmpeg, fmt.encoder))) {
    message(`ERROR: this ffmpeg cannot write ${fmt.label} (no ${fmt.encoder} encoder). Choose another format or install a full ffmpeg build.`, 'error');
    return { ok: false };
  }
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (err) { message(`ERROR: cannot create the output folder: ${err.message}`, 'error'); return { ok: false }; }

  const files = useInputs
    ? inputs.map((full) => ({ full, rel: '' }))
    : scanFolder(inDir, { recurse: Boolean(settings.Recurse), skipDir: outDir });
  if (!files.length) { message(settings.Recurse ? 'No music files found in that folder or its sub-folders.' : 'No music files found in that folder.'); return { ok: false }; }

  const counts = { OK: 0, WARN: 0, FAKE: 0, LOW: 0, SKIP: 0, FAIL: 0 };
  const allocators = new Map(); // one per output folder, so the same title in two sub-folders is not a duplicate
  let stopped = false;
  onEvent({ type: 'progress', index: 0, total: files.length, file: '' });

  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) { stopped = true; break; }
    const file = files[i].full;
    const label = path.join(files[i].rel, path.basename(file));
    const target = files[i].rel ? path.join(outDir, files[i].rel) : outDir;
    if (!allocators.has(target)) allocators.set(target, new NameAllocator());
    onEvent({ type: 'progress', index: i, total: files.length, file: label, text: `Converting ${i + 1} of ${files.length} - ${label}` });
    let res;
    try {
      if (files[i].rel) fs.mkdirSync(target, { recursive: true });
      res = await convertOne({
        file, outDir: target, tools, settings, allocator: allocators.get(target), signal,
        onStatus: (text) => onEvent({ type: 'progress', index: i, total: files.length, file: label, text })
      });
    } catch (err) {
      res = { status: 'FAIL', name: label, note: err.message };
    }
    if (res.status === 'STOP') { stopped = true; break; }
    counts[res.status] += 1;
    onEvent({ type: 'result', status: res.status, name: files[i].rel ? path.join(files[i].rel, res.name) : res.name, note: res.note });
    onEvent({ type: 'progress', index: i + 1, total: files.length, file: label });
  }

  if (stopped) message('Stopped.');
  const summary = summarise(counts);
  message(summary, 'summary');
  onEvent({ type: 'done', summary, counts, stopped });
  return { ok: true, stopped, counts, summary };
}

module.exports = { runBatch, summarise, samePath, EXTENSIONS };
