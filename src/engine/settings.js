'use strict';
const fs = require('fs');
const path = require('path');
const { FORMAT_KEYS } = require('./formats');
const { PLAYER_KEYS } = require('./players');
const { DEFAULT_TEMPLATE, validTemplate, validFolderTemplate } = require('./naming');

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
    FolderTemplate: '',
    SecondOut: '',
    SecondFormat: 'off',
    TagMode: 'keep',
    Recurse: false,
    CoverArt: true,
    JoinArtists: true,
    ClipCheck: false,
    DuplicateMode: 'warn',
    CopyMode: true,
    HealthCheck: true,
    ArtResize: true,
    KeepDates: true,
    SaveReport: false,
    WatchFolder: false,
    PlayerModel: 'off',
    Presets: [],
    OpenWhenDone: false,
    WinW: 820,
    WinH: 1000,
    FfmpegDir: ''
  };
}

// A preset remembers the conversion options only, never folders, window size or the ffmpeg location.
const PRESET_KEYS = ['Format', 'Bitrate', 'SampleRate', 'QualityCheck', 'MinKbps', 'BitDepth', 'NameTemplate', 'FolderTemplate', 'TagMode',
  'Recurse', 'CoverArt', 'JoinArtists', 'ClipCheck', 'DuplicateMode', 'CopyMode', 'HealthCheck', 'ArtResize', 'KeepDates', 'PlayerModel'];
const MAX_PRESETS = 20;
const MAX_PRESET_NAME = 40;

// Every entry is checked field by field; bad entries are dropped, names are unique (ignoring case), at most MAX_PRESETS.
function cleanPresets(list) {
  const out = [];
  const names = new Set();
  for (const p of list) {
    if (out.length >= MAX_PRESETS) break;
    if (!p || typeof p !== 'object' || typeof p.name !== 'string') continue;
    const name = p.name.trim();
    if (!name || name.length > MAX_PRESET_NAME || /[\u0000-\u001f]/.test(name) || names.has(name.toLowerCase())) continue;
    if (!p.options || typeof p.options !== 'object') continue;
    const checked = merge({}, p.options); // merge() only copies valid values
    const options = {};
    for (const k of PRESET_KEYS) if (checked[k] !== undefined) options[k] = checked[k];
    names.add(name.toLowerCase());
    out.push({ name, options });
  }
  return out;
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
  if (typeof raw.FolderTemplate === 'string') {
    const t = raw.FolderTemplate.trim();
    if (!t) s.FolderTemplate = ''; // empty = off; an invalid template is ignored
    else if (validFolderTemplate(t)) s.FolderTemplate = t;
  }
  if (typeof raw.SecondOut === 'string' && raw.SecondOut.length <= 1024 && !raw.SecondOut.includes('\0')) s.SecondOut = raw.SecondOut.trim();
  if (raw.SecondFormat === 'off' || FORMAT_KEYS.includes(raw.SecondFormat)) s.SecondFormat = raw.SecondFormat;
  if (MODES.includes(raw.DuplicateMode)) s.DuplicateMode = raw.DuplicateMode;
  if (raw.PlayerModel === 'off' || PLAYER_KEYS.includes(raw.PlayerModel)) s.PlayerModel = raw.PlayerModel;
  for (const k of ['Recurse', 'CoverArt', 'JoinArtists', 'ClipCheck', 'OpenWhenDone', 'CopyMode', 'HealthCheck', 'ArtResize', 'KeepDates', 'SaveReport', 'WatchFolder']) {
    if (typeof raw[k] === 'boolean') s[k] = raw[k];
  }
  if (Array.isArray(raw.Presets)) s.Presets = cleanPresets(raw.Presets);
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

module.exports = { PRESET_KEYS, MAX_PRESETS, MAX_PRESET_NAME, cleanPresets, TAG_MODES, BITRATES, SAMPLE_RATES, MODES, defaults, merge, load, save };
