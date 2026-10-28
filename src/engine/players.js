'use strict';
// Pioneer CDJ/XDJ compatibility data, from Pioneer's published specs. The app only CHECKS and FLAGS with this;
// it never changes audio, tags or output because of a player model. Where a value is not confirmed, the safe
// (lower) published value is used, so a flag means "not listed as supported", not "will not play".
//
// `formats`: our output format keys the model lists as supported, each with the highest sample rate (Hz) and bit depth
// (null = not applicable, lossy). MP3 tops out at 320 kbps. `fs`: USB file systems the model lists (null = unknown).
// `confirmed`: 'manual' = checked against the model's manual, 'spec' = Pioneer spec page / retailer / community only.
// Opus and OGG are listed by no model. ALAC is not an output format here.

const MP3 = { rate: 48000, depth: null, maxKbps: 320 };
const AAC = { rate: 48000, depth: null };
const PCM_48 = { rate: 48000, depth: 24 };
const PCM_96 = { rate: 96000, depth: 24 };

const PLAYERS = {
  cdj2000: {
    label: 'CDJ-2000 (original)', short: 'CDJ-2000', confirmed: 'spec',
    formats: { mp3: MP3, m4a: AAC, wav: PCM_48, aiff: PCM_48 }, fs: null
  },
  cdj850: {
    // WAV/AIFF limits are not in the published values we have: the safest (16-bit, 48 kHz) is used.
    label: 'CDJ-850', short: 'CDJ-850', confirmed: 'spec',
    formats: { mp3: MP3, m4a: AAC, wav: { rate: 48000, depth: 16 }, aiff: { rate: 48000, depth: 16 } }, fs: null
  },
  cdj900nxs: {
    label: 'CDJ-900NXS', short: 'CDJ-900NXS', confirmed: 'spec',
    formats: { mp3: MP3, m4a: AAC, wav: PCM_48, aiff: PCM_48 }, fs: ['FAT16', 'FAT32', 'HFS+']
  },
  cdj2000nxs: {
    label: 'CDJ-2000NXS', short: 'CDJ-2000NXS', confirmed: 'manual',
    formats: { mp3: MP3, m4a: AAC, wav: PCM_48, aiff: PCM_48 }, fs: ['FAT16', 'FAT32', 'HFS+']
  },
  cdj2000nxs2: {
    label: 'CDJ-2000NXS2', short: 'CDJ-2000NXS2', confirmed: 'manual',
    formats: { mp3: MP3, m4a: AAC, wav: PCM_96, aiff: PCM_96, flac: PCM_96 }, fs: ['FAT16', 'FAT32', 'HFS+']
  },
  cdj3000: {
    // The USB file systems are reported inconsistently (exFAT in some sources), so they are left unknown.
    label: 'CDJ-3000', short: 'CDJ-3000', confirmed: 'spec',
    formats: { mp3: MP3, m4a: { rate: 48000, depth: null }, wav: PCM_96, aiff: PCM_96, flac: PCM_96 }, fs: null
  },
  cdjtour1: {
    label: 'CDJ-TOUR1', short: 'CDJ-TOUR1', confirmed: 'spec',
    formats: { mp3: MP3, m4a: AAC, wav: PCM_96, aiff: PCM_96, flac: PCM_96 }, fs: ['FAT', 'FAT32', 'HFS+']
  },
  xdj1000mk2: {
    label: 'XDJ-1000MK2', short: 'XDJ-1000MK2', confirmed: 'spec',
    formats: { mp3: MP3, m4a: AAC, wav: PCM_48, aiff: PCM_48, flac: PCM_48 }, fs: ['FAT', 'FAT32', 'HFS+']
  },
  xdjxz: {
    // FLAC needs firmware 1.10 or newer.
    label: 'XDJ-XZ', short: 'XDJ-XZ', confirmed: 'manual',
    formats: { mp3: MP3, m4a: AAC, wav: PCM_48, aiff: PCM_48, flac: PCM_48 }, fs: null
  },
  xdjrx3: {
    label: 'XDJ-RX3', short: 'XDJ-RX3', confirmed: 'spec',
    formats: { mp3: MP3, m4a: AAC, wav: PCM_48, aiff: PCM_48, flac: PCM_48 }, fs: ['FAT16', 'FAT32', 'exFAT', 'HFS+']
  }
};
const PLAYER_KEYS = Object.keys(PLAYERS);

const FORMAT_NAME = { mp3: 'MP3', m4a: 'AAC', flac: 'FLAC', wav: 'WAV', aiff: 'AIFF', opus: 'Opus' };
const khz = (hz) => `${Number((hz / 1000).toFixed(1))} kHz`;

// Does the model list this output format at all?
function supportsFormat(model, format) {
  const p = PLAYERS[model];
  return Boolean(p && p.formats[format]);
}

// Problems for one output file: { format: 'mp3'|..., rate: Hz|null, depth: 16|24|null }. Returns a list of short phrases
// (empty when nothing is flagged or the model is off/unknown). A wrong format is the only phrase given for that file.
function playerIssues(model, { format, rate = null, depth = null }) {
  const p = PLAYERS[model];
  if (!p) return [];
  const name = FORMAT_NAME[format] || String(format);
  const f = p.formats[format];
  if (!f) return [`${name} not supported`];
  const out = [];
  if (rate && f.rate && rate > f.rate) out.push(`${khz(rate)} above the ${khz(f.rate)} limit`);
  if (depth && f.depth && depth > f.depth) out.push(`${depth}-bit not supported`);
  return out;
}

// The note added to a converted file, '' when nothing is flagged.
function playerNote(model, file) {
  const issues = playerIssues(model, file);
  return issues.length ? `${PLAYERS[model].short}: ${issues.join(', ')}` : '';
}

// Informational text for the start of a run: one line per output format the model does not list.
// (The USB file system is not detected, the menu shows the tip as static text.)
function playerPreflight(model, formats) {
  const p = PLAYERS[model];
  if (!p) return [];
  return [...new Set(formats)].filter((f) => !p.formats[f])
    .map((f) => `${p.label} does not list ${FORMAT_NAME[f] || f} as supported. Files will still be converted.`);
}

module.exports = { PLAYERS, PLAYER_KEYS, supportsFormat, playerIssues, playerNote, playerPreflight };
