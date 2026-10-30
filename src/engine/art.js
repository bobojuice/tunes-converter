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
// With `resize: false` the picture is only extracted (raw is returned, file stays null).
// -> { file|null, raw|null, cleanup }  (raw is the extracted original, when extraction worked)
async function resizeArt({ ffmpeg, input, art, base, signal, resize = true }) {
  const raw = `${base}.art-in`;
  const small = `${base}.art-out.jpg`;
  const cleanup = () => { for (const f of [raw, small]) try { fs.rmSync(f, { force: true }); } catch { /* leave it */ } };
  const none = { file: null, raw: null, cleanup };
  const big = Number(art.width) > MAX_SIDE || Number(art.height) > MAX_SIDE;
  const x = await run(ffmpeg, ['-v', 'error', '-y', '-i', input, '-map', `0:${art.index}`, '-c', 'copy', '-frames:v', '1', '-update', '1', '-f', 'image2', raw], { signal });
  if (x.aborted || x.code !== 0 || !fs.existsSync(raw)) return none;
  const kept = { file: null, raw, cleanup };
  if (!resize || (!big && fs.statSync(raw).size <= MAX_BYTES)) return kept;
  const scale = `scale='if(gt(iw,ih),min(${TARGET},iw),-2)':'if(gt(iw,ih),-2,min(${TARGET},ih))'`;
  const s = await run(ffmpeg, ['-v', 'error', '-y', '-i', raw, '-vf', scale, '-q:v', '3', '-frames:v', '1', '-update', '1', '-f', 'image2', small], { signal });
  if (s.aborted || s.code !== 0 || !fs.existsSync(small)) return kept;
  return { file: small, raw, cleanup };
}

// Width and height of a JPEG or PNG buffer, or [0, 0] when unknown.
function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; } // markers without a length field
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return [0, 0];
}

// FLAC PICTURE block (front cover, empty description, 24-bit, all big-endian), or null if the data is not a JPEG/PNG.
function pictureBlock(img) {
  const png = img.length > 8 && img[0] === 0x89 && img[1] === 0x50;
  const jpg = img.length > 4 && img[0] === 0xff && img[1] === 0xd8;
  if (!png && !jpg) return null;
  const mime = Buffer.from(png ? 'image/png' : 'image/jpeg', 'ascii');
  const [w, h] = imageSize(img);
  const head = Buffer.alloc(8 + mime.length + 4 + 20);
  let o = 0;
  head.writeUInt32BE(3, o); o += 4; // front cover
  head.writeUInt32BE(mime.length, o); o += 4;
  mime.copy(head, o); o += mime.length;
  head.writeUInt32BE(0, o); o += 4; // description length
  head.writeUInt32BE(w, o); o += 4;
  head.writeUInt32BE(h, o); o += 4;
  head.writeUInt32BE(24, o); o += 4; // colour depth
  head.writeUInt32BE(0, o); o += 4; // indexed colours
  head.writeUInt32BE(img.length, o);
  return Buffer.concat([head, img]);
}

// ffmetadata text carrying the picture as METADATA_BLOCK_PICTURE (the Opus/Vorbis way), or null.
function pictureMetadata(img) {
  const block = pictureBlock(img);
  if (!block) return null;
  const b64 = block.toString('base64').replace(/[=;#\\\n]/g, (c) => `\\${c}`);
  return `;FFMETADATA1\nMETADATA_BLOCK_PICTURE=${b64}\n`;
}

module.exports = { findArt, resizeArt, pictureBlock, pictureMetadata, imageSize };
