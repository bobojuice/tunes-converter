'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { run } = require('./proc');

// Decodes (a bounded slice of) the file to float32 and returns where its audio stops.
//   { status: 'ok', cutoff, clamped } | { status: 'short' } | { status: 'failed' } | { status: 'cancelled' }
async function measureCutoff({ ffmpeg, file, sampleRate, duration, channels, signal }) {
  // Always bound the decode (even if the reported length is wrong): a 3-minute slice from the middle of long
  // tracks, otherwise at most the first 4 minutes.
  const limit = duration > 240 ? ['-ss', Math.max(0, duration / 2 - 90).toFixed(1), '-t', '180'] : ['-t', '240'];
  const ch = Math.max(1, Math.min(channels || 2, 2));
  const rate = Math.min(sampleRate, 48000);
  const args = [
    '-v', 'error', ...limit, '-i', file, '-map', '0:a:0', '-vn', '-ac', String(ch),
    ...(sampleRate > 48000 ? ['-ar', '48000'] : []), '-f', 'f32le', '-'
  ];
  const maxBytes = 240 * 48000 * 2 * 4 + 1024 * 1024;
  const r = await run(ffmpeg, args, { signal, binary: true, maxBytes });
  if (r.aborted) return { status: 'cancelled' };
  if (r.code !== 0 || r.truncated || r.stdout.length === 0) return { status: 'failed' };

  // Copy into an aligned ArrayBuffer and analyse off the main thread.
  const ab = new ArrayBuffer(r.stdout.length - (r.stdout.length % 4));
  new Uint8Array(ab).set(r.stdout.subarray(0, ab.byteLength));
  const result = await new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'specWorker.js'), { workerData: { buffer: ab, sampleRate: rate, channels: ch } });
    const onAbort = () => { worker.terminate(); resolve({ cancelled: true }); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (m) => { if (signal) signal.removeEventListener('abort', onAbort); resolve(m); });
    worker.once('error', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve({ failed: true }); });
  });
  if (result.cancelled) return { status: 'cancelled' };
  if (result.failed) return { status: 'failed' };
  if (result.cutoff < 0) return { status: 'short' };
  return { status: 'ok', cutoff: result.cutoff, clamped: result.clamped };
}

function estimateKbps(cutoffHz) {
  if (cutoffHz >= 19950) return 320;
  if (cutoffHz >= 19250) return 256;
  if (cutoffHz >= 18250) return 192;
  if (cutoffHz >= 17200) return 160;
  return 128;
}

const LABELS = { 320: '320k or better', 256: '~224-256k', 192: '~192k', 160: '~160k', 128: '~128k or lower' };
const LOSSLESS = /^(flac|alac|pcm_|wavpack|ape|tta)/;

// -> { cancelled } | { low: false, msg } | { low: true, kind: 'FAKE' | 'LOW', msg }
async function testQuality({ ffmpeg, file, audio, format, minKbps, signal }) {
  const none = { low: false, msg: '' };
  const sr = Number(audio.sample_rate) || 0;
  if (sr < 44100) return none;
  const m = await measureCutoff({
    ffmpeg, file, sampleRate: sr, duration: Number(format && format.duration) || 0, channels: Number(audio.channels) || 2, signal
  });
  if (m.status === 'cancelled') return { cancelled: true };
  if (m.status === 'failed') return { low: false, msg: 'quality not checked (could not decode the audio)' };
  if (m.status === 'short') return { low: false, msg: 'quality not checked (too short or quiet)' };

  const cut = m.cutoff;
  const est = estimateKbps(cut);
  const label = LABELS[est];
  const khz = (cut / 1000).toFixed(1);
  const lossless = LOSSLESS.test(audio.codec_name || '');
  const claimedK = audio.bit_rate ? Number(audio.bit_rate) / 1000 : 0;
  const claim = lossless ? 'claims lossless' : claimedK ? `says ${Math.round(claimedK)}k` : '';

  if (est < minKbps) {
    if (m.clamped) return { low: false, msg: 'quality not checked (track too quiet for a reliable verdict)' };
    // Fake = the file claims more than its spectrum supports; otherwise it is honest but below your minimum.
    if (lossless || claimedK > est * 1.15) {
      const lead = claim ? `${claim} but ` : '';
      return { low: true, kind: 'FAKE', msg: `fakin' the funk: ${lead}looks like ${label} (cutoff ${khz} kHz)` };
    }
    return { low: true, kind: 'LOW', msg: `below your ${minKbps}k minimum: looks like ${label} (cutoff ${khz} kHz)` };
  }
  let msg = `source ok: ${label} (cutoff ${khz} kHz)`;
  if (lossless && cut < 20800) msg += ', but a lossless file this band-limited was probably made from a lossy one';
  return { low: false, msg };
}

module.exports = { measureCutoff, estimateKbps, testQuality };
