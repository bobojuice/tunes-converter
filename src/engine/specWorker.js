'use strict';
// Runs in a worker thread: finds the highest frequency that still carries real signal in raw float32 audio.
// Calibrated against LAME encodes of a lossless track (cutoff by bitrate): 128k ~16.8 kHz, 160k ~17.6,
// 192k ~18.9, 224k/256k ~19.6, 320k ~20.3 kHz, lossless ~22 kHz. It is an estimate, not proof.
const { parentPort, workerData } = require('worker_threads');

const N = 4096;
const BINS = N / 2 + 1;

function makeFft(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = -Math.sin((2 * Math.PI * k) / n);
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const u = i + k;
          const v = u + half;
          const wr = cos[t];
          const wi = sin[t];
          const tr = re[v] * wr - im[v] * wi;
          const ti = re[v] * wi + im[v] * wr;
          re[v] = re[u] - tr; im[v] = im[u] - ti;
          re[u] += tr; im[u] += ti;
        }
      }
    }
  };
}

// raw = interleaved float32 samples. Each channel is analysed on its own and the loudest result per frequency
// is kept, so opposite-phase stereo cannot hide anything. The threshold is relative to the track's own level.
// Returns { cutoff, clamped }; cutoff is -1 when there is not enough audio.
function analyse(raw, sampleRate, channels) {
  const total = Math.floor(raw.length / channels);
  if (total < N * 12) return { cutoff: -1, clamped: false };

  const fft = makeFft(N);
  const win = new Float64Array(N);
  let winSum = 0;
  for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); winSum += win[i]; }
  const norm = winSum / 2;

  const lo = Math.floor(total * 0.03);
  const hi = Math.floor(total * 0.97) - N;
  const maxFrames = 240;
  const step = Math.max(N / 2, Math.floor((hi - lo) / maxFrames));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const frames = [];

  for (let pos = lo; pos <= hi && frames.length < maxFrames; pos += step) {
    let loud = 0;
    for (let c = 0; c < channels; c++) {
      let e = 0;
      for (let i = 0; i < N; i++) { const s = raw[(pos + i) * channels + c]; e += s * s; }
      loud = Math.max(loud, Math.sqrt(e / N));
    }
    if (loud < 0.005) continue;
    const lv = new Float32Array(BINS).fill(-300);
    for (let c = 0; c < channels; c++) {
      for (let i = 0; i < N; i++) { re[i] = raw[(pos + i) * channels + c] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < BINS; b++) {
        const db = 20 * Math.log10(Math.hypot(re[b], im[b]) / norm + 1e-12);
        if (db > lv[b]) lv[b] = db;
      }
    }
    frames.push(lv);
  }
  if (frames.length < 8) return { cutoff: -1, clamped: false };

  // 90th percentile per bin, then a +-12 bin moving average.
  const p = new Float32Array(BINS);
  const col = new Float32Array(frames.length);
  const idx = Math.floor(0.9 * (frames.length - 1));
  for (let b = 0; b < BINS; b++) {
    for (let f = 0; f < frames.length; f++) col[f] = frames[f][b];
    col.sort();
    p[b] = col[idx];
  }
  const sm = new Float32Array(BINS);
  const w = 12;
  for (let b = 0; b < BINS; b++) {
    const a = Math.max(0, b - w);
    const c2 = Math.min(BINS - 1, b + w);
    let sum = 0;
    for (let k = a; k <= c2; k++) sum += p[k];
    sm[b] = sum / (c2 - a + 1);
  }

  // Reference level = the track's own mid-band level (1-8 kHz); signal must stay within 60 dB of it. Never go
  // below -118 dB (close to the decoder's noise floor); on a very quiet track that makes the test stricter than
  // intended, so a LOW result there is not trustworthy (a high result still is).
  const r0 = Math.floor((1000 * N) / sampleRate);
  const r1 = Math.min(BINS - 1, Math.floor((8000 * N) / sampleRate));
  let refSum = 0;
  for (let b = r0; b <= r1; b++) refSum += sm[b];
  const reference = refSum / (r1 - r0 + 1);
  const wanted = reference - 60;
  const clamped = wanted < -118;
  const threshold = Math.min(-90, Math.max(-118, wanted));
  for (let b = BINS - 1; b > 0; b--) {
    if (sm[b] > threshold) return { cutoff: (b * sampleRate) / N, clamped };
  }
  return { cutoff: 0, clamped };
}

if (parentPort && workerData) {
  const { buffer, sampleRate, channels } = workerData;
  const raw = new Float32Array(buffer, 0, Math.floor(buffer.byteLength / 4 / channels) * channels);
  parentPort.postMessage(analyse(raw, sampleRate, channels));
}

module.exports = { analyse };
