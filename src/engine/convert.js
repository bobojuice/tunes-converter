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
const { checkHealth } = require('./health');
const { findArt, resizeArt, pictureMetadata } = require('./art');
const { playerNote } = require('./players');

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

// True when the source already is the output codec (and, for lossless, the chosen bit depth), so the audio can be copied.
function canCopy(fmt, audio, container, depth) {
  const codec = audio.codec_name;
  if (fmt === FORMATS.mp3) return codec === 'mp3';
  if (fmt === FORMATS.m4a) return codec === 'aac' && /mp4|mov/.test((container && container.format_name) || '');
  if (fmt === FORMATS.opus) return codec === 'opus';
  const bits = Number(audio.bits_per_raw_sample) || Number(audio.bits_per_sample) || 0;
  if (fmt === FORMATS.flac) return codec === 'flac' && bits === depth;
  if (fmt === FORMATS.wav) return codec === `pcm_s${depth}le`;
  if (fmt === FORMATS.aiff) return codec === `pcm_s${depth}be`;
  return false;
}

// The converted file gets the source file's modified time (best effort, never an error).
function keepDates(src, dest) {
  try {
    const st = fs.statSync(src);
    fs.utimesSync(dest, st.atime, st.mtime);
  } catch { /* leave the dates as they are */ }
}

// Converts one file. Returns { status: 'OK'|'WARN'|'LOW'|'FAKE'|'SKIP'|'FAIL'|'STOP', name, note }.
// `folderFor(fields)` (optional) picks the output folder from the tags once they are read: it returns
// { outDir, allocator } and replaces the `outDir` / `allocator` given here.
async function convertOne({ file, outDir, tools, settings, allocator, signal, onStatus, seen, folderFor }) {
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
    year: yearOf(pickTag(tagSets, 'date') || pickTag(tagSets, 'year')),
    genre: pickTag(tagSets, 'genre')
  };
  if (folderFor) ({ outDir, allocator } = folderFor(fields));
  const fromTemplate = applyTemplate(settings.NameTemplate || DEFAULT_TEMPLATE, fields);

  const stem = buildName({ artist, title, fallbackBase: path.parse(baseName).name, outDir, base: fromTemplate || path.parse(baseName).name });
  if (!stem) return { status: 'FAIL', name: baseName, note: 'empty file name' };
  // The same song from another file or format (not the "Name (2)" de-duplication, which is about file names).
  const key = settings.DuplicateMode === 'off' || !seen ? '' : songKey(artist, title);
  const length = Number(info.format && info.format.duration) || 0;
  const twinEntry = key ? seen.findEntry(key, length) : null;
  const twin = twinEntry ? twinEntry.name : null;
  if (twin && settings.DuplicateMode === 'skip') return { status: 'SKIP', name: baseName, note: `same song as ${twin}`, duplicate: true, twinFile: path.join(twinEntry.dir || outDir, twin) };
  const { name, duplicate } = allocator.allocate(stem);
  const dupNote = duplicate ? 'duplicate name; ' : '';
  const fmt = FORMATS[settings.Format] || FORMATS.mp3;
  const outName = `${name}${fmt.ext}`;
  const dest = path.join(outDir, outName);
  try {
    if (fs.statSync(dest).isDirectory()) return { status: 'FAIL', name: baseName, note: `a folder named ${outName} is in the way` };
    return { status: 'SKIP', name: outName, note: 'already exists', twinFile: dest };
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

  let healthMsg = '';
  if (settings.HealthCheck !== false) {
    if (onStatus) onStatus(`Checking file - ${baseName}`);
    const h = await checkHealth({ ffmpeg: tools.ffmpeg, file, audio, format: info.format, signal });
    if (h.cancelled) return { status: 'STOP' };
    healthMsg = h.msg; // flagged only, the file is converted as usual
  }

  if (folderFor) { // created only when a file is really going in
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (err) { return { status: 'FAIL', name: baseName, note: `cannot create folder: ${err.message}` }; }
  }
  const part = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
  const depth = settings.BitDepth === 24 ? 24 : 16;
  const copy = settings.CopyMode !== false && canCopy(fmt, audio, info.format, depth); // same codec: only name, tags and cover change
  const kbps = Math.min(settings.Bitrate, fmt.maxKbps || settings.Bitrate); // Opus tops out at 256k
  const coverOk = keepCover && fmt !== FORMATS.opus && !fmt.noCover; // the Opus and WAV containers take no cover art this way
  let artFile = null;
  let artCleanup = () => {};
  const metaFile = `${part}.meta`;
  const args = ['-v', 'error', '-y', '-i', file];
  try {
    const art = coverOk && settings.ArtResize !== false ? findArt(info) : null;
    if (art) {
      if (onStatus) onStatus(`Checking cover art - ${baseName}`);
      const small = await resizeArt({ ffmpeg: tools.ffmpeg, input: file, art, base: part, signal });
      artCleanup = small.cleanup;
      if (signal.aborted) return { status: 'STOP' };
      artFile = small.file;
    }
    const tagMode = settings.TagMode || 'keep';
    // Opus: the ogg muxer drops attached pictures, so the cover goes in as a METADATA_BLOCK_PICTURE tag via a temp ffmetadata input.
    let metaIdx = -1;
    const opusArt = keepCover && fmt === FORMATS.opus && tagMode !== 'strip' ? findArt(info) : null;
    if (opusArt) {
      try {
        if (onStatus) onStatus(`Checking cover art - ${baseName}`);
        const got = await resizeArt({ ffmpeg: tools.ffmpeg, input: file, art: opusArt, base: part, signal, resize: settings.ArtResize !== false });
        artCleanup = got.cleanup;
        if (signal.aborted) return { status: 'STOP' };
        const img = got.file || got.raw;
        const text = img ? pictureMetadata(fs.readFileSync(img)) : null;
        if (text) {
          fs.writeFileSync(metaFile, text);
          metaIdx = 1;
          if (got.file) artFile = got.file;
        }
      } catch { metaIdx = -1; /* never fail the conversion because of art */ }
    }
    if (artFile && metaIdx < 0) args.push('-i', artFile);
    if (metaIdx > 0) args.push('-i', metaFile);
    args.push('-map', '0:a:0');
    if (coverOk) args.push('-map', artFile ? '1:v:0' : '0:v?');
    args.push('-map_metadata', tagMode === 'keep' ? '0' : '-1');
    if (metaIdx > 0) args.push('-map_metadata', String(metaIdx));
    if (copy) {
      args.push('-c', 'copy');
      if (coverOk) args.push('-disposition:v', 'attached_pic');
    } else {
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

    const r = await run(tools.ffmpeg, args, { signal });
    if (r.aborted || signal.aborted) return { status: 'STOP' };
    if (r.code !== 0 || !fs.existsSync(part)) {
      const lines = r.stderr.trim().split(/\r?\n/);
      return { status: 'FAIL', name: baseName, note: lines[lines.length - 1] || 'conversion failed' };
    }
    if (!placeNoOverwrite(part, dest)) return { status: 'SKIP', name: outName, note: 'already exists' };
    if (settings.KeepDates !== false) keepDates(file, dest);
    let note = dupNote + (copy ? 'copied (no re-encode)' : fmt.lossy ? `${kbps}k` : fmt.depth ? `${depth}-bit` : 'lossless');
    if (artFile) note += ' | cover art resized';
    if (quality && quality.msg) note += ` | ${quality.msg}`;
    if (twin) note += ` | possible duplicate of ${twin}`;
    if (clipMsg) note += ` | ${clipMsg}`;
    if (healthMsg) note += ` | ${healthMsg}`;
    // Player check: flagged only, from what was actually written (the source rate when it was copied or kept).
    let playerMsg = '';
    if (settings.PlayerModel && settings.PlayerModel !== 'off') {
      const srcRate = Number(audio.sample_rate) || null;
      const rate = fmt.depth || copy ? srcRate : fmt === FORMATS.opus ? 48000 : settings.SampleRate; // Opus is always written at 48 kHz
      playerMsg = playerNote(settings.PlayerModel, { format: settings.Format in FORMATS ? settings.Format : 'mp3', rate, depth: fmt.depth ? depth : null });
      if (playerMsg) note += ` | ${playerMsg}`;
    }
    if (key) seen.add(key, length, outName, outDir);
    return { status: quality && quality.low ? 'WARN' : 'OK', name: outName, note, clipped: Boolean(clipMsg), duplicate: Boolean(twin), health: Boolean(healthMsg), player: Boolean(playerMsg), ...(peakDb !== null ? { peakDb } : {}) };
  } catch (err) {
    return { status: 'FAIL', name: baseName, note: err.message };
  } finally {
    try { fs.rmSync(part, { force: true }); } catch { /* leave it */ }
    try { fs.rmSync(metaFile, { force: true }); } catch { /* leave it */ }
    artCleanup();
  }
}

module.exports = { convertOne, probe, placeNoOverwrite };
