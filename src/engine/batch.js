'use strict';
const fs = require('fs');
const path = require('path');
const { convertOne } = require('./convert');
const { NameAllocator } = require('./naming');

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
async function runBatch({ inDir, outDir, settings, tools, signal, onEvent }) {
  const message = (text, level = 'info') => onEvent({ type: 'message', text, level });
  if (!tools) { message('ERROR: ffmpeg not found. Put ffmpeg and ffprobe in the bin folder or pick them in the app (see the instructions).', 'error'); return { ok: false }; }
  if (!inDir || !fs.existsSync(inDir) || !fs.statSync(inDir).isDirectory()) { message(`ERROR: songs folder not found: ${inDir}`, 'error'); return { ok: false }; }
  if (!outDir) { message('ERROR: pick an output folder.', 'error'); return { ok: false }; }
  if (samePath(inDir, outDir)) { message('ERROR: output folder must be different from the songs folder.', 'error'); return { ok: false }; }
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (err) { message(`ERROR: cannot create the output folder: ${err.message}`, 'error'); return { ok: false }; }

  const files = fs.readdirSync(inDir, { withFileTypes: true })
    .filter((e) => e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (!files.length) { message('No music files found in that folder.'); return { ok: false }; }

  const counts = { OK: 0, WARN: 0, FAKE: 0, LOW: 0, SKIP: 0, FAIL: 0 };
  const allocator = new NameAllocator();
  let stopped = false;
  onEvent({ type: 'progress', index: 0, total: files.length, file: '' });

  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) { stopped = true; break; }
    const file = path.join(inDir, files[i]);
    onEvent({ type: 'progress', index: i, total: files.length, file: files[i], text: `Converting ${i + 1} of ${files.length} - ${files[i]}` });
    let res;
    try {
      res = await convertOne({
        file, outDir, tools, settings, allocator, signal,
        onStatus: (text) => onEvent({ type: 'progress', index: i, total: files.length, file: files[i], text })
      });
    } catch (err) {
      res = { status: 'FAIL', name: files[i], note: err.message };
    }
    if (res.status === 'STOP') { stopped = true; break; }
    counts[res.status] += 1;
    onEvent({ type: 'result', status: res.status, name: res.name, note: res.note });
    onEvent({ type: 'progress', index: i + 1, total: files.length, file: files[i] });
  }

  if (stopped) message('Stopped.');
  const summary = summarise(counts);
  message(summary, 'summary');
  onEvent({ type: 'done', summary, counts, stopped });
  return { ok: true, stopped, counts, summary };
}

module.exports = { runBatch, summarise, samePath, EXTENSIONS };
