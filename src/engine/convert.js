'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./proc');
const { joinArtists, buildName, pickTag, applyTemplate, trackNumber, yearOf, DEFAULT_TEMPLATE } = require('./naming');
const { testQuality } = require('./quality');
const { FORMATS } = require('./formats');
const { checkClipping } = require('./clipping');
const { songKey } = require('./duplicates');

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
async function convertOne({ file, outDir, tools, settings, allocator, signal, onStatus, seen }) {
  const baseName = path.basename(file);
  if (signal.aborted) return { status: 'STOP' };

  const info = await probe(tools.ffprobe, file, signal);
  if (info && info.cancelled) return { status: 'STOP' };
  if (!info) return { status: 'FAIL', name: baseName, note: 'unreadable file' };
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!audio) return { status: 'FAIL', name: baseName, note: 'no audio stream' };

  const tagSets = [info.format && info.format.tags, audio.tags];
  // "A;B" (several artists) becomes "A, B" unless the user turned that off; then the tags are left exactly as they are.
  const join = settings.JoinArtists === false ? ((v) => v) : joinArtists;
  const artist = join(pickTag(tagSets, 'artist'));
  const albumArtist = join(pickTag(tagSets, 'album_artist'));
  const keepCover = settings.CoverArt !== false;
  const title = pickTag(tagSets, 'title');
  const fields = {
    artist, title, albumartist: albumArtist,
    album: pickTag(tagSets, 'album'),
    track: trackNumber(pickTag(tagSets, 'track')),
    year: yearOf(pickTag(tagSets, 'date') || pickTag(tagSets, 'year'))
  };
  const fromTemplate = applyTemplate(settings.NameTemplate || DEFAULT_TEMPLATE, fields);

  const stem = buildName({ artist, title, fallbackBase: path.parse(baseName).name, outDir, base: fromTemplate || path.parse(baseName).name });
  if (!stem) return { status: 'FAIL', name: baseName, note: 'empty file name' };
  // The same song from another file or format (not the "Name (2)" de-duplication, which is about file names).
  const key = settings.DuplicateMode === 'off' || !seen ? '' : songKey(artist, title);
  const length = Number(info.format && info.format.duration) || 0;
  const twin = key ? seen.find(key, length) : null;
  if (twin && settings.DuplicateMode === 'skip') return { status: 'SKIP', name: baseName, note: `same song as ${twin}`, duplicate: true };
  const { name, duplicate } = allocator.allocate(stem);
  const dupNote = duplicate ? 'duplicate name; ' : '';
  const fmt = FORMATS[settings.Format] || FORMATS.mp3;
  const outName = `${name}${fmt.ext}`;
  const dest = path.join(outDir, outName);
  try {
    if (fs.statSync(dest).isDirectory()) return { status: 'FAIL', name: baseName, note: `a folder named ${outName} is in the way` };
    return { status: 'SKIP', name: outName, note: 'already exists' };
  } catch { /* nothing there yet */ }

  let quality = null;
  if (settings.QualityCheck !== 'off') {
    if (onStatus) onStatus(`Checking quality - ${baseName}`);
    quality = await testQuality({
      ffmpeg: tools.ffmpeg, file, audio, format: info.format, minKbps: settings.MinKbps, signal
    });
    if (quality.cancelled) return { status: 'STOP' };
    if (quality.low && settings.QualityCheck === 'skip') return { status: quality.kind, name: baseName, note: quality.msg };
  }

  let clipMsg = '';
  let peakDb = null;
  if (settings.ClipCheck) {
    if (onStatus) onStatus(`Checking levels - ${baseName}`);
    const c = await checkClipping({ ffmpeg: tools.ffmpeg, file, signal });
    if (c.cancelled) return { status: 'STOP' };
    clipMsg = c.msg;
    peakDb = c.peakDb;
  }

  const part = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
  const isMp3 = fmt === FORMATS.mp3 && audio.codec_name === 'mp3'; // an MP3 stays as is (no second lossy pass)
  const kbps = Math.min(settings.Bitrate, fmt.maxKbps || settings.Bitrate); // Opus tops out at 256k
  const args = ['-v', 'error', '-y', '-i', file, '-map', '0:a:0'];
  const coverOk = keepCover && fmt !== FORMATS.opus && !fmt.noCover; // the Opus and WAV containers take no cover art this way
  if (coverOk) args.push('-map', '0:v?');
  const tagMode = settings.TagMode || 'keep';
  args.push('-map_metadata', tagMode === 'keep' ? '0' : '-1');
  if (isMp3) {
    args.push('-c', 'copy');
  } else {
    const depth = settings.BitDepth === 24 ? 24 : 16;
    args.push('-c:a', fmt === FORMATS.wav ? (depth === 24 ? 'pcm_s24le' : 'pcm_s16le')
      : fmt === FORMATS.aiff ? (depth === 24 ? 'pcm_s24be' : 'pcm_s16be') : fmt.encoder);
    if (fmt.lossy) args.push('-b:a', `${kbps}k`);
    if (fmt.depth) {
      // 32-bit float (and other deeper) sources are converted to the chosen depth; 16-bit gets dither.
      if (fmt === FORMATS.flac) args.push('-sample_fmt', depth === 24 ? 's32' : 's16', ...(depth === 24 ? ['-bits_per_raw_sample', '24'] : []));
      if (depth === 16) args.push('-af', 'aresample=dither_method=triangular');
    } else if (fmt !== FORMATS.opus) {
      args.push('-ar', String(settings.SampleRate));
    }
    if (coverOk) args.push('-c:v', 'copy', '-disposition:v', 'attached_pic');
  }
  if (fmt === FORMATS.mp3) args.push('-id3v2_version', '3');
  if ((fmt === FORMATS.wav || fmt === FORMATS.aiff) && tagMode !== 'strip') args.push('-write_id3v2', '1');
  if (tagMode === 'keep') {
    if (artist) args.push('-metadata', `artist=${artist}`);
    if (albumArtist) args.push('-metadata', `album_artist=${albumArtist}`);
  } else if (tagMode === 'clean') {
    // only the main fields, written back explicitly
    const keep = { artist, album_artist: albumArtist, title, album: fields.album, track: pickTag(tagSets, 'track'), date: pickTag(tagSets, 'date') || pickTag(tagSets, 'year'), genre: pickTag(tagSets, 'genre') };
    for (const [k, v] of Object.entries(keep)) if (v) args.push('-metadata', `${k}=${v}`);
  }
  args.push('-f', fmt.muxer, part);

  try {
    const r = await run(tools.ffmpeg, args, { signal });
    if (r.aborted || signal.aborted) return { status: 'STOP' };
    if (r.code !== 0 || !fs.existsSync(part)) {
      const lines = r.stderr.trim().split(/\r?\n/);
      return { status: 'FAIL', name: baseName, note: lines[lines.length - 1] || 'conversion failed' };
    }
    if (!placeNoOverwrite(part, dest)) return { status: 'SKIP', name: outName, note: 'already exists' };
    let note = dupNote + (isMp3 ? 'MP3 kept as is' : fmt.lossy ? `${kbps}k` : fmt.depth ? `${settings.BitDepth === 24 ? 24 : 16}-bit` : 'lossless');
    if (quality && quality.msg) note += ` | ${quality.msg}`;
    if (twin) note += ` | possible duplicate of ${twin}`;
    if (clipMsg) note += ` | ${clipMsg}`;
    if (key) seen.add(key, length, outName);
    return { status: quality && quality.low ? 'WARN' : 'OK', name: outName, note, clipped: Boolean(clipMsg), duplicate: Boolean(twin), ...(peakDb !== null ? { peakDb } : {}) };
  } catch (err) {
    return { status: 'FAIL', name: baseName, note: err.message };
  } finally {
    try { fs.rmSync(part, { force: true }); } catch { /* leave it */ }
  }
}

module.exports = { convertOne, probe, placeNoOverwrite };
