'use strict';
const { run } = require('./proc');

// Reads the "Overall" block of ffmpeg's astats output -> { peakDb, peakCount } or null.
function parseAstats(stderr) {
  const at = stderr.lastIndexOf('Overall');
  if (at < 0) return null;
  const block = stderr.slice(at);
  const peak = /Peak level dB:\s*(-?[\d.]+|-?inf)/i.exec(block);
  const count = /Peak count:\s*([\d.]+)/i.exec(block);
  if (!peak) return null;
  return { peakDb: Number(peak[1]), peakCount: count ? Math.round(Number(count[1])) : 0 };
}

// Turns the numbers into a warning, or '' when the track is fine.
function describeClipping(m) {
  if (!m || !Number.isFinite(m.peakDb)) return '';
  if (m.peakDb > 0.05) return `peaks ${m.peakDb.toFixed(1)} dBFS (over 0, may distort)`;
  if (m.peakDb >= -0.1 && m.peakCount >= 10) return `possible clipping: ${m.peakCount} samples at full scale`;
  return '';
}

// -> { cancelled } | { msg, peakDb } (msg '' when fine or could not be measured; peakDb null when not measured)
async function checkClipping({ ffmpeg, file, signal }) {
  const r = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-af', 'astats', '-f', 'null', '-'], { signal });
  if (r.aborted) return { cancelled: true };
  if (r.code !== 0) return { msg: '', peakDb: null };
  const m = parseAstats(r.stderr);
  return { msg: describeClipping(m), peakDb: m && Number.isFinite(m.peakDb) ? m.peakDb : null };
}

module.exports = { parseAstats, describeClipping, checkClipping };
