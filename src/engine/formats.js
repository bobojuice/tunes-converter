'use strict';
// Output formats. `encoder` is the ffmpeg encoder name, `muxer` the container used for the temporary file.
const FORMATS = {
  mp3: { label: 'MP3', ext: '.mp3', encoder: 'libmp3lame', muxer: 'mp3', lossy: true },
  m4a: { label: 'AAC (M4A)', ext: '.m4a', encoder: 'aac', muxer: 'ipod', lossy: true },
  flac: { label: 'FLAC (lossless)', ext: '.flac', encoder: 'flac', muxer: 'flac', lossy: false, depth: true },
  wav: { label: 'WAV (uncompressed)', ext: '.wav', encoder: 'pcm_s16le', muxer: 'wav', lossy: false, depth: true, noCover: true },
  aiff: { label: 'AIFF (uncompressed)', ext: '.aiff', encoder: 'pcm_s16be', muxer: 'aiff', lossy: false, depth: true },
  opus: { label: 'Opus', ext: '.opus', encoder: 'libopus', muxer: 'opus', lossy: true, maxKbps: 256 }
};
const FORMAT_KEYS = Object.keys(FORMATS);

module.exports = { FORMATS, FORMAT_KEYS };
