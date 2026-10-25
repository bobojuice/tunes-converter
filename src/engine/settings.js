'use strict';
const fs = require('fs');
const path = require('path');

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

module.exports = { BITRATES, SAMPLE_RATES, MODES, defaults, merge, load, save };
