'use strict';
const { run } = require('./proc');

const MONO_DB = -80; // a left/right difference quieter than this means both channels are the same
const DURATION_SLACK = 2; // seconds the decoded length may differ from the stated length

// Last value of a key printed by ametadata (stdout).
function lastValue(stdout, key) {
  const re = new RegExp(`${key.replace(/\./g, '\\.')}=(-?inf|-?[\\d.]+)`, 'g');
  let m;
  let v = null;
  while ((m = re.exec(stdout))) v = m[1];
  return v === null ? null : Number(v.replace(/^(-?)inf$/, '$1Infinity'));
}

// One decode pass over the whole file. It only reports, nothing is changed.
// -> { cancelled } | { flags: string[], msg } (msg '' when nothing is wrong)
async function checkHealth({ ffmpeg, file, audio, format, signal }) {
  const stereo = Number(audio.channels) === 2;
  const chain = (stereo ? 'pan=mono|c0=c0-c1,' : '') + 'astats=metadata=1:reset=0,'
    + 'ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-,'
    + 'ametadata=print:key=lavfi.astats.Overall.Number_of_samples:file=-';
  const r = await run(ffmpeg, ['-v', 'error', '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-af', chain, '-f', 'null', '-'], { signal });
  if (r.aborted) return { cancelled: true };
  const flags = [];
  const rate = Number(audio.sample_rate) || 0;
  if (rate && rate < 44100) flags.push(`low sample rate ${rate} Hz`);

  let corrupt = r.code !== 0 || r.stderr.trim() !== '';
  if (!corrupt && rate) {
    const samples = lastValue(r.stdout, 'lavfi.astats.Overall.Number_of_samples');
    const stated = Number(format && format.duration) || 0;
    if (samples !== null && stated && Math.abs(samples / rate - stated) > DURATION_SLACK) corrupt = true;
  }
  if (corrupt) flags.push('corrupt or truncated');
  else if (stereo) {
    const diff = lastValue(r.stdout, 'lavfi.astats.Overall.Peak_level');
    if (diff !== null && diff < MONO_DB) flags.push('mono as stereo');
  }
  return { flags, msg: flags.join(', ') };
}

module.exports = { checkHealth };
