'use strict';
const fs = require('fs');
const { run } = require('./proc');

const MAX_SIDE = 1000; // larger art counts as oversized
const MAX_BYTES = 1000 * 1000;
const TARGET = 800; // long side of the resized JPEG

// The embedded picture of a probed file, or null.
function findArt(info) {
  return (info.streams || []).find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic) || null;
}

// Extracts the embedded picture and, if it is oversized, writes a smaller JPEG.
// Temp files are `${base}.art*` and are always removed by cleanup() (also on failure).
// -> { file|null, cleanup }  (file is the resized JPEG; null means leave the art as it is)
async function resizeArt({ ffmpeg, input, art, base, signal }) {
  const raw = `${base}.art-in`;
  const small = `${base}.art-out.jpg`;
  const cleanup = () => { for (const f of [raw, small]) try { fs.rmSync(f, { force: true }); } catch { /* leave it */ } };
  const none = { file: null, cleanup };
  const big = Number(art.width) > MAX_SIDE || Number(art.height) > MAX_SIDE;
  const x = await run(ffmpeg, ['-v', 'error', '-y', '-i', input, '-map', `0:${art.index}`, '-c', 'copy', '-frames:v', '1', '-update', '1', '-f', 'image2', raw], { signal });
  if (x.aborted || x.code !== 0 || !fs.existsSync(raw)) return none;
  if (!big && fs.statSync(raw).size <= MAX_BYTES) return none;
  const scale = `scale='if(gt(iw,ih),min(${TARGET},iw),-2)':'if(gt(iw,ih),-2,min(${TARGET},ih))'`;
  const s = await run(ffmpeg, ['-v', 'error', '-y', '-i', raw, '-vf', scale, '-q:v', '3', '-frames:v', '1', '-update', '1', '-f', 'image2', small], { signal });
  if (s.aborted || s.code !== 0 || !fs.existsSync(small)) return none;
  return { file: small, cleanup };
}

module.exports = { findArt, resizeArt };
