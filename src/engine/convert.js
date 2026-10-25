'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./proc');
const { joinArtists, buildName, pickTag } = require('./naming');
const { testQuality } = require('./quality');
const { FORMATS } = require('./formats');

async function probe(ffprobe, file, signal) {
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal });
  if (r.aborted) return { cancelled: true };
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// Moves the finished temporary file into place without ever overwriting an existing file.
// Hard links fail on some file systems (e.g. exFAT USB sticks), so fall back to an exclusive copy.
function placeNoOverwrite(part, dest) {
  try {
    fs.linkSync(part, dest);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    try {
      fs.copyFileSync(part, dest, fs.constants.COPYFILE_EXCL);
    } catch (err2) {
      if (err2.code === 'EEXIST') return false;
      throw err2;
    }
  }
  return true;
}

// Converts one file. Returns { status: 'OK'|'WARN'|'LOW'|'FAKE'|'SKIP'|'FAIL'|'STOP', name, note }.
async function convertOne({ file, outDir, tools, settings, allocator, signal, onStatus }) {
  const baseName = path.basename(file);
  if (signal.aborted) return { status: 'STOP' };

  const info = await probe(tools.ffprobe, file, signal);
  if (info && info.cancelled) return { status: 'STOP' };
  if (!info) return { status: 'FAIL', name: baseName, note: 'unreadable file' };
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!audio) return { status: 'FAIL', name: baseName, note: 'no audio stream' };

  const tagSets = [info.format && info.format.tags, audio.tags];
  const artist = joinArtists(pickTag(tagSets, 'artist'));
  const albumArtist = joinArtists(pickTag(tagSets, 'album_artist'));
  const title = pickTag(tagSets, 'title');

  const stem = buildName({ artist, title, fallbackBase: path.parse(baseName).name, outDir });
  if (!stem) return { status: 'FAIL', name: baseName, note: 'empty file name' };
  const { name, duplicate } = allocator.allocate(stem);
  const dupNote = duplicate ? 'duplicate name; ' : '';
  const fmt = FORMATS[settings.Format] || FORMATS.mp3;
  const outName = `${name}${fmt.ext}`;
  const dest = path.join(outDir, outName);
  if (fs.existsSync(dest)) return { status: 'SKIP', name: outName, note: 'already exists' };

  let quality = null;
  if (settings.QualityCheck !== 'off') {
    if (onStatus) onStatus(`Checking quality - ${baseName}`);
    quality = await testQuality({
      ffmpeg: tools.ffmpeg, file, audio, format: info.format, minKbps: settings.MinKbps, signal
    });
    if (quality.cancelled) return { status: 'STOP' };
    if (quality.low && settings.QualityCheck === 'skip') return { status: quality.kind, name: baseName, note: quality.msg };
  }

  const part = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
  const isMp3 = fmt === FORMATS.mp3 && audio.codec_name === 'mp3'; // an MP3 stays as is (no second lossy pass)
  const kbps = Math.min(settings.Bitrate, fmt.maxKbps || settings.Bitrate); // Opus tops out at 256k
  const args = ['-v', 'error', '-y', '-i', file, '-map', '0:a:0'];
  if (fmt !== FORMATS.opus) args.push('-map', '0:v?'); // cover art (the Ogg/Opus container takes none this way)
  args.push('-map_metadata', '0');
  if (isMp3) {
    args.push('-c', 'copy');
  } else {
    args.push('-c:a', fmt.encoder);
    if (fmt.lossy) args.push('-b:a', `${kbps}k`);
    if (fmt !== FORMATS.opus && fmt !== FORMATS.flac) args.push('-ar', String(settings.SampleRate));
    if (fmt !== FORMATS.opus) args.push('-c:v', 'copy', '-disposition:v', 'attached_pic');
  }
  if (fmt === FORMATS.mp3) args.push('-id3v2_version', '3');
  if (artist) args.push('-metadata', `artist=${artist}`);
  if (albumArtist) args.push('-metadata', `album_artist=${albumArtist}`);
  args.push('-f', fmt.muxer, part);

  try {
    const r = await run(tools.ffmpeg, args, { signal });
    if (r.aborted || signal.aborted) return { status: 'STOP' };
    if (r.code !== 0 || !fs.existsSync(part)) {
      const lines = r.stderr.trim().split(/\r?\n/);
      return { status: 'FAIL', name: baseName, note: lines[lines.length - 1] || 'conversion failed' };
    }
    if (!placeNoOverwrite(part, dest)) return { status: 'SKIP', name: outName, note: 'already exists' };
    let note = dupNote + (isMp3 ? 'MP3 kept as is' : fmt.lossy ? `${settings.Bitrate}k` : 'lossless');
    if (quality && quality.msg) note += ` | ${quality.msg}`;
    return { status: quality && quality.low ? 'WARN' : 'OK', name: outName, note };
  } catch (err) {
    return { status: 'FAIL', name: baseName, note: err.message };
  } finally {
    try { fs.rmSync(part, { force: true }); } catch { /* leave it */ }
  }
}

module.exports = { convertOne, probe, placeNoOverwrite };
