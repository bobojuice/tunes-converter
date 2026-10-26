'use strict';
const fs = require('fs');
const path = require('path');
const { FORMAT_KEYS } = require('./formats');
const { DEFAULT_TEMPLATE, validTemplate } = require('./naming');

const TAG_MODES = ['keep', 'clean', 'strip']; // keep everything | keep the main fields only | no tags at all

const BITRATES = [128, 160, 192, 224, 256, 320];
const SAMPLE_RATES = [44100, 48000];
const MODES = ['off', 'warn', 'skip'];

function defaults(desktopDir) {
  return {
    In: path.join(desktopDir, 'NewTunes'),
    Out: path.join(desktopDir, 'converted'),
    Bitrate: 320,
    SampleRate: 44100,
    QualityCheck: 'warn',
    MinKbps: 320,
    Format: 'mp3',
    BitDepth: 16,
    NameTemplate: DEFAULT_TEMPLATE,
    TagMode: 'keep',
    Recurse: false,
    CoverArt: true,
    JoinArtists: true,
    OpenWhenDone: false,
    WinW: 820,
    WinH: 840,
    FfmpegDir: ''
  };
}

// Each key is validated on its own, so one bad value never discards the valid ones.
function merge(base, raw) {
  const s = { ...base };
  if (!raw || typeof raw !== 'object') return s;
  if (typeof raw.In === 'string' && raw.In.trim()) s.In = raw.In;
  if (typeof raw.Out === 'string' && raw.Out.trim()) s.Out = raw.Out;
  if (BITRATES.includes(Number(raw.Bitrate))) s.Bitrate = Number(raw.Bitrate);
  if (SAMPLE_RATES.includes(Number(raw.SampleRate))) s.SampleRate = Number(raw.SampleRate);
  if (MODES.includes(raw.QualityCheck)) s.QualityCheck = raw.QualityCheck;
  if (BITRATES.includes(Number(raw.MinKbps))) s.MinKbps = Number(raw.MinKbps);
  if (FORMAT_KEYS.includes(raw.Format)) s.Format = raw.Format;
  if ([16, 24].includes(Number(raw.BitDepth))) s.BitDepth = Number(raw.BitDepth);
  if (TAG_MODES.includes(raw.TagMode)) s.TagMode = raw.TagMode;
  if (validTemplate(raw.NameTemplate)) s.NameTemplate = raw.NameTemplate.trim();
  for (const k of ['Recurse', 'CoverArt', 'JoinArtists', 'OpenWhenDone']) {
    if (typeof raw[k] === 'boolean') s[k] = raw[k];
  }
  for (const k of ['WinW', 'WinH']) {
    const n = Number(raw[k]);
    if (Number.isInteger(n) && n >= 400 && n <= 10000) s[k] = n;
  }
  if (typeof raw.FfmpegDir === 'string') s.FfmpegDir = raw.FfmpegDir;
  return s;
}

function load(file, base) {
  try {
    return merge(base, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...base };
  }
}

function save(file, base, changes) {
  const next = merge(load(file, base), changes);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return next;
}

module.exports = { TAG_MODES, BITRATES, SAMPLE_RATES, MODES, defaults, merge, load, save };
