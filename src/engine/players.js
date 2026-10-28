'use strict';
// Pioneer CDJ/XDJ compatibility data, from each model's manual as collected in the device compatibility reference.
// The app only CHECKS and FLAGS with this; it never changes audio, tags or output because of a player model.
// A flag means "not in the model's published list", not "will not play". Where the reference marks a value as
// unknown (null) nothing is flagged for it.
//
// `formats`: our output format keys the model lists as supported. Each has `rates` (the exact sample rates in Hz the
// model lists; null = not confirmed), `depths` (the bit depths it lists; null = lossy, or not confirmed) and, for MP3,
// `minKbps`/`maxKbps`. Rates are exact sets: 32 kHz is not in a 44.1/48 kHz list even though it is lower.
// MP3 and AAC lists are the union of the profiles a model lists (MPEG-1 and MPEG-2 for MP3).
// `fs`: USB file systems the model lists (null = unknown).
// `confirmed`: 'manual' = checked against the model's manual, 'spec' = partial or aggregate sources only.
// Opus and OGG are listed by no model. ALAC is not an output format here.

const R_44_48 = [44100, 48000];
const R_HI = [44100, 48000, 88200, 96000];
const R_LOSSY_NEW = [32000, 44100, 48000]; // MPEG-1 MP3 / AAC-LC on the models without the low-rate profiles
const R_LOSSY_OLD = [16000, 22050, 24000, 32000, 44100, 48000]; // plus MPEG-2 MP3 (16/22.05/24) on the older players
const PCM = (rates) => ({ rates, depths: [16, 24] });
const MP3 = (rates) => ({ rates, depths: null, minKbps: 32, maxKbps: 320 });
const AAC = (rates) => ({ rates, depths: null });

const PLAYERS = {
  cdj2000: {
    label: 'CDJ-2000 (original)', short: 'CDJ-2000', confirmed: 'manual',
    formats: { mp3: MP3(R_LOSSY_OLD), m4a: AAC(R_LOSSY_OLD), wav: PCM(R_44_48), aiff: PCM(R_44_48) }, fs: null
  },
  cdj850: {
    label: 'CDJ-850', short: 'CDJ-850', confirmed: 'manual',
    formats: { mp3: MP3(R_LOSSY_NEW), m4a: AAC(R_LOSSY_NEW), wav: PCM(R_44_48), aiff: PCM(R_44_48) }, fs: null
  },
  cdj900nxs: {
    label: 'CDJ-900NXS', short: 'CDJ-900NXS', confirmed: 'manual',
    formats: { mp3: MP3(R_LOSSY_OLD), m4a: AAC(R_LOSSY_OLD), wav: PCM(R_44_48), aiff: PCM(R_44_48) }, fs: ['FAT16', 'FAT32', 'HFS+']
  },
  cdj2000nxs: {
    label: 'CDJ-2000NXS', short: 'CDJ-2000NXS', confirmed: 'manual',
    formats: { mp3: MP3(R_LOSSY_OLD), m4a: AAC(R_LOSSY_OLD), wav: PCM(R_44_48), aiff: PCM(R_44_48) }, fs: ['FAT16', 'FAT32', 'HFS+']
  },
  cdj2000nxs2: {
    // USB/SD only: discs list just 44.1/48 kHz WAV/AIFF and no FLAC.
    label: 'CDJ-2000NXS2', short: 'CDJ-2000NXS2', confirmed: 'manual',
    formats: { mp3: MP3(R_LOSSY_OLD), m4a: AAC(R_LOSSY_OLD), wav: PCM(R_HI), aiff: PCM(R_HI), flac: PCM(R_HI) }, fs: ['FAT16', 'FAT32', 'HFS+']
  },
  cdj3000: {
    // The USB file systems are reported inconsistently (exFAT in some sources), so they are left unknown.
    label: 'CDJ-3000', short: 'CDJ-3000', confirmed: 'manual',
    formats: { mp3: MP3(R_44_48), m4a: AAC(R_44_48), wav: PCM(R_HI), aiff: PCM(R_HI), flac: PCM(R_HI) }, fs: null
  },
  cdjtour1: {
    // Only the manufacturer's aggregate matrix is known: lossless rates are listed, but bit depths and any extra
    // lossy rates are unconfirmed, so those are never flagged.
    label: 'CDJ-TOUR1', short: 'CDJ-TOUR1', confirmed: 'spec',
    formats: { mp3: { rates: null, depths: null, minKbps: 32, maxKbps: 320 }, m4a: { rates: null, depths: null },
      wav: { rates: R_HI, depths: null }, aiff: { rates: R_HI, depths: null }, flac: { rates: R_HI, depths: null } },
    fs: ['FAT', 'FAT32', 'HFS+']
  },
  xdj1000mk2: {
    label: 'XDJ-1000MK2', short: 'XDJ-1000MK2', confirmed: 'manual',
    formats: { mp3: MP3(R_LOSSY_OLD), m4a: AAC(R_LOSSY_OLD), wav: PCM(R_44_48), aiff: PCM(R_44_48), flac: PCM(R_44_48) }, fs: ['FAT', 'FAT32', 'HFS+']
  },
  xdjxz: {
    // FLAC needs firmware 1.10 or newer.
    label: 'XDJ-XZ', short: 'XDJ-XZ', confirmed: 'manual',
    formats: { mp3: MP3(R_LOSSY_NEW), m4a: AAC(R_LOSSY_NEW), wav: PCM(R_44_48), aiff: PCM(R_44_48), flac: PCM(R_44_48) }, fs: null
  },
  xdjrx3: {
    label: 'XDJ-RX3', short: 'XDJ-RX3', confirmed: 'manual',
    formats: { mp3: MP3(R_LOSSY_NEW), m4a: AAC(R_LOSSY_NEW), wav: PCM(R_44_48), aiff: PCM(R_44_48), flac: PCM(R_44_48) }, fs: ['FAT16', 'FAT32', 'exFAT', 'HFS+']
  }
};const PLAYER_KEYS = Object.keys(PLAYERS);

const FORMAT_NAME = { mp3: 'MP3', m4a: 'AAC', flac: 'FLAC', wav: 'WAV', aiff: 'AIFF', opus: 'Opus' };
const khzNum = (hz) => Number((hz / 1000).toFixed(2));
const khz = (hz) => `${khzNum(hz)} kHz`;

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
  if (rate && f.rates && !f.rates.includes(Math.round(rate))) out.push(`${khz(rate)} not in its list of supported rates (${f.rates.map(khzNum).join(', ')} kHz)`);
  if (depth && f.depths && !f.depths.includes(depth)) out.push(`${depth}-bit not supported`);
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
