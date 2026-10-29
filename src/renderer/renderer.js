'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const BITRATES = [128, 160, 192, 224, 256, 320];
  const MODES = ['off', 'warn', 'skip'];
  const FORMATS = { mp3: 'MP3', m4a: 'AAC (M4A)', flac: 'FLAC', wav: 'WAV', aiff: 'AIFF', opus: 'Opus' };
  const LOSSLESS = ['flac', 'wav', 'aiff'];
  const PRESET_KEYS = ['Format', 'Bitrate', 'SampleRate', 'QualityCheck', 'MinKbps', 'BitDepth', 'NameTemplate', 'FolderTemplate', 'TagMode', 'Recurse', 'CoverArt', 'JoinArtists', 'ClipCheck', 'DuplicateMode', 'CopyMode', 'HealthCheck', 'ArtResize', 'KeepDates', 'PlayerModel'];
  const SHORT = { mp3: 'MP3', m4a: 'AAC', flac: 'FLAC', wav: 'WAV', aiff: 'AIFF', opus: 'OPUS' };
  const MODE_LABEL = { off: 'OFF', warn: 'WARN', skip: 'SKIP' };
  const MODE_TIP = {
    off: 'Quality check: off (fastest). Click to change.',
    warn: 'Quality check: convert everything but flag low-quality files. Click to change.',
    skip: 'Quality check: do not convert files below the minimum. Click to change.'
  };
  const COL = { blue: '#2EA7FF', dim: '#1C6FA8', orange: '#FF8A1F', red: '#FF5C7A', pink: '#FF7AD9', teal: '#37D6B0', violet: '#B48CFF' };
  const HELP_URL = 'https://github.com/bobojuice/tunes-converter/blob/main/docs/HOWTO.md';

  let state = null;
  let running = false;
  let downloading = false;
  let droppedCount = 0;
  let runStart = 0;
  let ranOnce = false;
  let phase = 'idle'; // idle | running | done | stopped | failed
  let progIndex = 0;
  let progTotal = 0;
  let resultCount = 0;
  let flags = [];
  let lastPeak = null;
  let etaSecs = null;

  const settings = () => state.settings;
  const watching = () => Boolean(state.settings.WatchFolder && state.watch && state.watch.active);

  async function save(changes) {
    const next = await window.tc.updateSettings(changes);
    if (next) state.settings = next;
    render();
  }

  function render() {
    const s = settings();
    for (const el of document.querySelectorAll('#panel [data-key]')) {
      const v = s[el.dataset.key];
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = String(v);
    }
    const preset = Array.from($('setName').options).find((o) => o.value === s.NameTemplate);
    $('setName').value = preset ? preset.value : 'custom';
    const folder = Array.from($('setFolder').options).find((o) => o.value === s.FolderTemplate);
    $('setFolder').value = folder ? folder.value : 'custom';
    renderPresets();
    // WATCHING only while the watch is really running; if it is switched on but cannot run, say why
    const ws = $('watchState');
    ws.hidden = !s.WatchFolder;
    ws.textContent = watching() ? 'WATCHING' : `NOT WATCHING: ${(state.watch && state.watch.reason) || 'folders not ready'}`;
    ws.classList.toggle('off', !watching());
    for (const el of document.querySelectorAll('#panel [data-show]')) {
      const kind = el.dataset.show;
      el.hidden = kind === 'depth' ? !LOSSLESS.includes(s.Format)
        : kind === 'lossy' ? LOSSLESS.includes(s.Format)
          : kind === 'fcustom' ? $('setFolder').value !== 'custom'
            : kind === 'second' ? s.SecondFormat === 'off'
              : $('setName').value !== 'custom';
    }
    renderControls();
    renderReadouts();
    renderMeter();
    syncPlayable();
    renderSpin();
    drawAll();
  }

  function bitrateList(fmt) { return fmt === 'opus' ? BITRATES.filter((b) => b <= 256) : BITRATES; }
  function shownBitrate(s) { return s.Format === 'opus' ? Math.min(s.Bitrate, 256) : s.Bitrate; }

  function renderControls() {
    const s = settings();
    for (const pad of document.querySelectorAll('#pads .pad')) pad.setAttribute('aria-pressed', String(pad.dataset.fmt === s.Format));
    for (const opt of document.querySelectorAll('.opt')) {
      const on = Boolean(s[opt.dataset.opt]);
      opt.setAttribute('aria-pressed', String(on));
    }
    $('roQualityV').textContent = MODE_LABEL[s.QualityCheck];
    $('roQuality').title = MODE_TIP[s.QualityCheck];
    $('roQuality').setAttribute('aria-label', MODE_TIP[s.QualityCheck]);
    // knob: bit depth for lossless formats, bitrate for lossy ones
    const lossless = LOSSLESS.includes(s.Format);
    const values = lossless ? [16, 24] : bitrateList(s.Format);
    const cur = lossless ? s.BitDepth : shownBitrate(s);
    const at = Math.max(0, values.indexOf(cur));
    // one angle function drives both the pointer and the step dots, so they cannot drift apart
    const stepAng = (i) => {
      const f = lossless ? (i === 0 ? 1 / 3 : 2 / 3) : values.length > 1 ? i / (values.length - 1) : 0;
      return -135 + f * 270;
    };
    const ang = stepAng(at);
    $('knobPtr').style.setProperty('--ang', ang + 'deg');
    const ticks = $('knobTicks');
    const key = `${lossless ? 'L' : 'S'}${values.length}`;
    if (ticks.dataset.key !== key) {
      ticks.dataset.key = key;
      ticks.textContent = '';
      values.forEach((_, i) => {
        const a = (stepAng(i) * Math.PI) / 180;
        const t = document.createElement('b');
        t.style.left = `${(36 + 33 * Math.sin(a) - 2).toFixed(2)}px`;
        t.style.top = `${(36 - 33 * Math.cos(a) - 2).toFixed(2)}px`;
        ticks.appendChild(t);
      });
      // end labels sit under the first and last dot
      const place = (id, i) => {
        const a = (stepAng(i) * Math.PI) / 180;
        const x = 36 + 33 * Math.sin(a);
        const y = 36 - 33 * Math.cos(a);
        // lossless dots sit high on the sides: the label goes outward beside the dot; lossy dots sit low: label under the dot
        const side = lossless ? (i === 0 ? -1 : 1) : 0;
        $(id).style.left = `${(x + side * 6).toFixed(2)}px`;
        $(id).style.top = `${(y + (lossless ? -4 : 5)).toFixed(2)}px`;
        $(id).style.transform = side < 0 ? 'translateX(-100%)' : side > 0 ? 'none' : 'translateX(-50%)';
      };
      place('knobLo', 0);
      place('knobHi', values.length - 1);
    }
    Array.from(ticks.children).forEach((t, i) => t.classList.toggle('on', i === at));
    $('knobVal').textContent = String(cur);
    $('knobLo').textContent = String(values[0]);
    $('knobHi').textContent = String(values[values.length - 1]);
    const label = lossless ? `Bit depth ${cur}` : `Bitrate ${cur} kbps`;
    $('knob').setAttribute('aria-label', `${label}. Click to change.`);
    $('knob').title = `${label}. Click to change.`;
  }

  function formatReadout() {
    const s = settings();
    return LOSSLESS.includes(s.Format) ? `${SHORT[s.Format]} ${s.BitDepth}` : `${SHORT[s.Format]} ${shownBitrate(s)}`;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function renderReadouts() {
    const s = settings();
    const total = progTotal;
    const cur = Math.min(progIndex + 1, total);
    $('roTrack').textContent = phase === 'idle' ? '--/--' : phase === 'running' ? `${pad2(cur)}/${pad2(total)}` : `${pad2(Math.min(progIndex, total))}/${pad2(total)}`;
    $('roFormat').textContent = formatReadout();
    if (phase === 'running' && etaSecs !== null) {
      $('roTime').textContent = `${pad2(Math.floor(etaSecs / 60))}:${pad2(etaSecs % 60)}`;
    } else {
      $('roTime').textContent = phase === 'done' ? '00:00' : '--:--';
    }
    $('roFlags').textContent = String(flags.length);
    $('roFlags').classList.toggle('hot', flags.length > 0);
    // platter
    const pct = total ? Math.round((progIndex / total) * 100) : 0;
    const p = phase === 'idle' ? 0 : pct;
    $('track').style.setProperty('--p', String(p));
    $('track').classList.toggle('idle', phase === 'idle');
    $('track').setAttribute('aria-valuenow', String(p));
    $('fill').style.width = `${p}%`;
    if (phase === 'running') {
      $('hubLabel').textContent = 'CONVERTING';
      $('hubBig').textContent = `${pct}%`;
      $('count').textContent = `${cur} / ${total}`;
    } else if (phase === 'stopped') {
      $('hubLabel').textContent = 'STOPPED';
      $('hubBig').textContent = `${pct}%`;
      $('count').textContent = `${progIndex} / ${total}`;
    } else if (phase === 'failed') {
      $('hubLabel').textContent = 'PROBLEM';
      $('hubBig').textContent = 'FAILED';
      $('count').textContent = `${progIndex} / ${total}`;
    } else if (phase === 'done') {
      $('hubLabel').textContent = 'FINISHED';
      $('hubBig').textContent = 'DONE';
      $('count').textContent = `${progIndex} / ${total}`;
    } else {
      $('hubLabel').textContent = s.WatchFolder && watching() ? 'WATCHING' : 'READY';
      $('hubBig').textContent = SHORT[s.Format];
      $('count').textContent = '';
    }
    if (playState === 'playing') hubPlay(); // elapsed time sits in the hub while a track plays
  }

  // ---- peak meter: 20 segments (13 green, 4 amber, 3 red), -30 dB .. 0 dB ----
  function renderMeter() {
    if (meterLive()) return; // the live level owns the meter while a track plays
    const box = $('meter');
    if (!box.childNodes.length) {
      for (let i = 0; i < 20; i++) {
        const seg = document.createElement('i');
        seg.className = i < 13 ? 'g' : i < 17 ? 'a' : 'r';
        box.appendChild(seg);
      }
    }
    const off = !settings().ClipCheck;
    let lit = 0;
    if (!off && lastPeak !== null) lit = Math.round(Math.max(0, Math.min(1, (lastPeak + 30) / 30)) * 20);
    Array.from(box.children).forEach((seg, i) => seg.classList.toggle('on', i < lit));
    $('peakLabel').textContent = off ? 'CLIP CHECK OFF' : 'PEAK OF LAST TRACK';
    const txt = off ? '' : lastPeak === null ? '--' : `${lastPeak > 0 ? '+' : ''}${lastPeak.toFixed(1)} dB`;
    $('peakVal').textContent = txt;
    box.setAttribute('aria-label', off ? 'Clip check is off' : lastPeak === null ? 'No peak measured yet' : `Peak of last track ${txt}`);
  }

  function renderPresets(selected) {
    const list = settings().Presets || [];
    const pick = $('presetList');
    const keep = selected !== undefined ? selected : pick.value;
    pick.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = list.length ? 'Choose a preset...' : 'No presets saved yet';
    pick.appendChild(first);
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name;
      pick.appendChild(o);
    }
    pick.value = list.some((p) => p.name === keep) ? keep : '';
    $('presetDelete').disabled = running || !pick.value;
  }

  async function savePreset() {
    const name = $('presetName').value.trim();
    if (!name) { $('presetMsg').textContent = 'Type a name first.'; return; }
    const options = {};
    for (const k of PRESET_KEYS) options[k] = settings()[k];
    const list = (settings().Presets || []).filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    list.push({ name, options });
    await save({ Presets: list });
    const saved = (settings().Presets || []).some((p) => p.name === name);
    $('presetMsg').textContent = saved ? `Saved "${name}".` : 'Not saved (up to 20 presets, names up to 40 characters).';
    if (saved) { $('presetName').value = ''; renderPresets(name); }
  }

  function setRunning(value) {
    running = value;
    $('start').disabled = value;
    $('start').textContent = ranOnce && !value ? 'AGAIN' : 'START';
    $('stop').disabled = !value && !downloading;
    for (const el of document.querySelectorAll('#panel [data-key]:not([data-key="PlayPreview"]), #setName, #presetList, #presetName, #presetSave')) el.disabled = value;
    $('presetDelete').disabled = value || !$('presetList').value;
    for (const id of ['browseIn', 'browseOut', 'inDir', 'outDir', 'knob', 'roQuality']) $(id).disabled = value;
    for (const el of document.querySelectorAll('#pads .pad, .opt')) el.disabled = value;
  }

  // ---- screen: waveform, overview strip ----
  const rnd = (k) => { const x = Math.sin(k * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const shape = (i) => {
    const env = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.085 + 0.4));
    const hit = rnd(i) > 0.78 ? 1 : 0.18 + 0.5 * rnd(i + 99);
    return env * hit;
  };
  const WAVE_BARS = 150;
  const MINI_BARS = 120;

  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return null;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function playFraction() {
    if (phase === 'idle') return 0;
    return progTotal ? Math.min(1, progIndex / progTotal) : phase === 'done' ? 1 : 0;
  }

  // red ruler ticks top and bottom (every 4th is red)
  function drawTicks(ctx, w, h) {
    for (let i = 0; i < 25; i++) {
      ctx.fillStyle = i % 4 === 0 ? COL.red : '#6B8A92';
      const x = Math.round((i / 24) * (w - 1));
      ctx.fillRect(x, 0, 1, 6);
      ctx.fillRect(x, h - 6, 1, 6);
    }
  }

  function drawWave() {
    if (playDrawing()) { drawPlay(); return; }
    const f = fitCanvas($('wave'));
    if (!f) return;
    const { ctx, w, h } = f;
    const p = playFraction();
    const idle = phase === 'idle';
    drawTicks(ctx, w, h);
    const slot = w / WAVE_BARS;
    const cy = h / 2;
    for (let i = 0; i < WAVE_BARS; i++) {
      const v = shape(i);
      const bh = Math.round(8 + v * 80);
      const x = i * slot + 0.5;
      const bw = Math.max(1, slot - 1);
      ctx.globalAlpha = !idle && i < WAVE_BARS * p ? 1 : 0.28;
      ctx.fillStyle = v > 0.45 ? COL.blue : COL.dim;
      ctx.beginPath();
      ctx.moveTo(x + bw / 2, cy - bh / 2);
      ctx.lineTo(x + bw, cy);
      ctx.lineTo(x + bw / 2, cy + bh / 2);
      ctx.lineTo(x, cy);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!idle) {
      ctx.fillStyle = COL.orange;
      ctx.fillRect(Math.min(w - 2, Math.max(0, p * w - 1)), 0, 2, h);
    }
  }

  function drawMini() {
    const f = fitCanvas($('mini'));
    if (!f) return;
    const { ctx, w, h } = f;
    if (playState === 'playing') { drawMiniPlay(ctx, w, h); return; }
    const p = playFraction();
    const idle = phase === 'idle';
    const slot = w / MINI_BARS;
    for (let i = 0; i < MINI_BARS; i++) {
      const bh = Math.round(4 + shape(i * 1.25) * 22);
      ctx.globalAlpha = !idle && i < MINI_BARS * p ? 0.95 : 0.3;
      ctx.fillStyle = COL.blue;
      ctx.fillRect(i * slot, h - bh, Math.max(1, slot - 1), bh);
    }
    ctx.globalAlpha = 1;
    const head = $('ovHead');
    head.hidden = idle;
    head.style.left = `${(p * 100).toFixed(2)}%`;
  }

  function renderRuler() {
    const ruler = $('ruler');
    const total = progTotal;
    const key = `${total}`;
    if (ruler.dataset.key === key) return;
    ruler.dataset.key = key;
    ruler.textContent = '';
    if (!total) return;
    const step = Math.max(1, Math.ceil(total / 12));
    for (let n = 1; n <= total; n += step) {
      const s = document.createElement('span');
      s.textContent = String(n);
      ruler.appendChild(s);
    }
  }

  function addFlag(res, row) {
    const note = `${res.note || ''}`;
    let color = null;
    let why = '';
    if (/clipping|over 0|dBFS/i.test(note)) { color = COL.red; why = 'clipping'; }
    else if (/duplicate/i.test(note)) { color = COL.orange; why = 'duplicate'; }
    else if (res.health) { color = COL.teal; why = 'health check'; }
    else if (res.player) { color = COL.violet; why = 'player check'; }
    else if (['WARN', 'LOW', 'FAKE'].includes(res.status)) { color = COL.pink; why = `quality ${res.status}`; }
    if (!color) return;
    const n = flags.length;
    if (row) { row.dataset.flag = String.fromCharCode(65 + (n % 26)); row.dataset.flagColor = color; } // the platter's cue pill reads these
    flags.push({ at: resultCount - 1, color });
    const m = document.createElement('span');
    m.className = 'flag';
    m.style.background = color;
    m.textContent = String.fromCharCode(65 + (n % 26));
    m.title = `${m.textContent}: track ${resultCount} - ${why}`;
    m.dataset.at = String(resultCount - 1);
    $('markers').appendChild(m);
    placeFlags();
  }
  function placeFlags() {
    const total = Math.max(progTotal, resultCount, 1);
    for (const m of $('markers').children) m.style.left = `${((Number(m.dataset.at) + 0.5) / total * 100).toFixed(2)}%`;
  }
  function clearFlags() {
    flags = [];
    $('markers').textContent = '';
  }

  function drawAll() {
    renderRuler();
    drawWave();
    drawMini();
    placeFlags();
  }

  // ---- log ----
  function showLog() {
    if ($('log').hidden) { $('empty').hidden = true; $('log').hidden = false; }
  }
  function addLine(el) {
    showLog();
    const box = $('log').parentElement;
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    $('log').appendChild(el);
    if (stick) box.scrollTop = box.scrollHeight;
  }
  function addMessage(text, level) {
    const d = document.createElement('div');
    d.className = `msg ${level || ''}`;
    d.textContent = text;
    addLine(d);
  }
  function addResult({ status, name, note, second, play }) {
    const row = document.createElement('div');
    row.className = 'row-log';
    const num = document.createElement('span');
    num.className = 'num';
    const numText = document.createElement('span');
    numText.textContent = pad2(resultCount);
    num.appendChild(numText);
    // A skipped file plays the converted copy it duplicates (or that was already there): `play` names it.
    const playName = play || (status === 'OK' || status === 'WARN' ? name : '');
    if (playName && !second) {
      row.dataset.play = playName;
      const btn = document.createElement('button');
      btn.className = 'play';
      btn.type = 'button';
      btn.textContent = '▶';
      btn.setAttribute('aria-label', `Play ${playName}`);
      btn.title = 'Play preview (never changes files)';
      num.appendChild(btn);
      const on = Boolean(settings().PlayPreview);
      btn.hidden = !on;
      row.classList.toggle('playable', on);
    }
    const tag = document.createElement('span');
    tag.className = `tag ${status.toLowerCase()}`;
    tag.textContent = status;
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = name || '';
    const n = document.createElement('span');
    n.className = 'note';
    n.textContent = note || '';
    row.append(num, tag, body, n);
    addLine(row);
    return row;
  }
  function clearLog() {
    $('log').textContent = '';
    $('log').hidden = true;
    $('empty').hidden = false;
    if (playRow && !$('log').contains(playRow)) stopPlayback();
  }

  // ---- playback preview (never changes files; the main process decodes to a temp file and serves it as tcplay://) ----
  const EQ_BANDS = 32;
  const WIN = 10; // seconds of waveform shown around the playhead
  const VOL_KEY = 'tc.vol';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let audio = null;
  let actx = null;
  let analyser = null;
  let freqData = null;
  let timeData = null;
  let bandEdges = null;
  let peaks = new Float32Array(EQ_BANDS);
  let playState = 'idle'; // idle | preparing | playing
  let playRow = null;
  let playReq = 0;
  let eqRaf = 0;
  let savedStatus = '';
  let ourStatus = null;
  let lastTime = '';
  let wf = null; // { a: Uint8Array of peaks 0..255, per: bins per second } or null (old bars only)
  let trackLen = 0;
  let ctLast = -1;
  let ctAt = 0;
  let lastMiniCol = -1;
  let miniCache = null;
  let bigCols = null;
  let meterLvl = -60;
  let meterLit = -1;
  let meterTxt = '';
  let meterHist = []; // [time, dB] of the last ~100 ms
  let meterAt = 0;
  let meterHold = -60;
  let meterHoldAt = 0;
  let meterTxtAt = 0;
  let jog = null; // { id, wasPlaying, last, t, deg } while the platter is held
  let tempoRange = 10;
  const RANGES = [6, 10, 16];
  const RANGE_KEY = 'tc.range';
  try {
    const sr = Number(localStorage.getItem(RANGE_KEY));
    if (RANGES.includes(sr)) tempoRange = sr;
  } catch (err) { /* storage unavailable: keep the default */ }
  let ovDrag = false;
  let volume = 100;
  try {
    const saved = localStorage.getItem(VOL_KEY);
    if (saved !== null && Number.isFinite(Number(saved))) volume = clamp(Math.round(Number(saved)), 0, 100);
  } catch (err) { /* storage unavailable: keep the default */ }

  const playDrawing = () => playState === 'playing' && Boolean(analyser || wf);
  const meterLive = () => playState === 'playing' && Boolean(analyser);
  const baseName = (n) => String(n).split(/[\\/]/).pop();
  const fmtTime = (t) => (Number.isFinite(t) && t >= 0 ? `${Math.floor(t / 60)}:${pad2(Math.floor(t % 60))}` : '--:--');
  const dur = () => (audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : trackLen);

  // currentTime only moves in small steps: smooth it between steps so the scrolling waveform glides
  function curTime() {
    const ct = audio.currentTime;
    const now = performance.now();
    if (ct !== ctLast) { ctLast = ct; ctAt = now; }
    if (audio.paused) return ct;
    const est = ct + Math.min(0.12, ((now - ctAt) / 1000) * audio.playbackRate);
    const d = dur();
    return d > 0 ? Math.min(d, est) : est;
  }
  function playFrac() { const d = dur(); return d > 0 ? clamp(curTime() / d, 0, 1) : 0; }
  function seekTo(t) {
    const d = dur();
    if (!audio || !(d > 0)) return;
    audio.currentTime = clamp(t, 0, d);
    ctLast = -1;
    updateTime();
  }

  function setPlayStatus(text) {
    if (ourStatus === null) savedStatus = $('status').textContent;
    ourStatus = text;
    $('status').textContent = text;
  }
  function restoreStatus() {
    // only when nothing else (a batch event) has changed the screen title since
    if (ourStatus !== null && $('status').textContent === ourStatus) $('status').textContent = savedStatus;
    ourStatus = null;
  }
  function setRowPlaying(row, on) {
    if (!row) return;
    row.classList.toggle('playing', on);
    syncRowBtn(row);
  }
  // the row button is play / pause for its own track
  function syncRowBtn(row) {
    const r = row || playRow;
    if (!r) return;
    const btn = r.querySelector('.play');
    if (!btn) return;
    const isCur = r === playRow && playState !== 'idle';
    const pausable = isCur && !(playState === 'playing' && audio && audio.paused);
    btn.textContent = pausable ? '❚❚' : '▶';
    const label = `${pausable ? 'Pause' : 'Play'} ${r.dataset.play}`;
    btn.setAttribute('aria-label', label);
    btn.title = pausable ? 'Pause preview' : 'Play preview (never changes files)';
  }
  function syncPlayable() {
    const on = Boolean(state && settings().PlayPreview);
    for (const row of $('log').querySelectorAll('.row-log[data-play]')) {
      row.classList.toggle('playable', on);
      const btn = row.querySelector('.play');
      if (btn) btn.hidden = !on;
    }
    if (!on && playState !== 'idle') stopPlayback();
  }
  function showTransport(on) {
    $('transport').hidden = !on;
    $('playStop').disabled = !on;
    $('playPause').disabled = !on || playState !== 'playing';
    $('wave').classList.toggle('seekable', playState === 'playing');
    $('overview').classList.toggle('scrub', playState === 'playing');
  }
  function updateTime() {
    const txt = `${fmtTime(audio.currentTime)} / ${fmtTime(dur())}`;
    if (txt !== lastTime) {
      lastTime = txt;
      $('playTime').textContent = txt;
      // the TIME LEFT readout counts down the playing track (the conversion estimate comes back when playback stops)
      const left = Math.max(0, Math.round(dur() - audio.currentTime));
      if (Number.isFinite(left)) $('roTime').textContent = `${pad2(Math.floor(left / 60))}:${pad2(left % 60)}`;
    }
  }

  function setVolume(v, persist) {
    volume = clamp(Math.round(v), 0, 100);
    $('vol').value = String(volume);
    $('vol').title = `Volume ${volume}%`;
    if (audio) audio.volume = volume / 100;
    if (persist) { try { localStorage.setItem(VOL_KEY, String(volume)); } catch (err) { /* not saved */ } }
  }
  // CDJ-style tempo fader: -8..+8 %, vinyl style (the pitch follows), 0 at the centre detent
  let tempo = 0;
  function applyRate() {
    if (!audio) return;
    const r = 1 + tempo / 100;
    audio.defaultPlaybackRate = r; // a new src resets playbackRate to this
    audio.playbackRate = r;
    try { audio.preservesPitch = false; audio.webkitPreservesPitch = false; } catch (err) { /* vinyl-style pitch is optional */ }
  }
  function setRange(r, persist) {
    tempoRange = r;
    const f = $('tempoFader');
    f.style.setProperty('--R', String(r));
    $('tempo').setAttribute('aria-valuemin', String(-r));
    $('tempo').setAttribute('aria-valuemax', String(r));
    $('tempoRange').textContent = `±${r}`;
    $('tempoRange').setAttribute('aria-label', `Tempo range plus or minus ${r} percent. Click to change.`);
    const ticks = $('fdTicks');
    ticks.textContent = '';
    const step = r === 16 ? 4 : 2;
    for (let v = r; v >= -r; v -= step) {
      const b = document.createElement('b');
      b.style.setProperty('--v', String(v));
      if (v === 0) b.className = 'mid';
      ticks.appendChild(b);
    }
    if (persist) { try { localStorage.setItem(RANGE_KEY, String(r)); } catch (err) { /* not saved */ } }
    setTempo(tempo); // keeps the value if it fits, else clamps to the new end
  }
  function setTempo(t) {
    tempo = clamp(Math.round(t * 10) / 10, -tempoRange, tempoRange);
    const txt = `${tempo < 0 ? '-' : '+'}${Math.abs(tempo).toFixed(1)}%`;
    const f = $('tempo');
    f.style.setProperty('--t', String(tempo));
    f.setAttribute('aria-valuenow', String(tempo));
    f.setAttribute('aria-valuetext', `${txt.replace('%', '')} percent`);
    if ($('tempoVal').textContent !== txt) $('tempoVal').textContent = txt;
    f.title = `Tempo ${txt} (double-click to reset)`;
    $('tempoFader').classList.toggle('zero', tempo === 0);
    applyRate();
    renderSpin();
  }
  function syncTempoEnabled() {
    const on = playState === 'playing';
    $('tempoFader').classList.toggle('off', !on);
    $('tempo').setAttribute('aria-disabled', on ? 'false' : 'true');
    $('tempo').tabIndex = on ? 0 : -1;
    $('tempoVal').disabled = !on;
    $('tempoRange').disabled = !on;
  }
  function togglePause() {
    if (playState !== 'playing' || !audio || jog) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }
  function syncPause() {
    const paused = playState === 'playing' && Boolean(audio) && audio.paused;
    $('playPause').textContent = paused ? '▶' : '❚❚';
    const label = paused ? 'Resume playback' : 'Pause playback';
    $('playPause').setAttribute('aria-label', label);
    $('playPause').title = label;
    $('eqIcon').classList.toggle('paused', paused);
    syncRowBtn();
    ctLast = -1;
    renderSpin();
  }

  // platter: 33 1/3 rpm = 1.8 s per turn, scaled by the tempo; paused with the audio
  function renderSpin() {
    const pl = $('track');
    pl.style.setProperty('--rev', `${(1.8 / (1 + tempo / 100)).toFixed(3)}s`);
    const on = playState === 'playing';
    const rec = on && Boolean(settings().PlatterSpin);
    pl.classList.toggle('spinning', on);
    pl.classList.toggle('record', rec);
    pl.classList.toggle('cdj', on && !rec);
    pl.classList.toggle('paused', on && Boolean(audio) && audio.paused);
    const cue = pl.querySelector('.cdj-cue');
    const letter = on && !rec && playRow ? playRow.dataset.flag : '';
    cue.hidden = !letter;
    if (letter) { cue.textContent = letter; cue.style.background = playRow.dataset.flagColor || ''; }
    if (!on || rec) pl.style.removeProperty('--ph');
    else platterHead();
  }
  // CDJ look: the playhead angle follows the track position
  function platterHead() {
    const pl = $('track');
    if (!pl.classList.contains('cdj') || !audio) return;
    pl.style.setProperty('--ph', `${(playFrac() * 360).toFixed(2)}deg`);
  }
  function hubPlay() {
    if (playState !== 'playing' || !audio) return;
    const t = fmtTime(audio.currentTime);
    if ($('hubBig').textContent !== t) $('hubBig').textContent = t;
  }
  function setArt(url) {
    $('art').style.backgroundImage = url ? `url("${url}")` : '';
    $('track').classList.toggle('has-art', Boolean(url));
  }
  function loadArt(url, req) {
    if (typeof url !== 'string' || !/^tcplay:\/\/art\/[A-Za-z0-9._~%-]+$/.test(url)) return;
    const im = new Image();
    im.onload = () => { if (req === playReq && playState === 'playing') setArt(url); };
    im.src = url;
  }

  // the left meter shows the live output level while a track plays
  function enterLive() {
    if (!analyser) return;
    meterLvl = -60;
    meterLit = -1;
    meterTxt = '';
    meterHist = [];
    meterAt = 0;
    meterHold = -60;
    meterHoldAt = 0;
    meterTxtAt = 0;
    $('peakLabel').textContent = 'LEVEL';
    $('meter').setAttribute('aria-label', 'Live playback level');
  }
  // VU-style ballistics: the level is the loudest sample of the last ~100 ms (near-instant attack), it falls about 17 dB per second,
  // a hold mark stays ~1 s on the highest point and then falls the same way; the dB text refreshes at most 10 times a second.
  const METER_FALL = 17; // dB per second
  function liveMeter() {
    const now = performance.now();
    analyser.getByteTimeDomainData(timeData);
    let pk = 0;
    for (let i = 0; i < timeData.length; i++) { const d = Math.abs(timeData[i] - 128); if (d > pk) pk = d; }
    const db = pk > 0 ? 20 * Math.log10(pk / 128) : -60;
    meterHist.push([now, db]);
    while (meterHist.length && now - meterHist[0][0] > 100) meterHist.shift();
    let recent = -60;
    for (const h of meterHist) if (h[1] > recent) recent = h[1];
    const dt = meterAt ? Math.min(0.25, (now - meterAt) / 1000) : 0;
    meterAt = now;
    meterLvl = Math.max(recent, meterLvl - METER_FALL * dt, -60);
    if (meterLvl >= meterHold) { meterHold = meterLvl; meterHoldAt = now; }
    else if (now - meterHoldAt > 1000) meterHold = Math.max(meterLvl, meterHold - METER_FALL * dt);
    const lit = Math.round(clamp((meterLvl + 30) / 30, 0, 1) * 20);
    const hold = Math.round(clamp((meterHold + 30) / 30, 0, 1) * 20);
    const key = lit * 100 + hold;
    if (key !== meterLit) {
      meterLit = key;
      Array.from($('meter').children).forEach((seg, i) => seg.classList.toggle('on', i < lit || (hold > 0 && i === hold - 1)));
    }
    if (now - meterTxtAt >= 100) {
      meterTxtAt = now;
      const txt = meterLvl <= -59 ? '--' : `${meterLvl > 0 ? '+' : ''}${meterLvl.toFixed(0)} dB`;
      if (txt !== meterTxt) { meterTxt = txt; $('peakVal').textContent = txt; }
    }
  }
  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.preload = 'auto';
      audio.volume = volume / 100;
      audio.addEventListener('ended', () => {
        if (playState === 'idle') return;
        const done = playRow;
        stopPlayback();
        const next = settings().PlayNext && settings().PlayPreview ? nextPlayable(done) : null;
        if (next) { next.scrollIntoView({ block: 'nearest' }); startPlayback(next); }
      });
      audio.addEventListener('play', () => { if (playState === 'playing') syncPause(); });
      audio.addEventListener('pause', () => { if (playState === 'playing') syncPause(); });
      audio.addEventListener('error', () => {
        if (playState !== 'playing') return;
        playFailed('Could not play this track.');
      });
    }
    if (!actx) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        actx = new Ctx();
        const src = actx.createMediaElementSource(audio);
        analyser = actx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.8;
        src.connect(analyser);
        analyser.connect(actx.destination);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        timeData = new Uint8Array(analyser.fftSize);
        const nyq = actx.sampleRate / 2;
        const lo = 40;
        const hi = Math.min(16000, nyq);
        bandEdges = [];
        for (let i = 0; i <= EQ_BANDS; i++) {
          const f = lo * Math.pow(hi / lo, i / EQ_BANDS);
          bandEdges.push(Math.min(freqData.length, Math.max(0, Math.round((f / nyq) * freqData.length))));
        }
      } catch (err) {
        actx = null; // playback still works through the audio element, just without the live bars
        analyser = null;
      }
    }
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
  }

  // the next row below `row` that can be played (rows with data-play, in list order)
  function nextPlayable(row) {
    if (!row || !$('log').contains(row)) return null;
    const rows = Array.from($('log').querySelectorAll('.row-log[data-play]'));
    const i = rows.indexOf(row);
    return i >= 0 && i + 1 < rows.length ? rows[i + 1] : null;
  }

  function playFailed(text) {
    stopPlayback();
    $('status').textContent = text;
    addMessage(text, 'error');
  }

  let pockAng = 0; // degrees the finger-nub band has been turned by dragging the platter (kept after release)
  function stopPlayback() {
    playReq += 1;
    const was = playState !== 'idle';
    playState = 'idle';
    if (eqRaf) { cancelAnimationFrame(eqRaf); eqRaf = 0; }
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    setTempo(0);
    syncTempoEnabled();
    const prevRow = playRow;
    playRow = null;
    setRowPlaying(prevRow, false);
    $('eqIcon').hidden = true;
    peaks.fill(0);
    lastTime = '';
    wf = null;
    trackLen = 0;
    miniCache = null;
    lastMiniCol = -1;
    ovDrag = false;
    jog = null;
    $('track').classList.remove('scrub');
    $('track').style.removeProperty('--oa');
    $('track').style.removeProperty('--pa'); // the finger nubs go back to their start position
    pockAng = 0;
    $('ovTip').hidden = true;
    setArt('');
    renderSpin();
    syncPause();
    showTransport(false);
    restoreStatus();
    if (was) {
      window.tc.playStop().catch(() => {});
      renderReadouts(); // hub text back
      renderMeter(); // stored peak reading back
    }
    drawAll();
  }

  async function startPlayback(row) {
    stopPlayback();
    const req = ++playReq;
    const name = row.dataset.play;
    ensureAudio(); // inside the click: creates / resumes the AudioContext
    playRow = row;
    playState = 'preparing';
    setRowPlaying(row, true);
    $('playTime').textContent = '0:00 / --:--';
    showTransport(true);
    setPlayStatus(`Preparing ${baseName(name)}...`);
    let r;
    try { r = await window.tc.playPrepare(name); } catch (err) { r = { ok: false, error: err.message }; }
    if (req !== playReq) { if (playState === 'idle') window.tc.playStop().catch(() => {}); return; } // stale answer
    if (!r || !r.ok) { playFailed((r && r.error) || 'Could not prepare this track.'); return; }
    try {
      audio.src = r.url;
      await audio.play();
    } catch (err) {
      if (req !== playReq) return;
      playFailed(`Could not play ${baseName(name)}: ${err.message}`);
      return;
    }
    if (req !== playReq) return;
    wf = buildWf(r);
    trackLen = r.duration > 0 ? r.duration : 0;
    miniCache = null;
    lastMiniCol = -1;
    ctLast = -1;
    playState = 'playing';
    syncTempoEnabled();
    applyRate();
    $('eqIcon').hidden = false;
    setPlayStatus(baseName(name));
    showTransport(true);
    syncPause();
    enterLive();
    loadArt(r.artUrl, req);
    renderReadouts();
    updateTime();
    const loop = () => {
      if (playState !== 'playing') { eqRaf = 0; return; }
      updateTime();
      drawPlay();
      const mw = $('mini').clientWidth;
      const col = Math.round(playFrac() * mw);
      if (col !== lastMiniCol) { lastMiniCol = col; drawMini(); }
      hubPlay();
      platterHead();
      if (analyser) liveMeter();
      eqRaf = requestAnimationFrame(loop);
    };
    eqRaf = requestAnimationFrame(loop);
  }

  function togglePlay(row) {
    if (!settings().PlayPreview) return;
    if (row === playRow && playState === 'playing') togglePause(); // the row button is play / pause; stopping is the screen's stop key
    else if (row === playRow && playState === 'preparing') return;
    else startPlayback(row);
  }

  // Waveform layers from the decoder: peak envelope, RMS body and bass-band core, each scaled to its own track-wide
  // 98th percentile so loud and quiet masters both read with structure.
  const asU8 = (raw) => (raw && raw.length ? (ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw)) : null);
  function p98k(a) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < a.length; i++) hist[a[i]] += 1;
    const goal = a.length * 0.98;
    let acc = 0;
    let p = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= goal) { p = v; break; } }
    return 1 / Math.max(p, 6);
  }
  function buildWf(r) {
    const pk = asU8(r.peaks);
    if (!pk) return null;
    const n = pk.length;
    const rm = asU8(r.rms);
    const lo = asU8(r.low);
    const rms = rm && rm.length === n ? rm : pk; // older engine: fall back to the peaks
    const low = lo && lo.length === n ? lo : new Uint8Array(n);
    return { a: pk, r: rms, l: low, per: r.perSec > 0 ? r.perSec : 100, kp: p98k(pk), kr: p98k(rms), kl: p98k(low) };
  }
  // 0..1 heights (peak envelope, body, core) for column i of `o` from the raw 0..255 values; -1 = no audio here
  function layerH(w, o, i, p, r, l) {
    const pe = Math.min(1, p * w.kp * 0.97) ** 1.2;
    const bo = Math.min(pe, Math.min(1, r * w.kr) ** 1.7 * 0.8);
    o.p[i] = pe;
    o.b[i] = bo;
    o.c[i] = Math.min(bo, Math.min(1, l * w.kl) ** 1.9 * 0.62);
  }
  const mkCols = (n) => ({ p: new Float32Array(n), b: new Float32Array(n), c: new Float32Array(n), h: new Uint8Array(n) });
  const LAYER = {
    // [peak envelope, body, core] for the played / upcoming part
    played: ['rgba(46, 167, 255, 0.34)', '#2EA7FF', '#D8EEFF'],
    next: ['rgba(46, 167, 255, 0.14)', '#1C6FA8', '#6E9CC0'],
  };

  // Big canvas while playing: faint live EQ bars behind a scrolling zoomed waveform with a fixed orange centre line.
  function drawPlay() {
    const f = fitCanvas($('wave'));
    if (!f) return;
    const { ctx, w, h } = f;
    drawTicks(ctx, w, h);
    const cy = h / 2;
    const maxH = h - 16;
    if (analyser) {
      analyser.getByteFrequencyData(freqData);
      const slot = w / EQ_BANDS;
      ctx.globalAlpha = wf ? 0.17 : 1;
      for (let i = 0; i < EQ_BANDS; i++) {
        const a = bandEdges[i];
        const b = Math.max(a + 1, bandEdges[i + 1]);
        let m = 0;
        for (let k = a; k < b && k < freqData.length; k++) if (freqData[k] > m) m = freqData[k];
        const v = (m / 255) ** 1.8; // a steeper curve keeps loud, dense music from filling every bar
        peaks[i] = Math.max(v, peaks[i] - 0.012); // caps fall slowly
        const bh = Math.max(2, Math.round(v * maxH));
        const x = i * slot + 1;
        const bw = Math.max(2, slot - 2);
        ctx.fillStyle = v > 0.45 ? COL.blue : COL.dim;
        ctx.fillRect(x, cy - bh / 2, bw, bh);
        const ph = Math.max(2, peaks[i] * maxH);
        ctx.fillStyle = COL.orange;
        ctx.fillRect(x, cy - ph / 2 - 2, bw, 2);
        ctx.fillRect(x, cy + ph / 2, bw, 2);
      }
      ctx.globalAlpha = 1;
    }
    const t = curTime();
    const d = dur();
    if (wf) {
      const half = maxH / 2;
      const cx = Math.round(w / 2);
      const n = wf.a.length;
      const W = Math.floor(w);
      if (!bigCols || bigCols.p.length < W) bigCols = mkCols(W);
      const cols = bigCols;
      const have = cols.h;
      have.fill(0);
      for (let x = 0; x < W; x++) {
        const t0 = t + ((x - w / 2) / w) * WIN;
        if (t0 < 0) continue;
        const i0 = Math.floor(t0 * wf.per);
        if (i0 >= n) continue;
        const i1 = Math.min(n - 1, Math.max(i0, Math.floor((t0 + WIN / w) * wf.per)));
        let pm = 0; let rs = 0; let ls = 0;
        for (let k = i0; k <= i1; k++) { if (wf.a[k] > pm) pm = wf.a[k]; rs += wf.r[k]; ls += wf.l[k]; }
        const cnt = i1 - i0 + 1;
        layerH(wf, cols, x, pm, rs / cnt, ls / cnt);
        have[x] = 1;
      }
      for (let pass = 0; pass < 2; pass++) { // played part bright, upcoming dimmer
        const set = pass === 0 ? LAYER.played : LAYER.next;
        const x0 = pass === 0 ? 0 : cx;
        const x1 = pass === 0 ? cx : W;
        for (let layer = 0; layer < 3; layer++) {
          ctx.fillStyle = set[layer];
          const arr = layer === 0 ? cols.p : layer === 1 ? cols.b : cols.c;
          for (let x = x0; x < x1; x++) {
            if (!have[x]) continue;
            const amp = Math.max(layer === 0 ? 1 : 0.5, arr[x] * half);
            ctx.fillRect(x, cy - amp, 1, amp * 2);
          }
        }
      }
      ctx.fillStyle = COL.orange;
      ctx.fillRect(cx - 1, 0, 2, h);
    } else if (d > 0) {
      const px = clamp((t / d) * w, 0, w);
      ctx.fillStyle = COL.orange;
      ctx.fillRect(0, h - 2, px, 2);
      ctx.fillRect(clamp(px - 1, 0, w - 2), 0, 2, h);
    }
  }

  // whole-track strip: peaks squeezed to the strip width; also the scrubber
  function drawMiniPlay(ctx, w, h) {
    const frac = playFrac();
    const px = frac * w;
    const head = $('ovHead');
    head.hidden = false;
    head.style.left = `${(frac * 100).toFixed(2)}%`;
    if (!wf) {
      const slot = w / MINI_BARS;
      for (let i = 0; i < MINI_BARS; i++) {
        const bh = Math.round(4 + shape(i * 1.25) * 22);
        ctx.globalAlpha = i * slot < px ? 0.95 : 0.3;
        ctx.fillStyle = COL.blue;
        ctx.fillRect(i * slot, h - bh, Math.max(1, slot - 1), bh);
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (!miniCache || miniCache.w !== w || miniCache.src !== wf) {
      const n = wf.a.length;
      const W = Math.floor(w);
      const cols = mkCols(W);
      for (let x = 0; x < W; x++) {
        const i0 = Math.min(n - 1, Math.floor((x / W) * n));
        const i1 = Math.max(i0, Math.floor(((x + 1) / W) * n) - 1);
        let pm = 0; let rs = 0; let ls = 0;
        for (let k = i0; k <= i1; k++) { if (wf.a[k] > pm) pm = wf.a[k]; rs += wf.r[k]; ls += wf.l[k]; }
        const cnt = i1 - i0 + 1;
        layerH(wf, cols, x, pm, rs / cnt, ls / cnt);
      }
      miniCache = { w, src: wf, cols };
    }
    // half waveform sitting on the baseline, like the CDJ overview
    const top = 2;
    const full = h - top;
    const c = miniCache.cols;
    const W = c.p.length;
    for (let pass = 0; pass < 2; pass++) {
      const set = pass === 0 ? LAYER.played : LAYER.next;
      const x0 = pass === 0 ? 0 : Math.ceil(px);
      const x1 = pass === 0 ? Math.min(W, Math.ceil(px)) : W;
      for (let layer = 0; layer < 3; layer++) {
        ctx.fillStyle = set[layer];
        const arr = layer === 0 ? c.p : layer === 1 ? c.b : c.c;
        for (let x = x0; x < x1; x++) {
          const amp = Math.max(layer === 0 ? 1 : 0.5, arr[x] * full);
          ctx.fillRect(x, h - amp, 1, amp);
        }
      }
    }
  }

  function setProgress(index, total) {
    progIndex = index;
    progTotal = total;
    etaSecs = null;
    // same estimate as before: average time per finished track times the tracks left
    if (running && index > 0 && index < total) etaSecs = Math.max(Math.round(((Date.now() - runStart) / index) * (total - index) / 1000), 5);
    renderReadouts();
    drawAll();
  }

  // A run started by the folder watch (no START click): the window shows it like a normal run, then goes back to idle.
  let watchRun = false;
  function beginWatchRun() {
    watchRun = true;
    setRunning(true);
    runStart = Date.now();
    clearLog();
    clearFlags();
    resultCount = 0;
    lastPeak = null;
    phase = 'running';
    setProgress(0, 0);
    renderMeter();
  }
  function endWatchRun() {
    watchRun = false;
    ranOnce = true;
    setRunning(false);
    renderReadouts();
    drawAll();
  }

  function onBatchEvent(ev) {
    if (ev.type === 'message' && !running && /^Watching: new file /.test(ev.text)) beginWatchRun();
    if (ev.type === 'message') {
      addMessage(ev.text, ev.level);
      if (watchRun && ev.level === 'error' && progTotal === 0) { phase = 'failed'; endWatchRun(); }
      if (ev.level === 'summary' || ev.level === 'error') $('status').textContent = ev.text;
    } else if (ev.type === 'progress') {
      setProgress(ev.index, ev.total);
      // the screen title is the file being converted
      if (ev.text) $('status').textContent = /^Converting \d+ of/.test(ev.text) && ev.file ? ev.file : ev.text;
    } else if (ev.type === 'result') {
      resultCount += 1;
      const logRow = addResult(ev);
      addFlag(ev, logRow);
      // a converted track with no reading (silent file) clears the meter; skipped or failed ones leave it alone
      if (!ev.second && (ev.status === 'OK' || ev.status === 'WARN')) lastPeak = typeof ev.peak === 'number' ? ev.peak : null;
      renderMeter();
      renderReadouts();
    } else if (ev.type === 'done') {
      if (ev.synthetic) { if (watchRun) { phase = 'stopped'; endWatchRun(); } return; } // only releases a watch run that ended without a result
      const c = ev.counts || {};
      phase = ev.stopped ? 'stopped' : (c.OK || 0) + (c.WARN || 0) === 0 && (c.FAIL || 0) > 0 ? 'failed' : 'done';
      etaSecs = null;
      renderReadouts();
      drawAll();
      $('status').textContent = ev.summary;
      if (settings().OpenWhenDone && !ev.stopped) window.tc.openFolder('out');
      if (watchRun) endWatchRun();
    }
  }

  function setDropped(count) {
    droppedCount = count;
    $('dropped').hidden = count === 0;
    $('droppedText').textContent = count === 1 ? '1 dropped file will be converted.' : `${count} dropped files will be converted.`;
  }

  // ---- ffmpeg banner ----
  function renderBanner(ff) {
    const banner = $('banner');
    $('copyCmd').hidden = true;
    $('brewSite').hidden = true;
    if (ff.found && ff.mp3) { banner.hidden = true; return; }
    banner.hidden = false;
    const p = state.platform;
    $('bannerTitle').textContent = ff.found ? 'This ffmpeg cannot write MP3' : 'ffmpeg not found';
    const cmd = $('bannerCmd');
    cmd.hidden = true;
    $('download').hidden = p !== 'win32' || ff.found;
    if (ff.found) {
      $('bannerText').textContent = 'The ffmpeg that was found has no MP3 encoder (libmp3lame). Install a full build, or choose a different one.';
    } else if (p === 'win32') {
      $('bannerText').textContent = 'Tunes Converter needs ffmpeg and ffprobe. Download them with one click (about 100 MB, checked against a published checksum), or put ffmpeg.exe and ffprobe.exe in a "bin" folder next to this app.';
    } else if (p === 'darwin') {
      cmd.hidden = false;
      cmd.textContent = 'brew install ffmpeg';
      $('copyCmd').hidden = false;
      if (state.hasBrew) {
        $('bannerText').textContent = 'Tunes Converter needs ffmpeg. Click "Copy command", open the Terminal app (Spotlight: press Cmd+Space, type Terminal), paste with Cmd+V, press Return, wait for it to finish, then click "Check again".';
      } else {
        $('brewSite').hidden = false;
        $('bannerText').textContent = 'Tunes Converter needs ffmpeg, and the easiest way to get it on a Mac is Homebrew. Click "Get Homebrew" and follow the one-line install on that page. Then click "Copy command", paste it into the Terminal app, press Return, and click "Check again".';
      }
    } else {
      $('bannerText').textContent = 'Tunes Converter needs ffmpeg. Install it with your package manager, then press "Check again":';
      cmd.hidden = false;
      cmd.textContent = 'sudo apt install ffmpeg      # Debian / Ubuntu\nsudo dnf install ffmpeg      # Fedora (needs RPM Fusion)\nsudo pacman -S ffmpeg        # Arch';
    }
  }

  async function applyFfmpeg(ff) {
    if (ff) state.ffmpeg = ff;
    renderBanner(state.ffmpeg);
  }

  // Asked once per launch when ffmpeg is missing. Nothing is downloaded or installed until the user says yes.
  function offerFfmpeg(ff) {
    if (ff.found) return;
    const dlg = $('firstRun');
    const p = state.platform;
    const yes = $('frYes');
    const cmd = $('frCmd');
    cmd.hidden = true;
    if (p === 'win32') {
      $('frText').textContent = 'Tunes Converter needs ffmpeg to convert music. Download it now? It is about 100 MB, comes from gyan.dev, is checked against a published checksum, and is kept with the app\'s own settings. Nothing else is installed.';
      yes.textContent = 'Download ffmpeg';
      yes.onclick = () => { dlg.close(); $('download').click(); };
    } else if (p === 'darwin') {
      $('frText').textContent = state.hasBrew
        ? 'Tunes Converter needs ffmpeg. Copy this command, paste it into the Terminal app (Cmd+Space, type Terminal), press Return, then click "Check again".'
        : 'Tunes Converter needs ffmpeg. The easiest way on a Mac is Homebrew (brew.sh). Install it, then copy this command, paste it into the Terminal app, press Return, and click "Check again".';
      cmd.hidden = false;
      cmd.textContent = 'brew install ffmpeg';
      yes.textContent = 'Copy command';
      yes.onclick = async () => { await window.tc.copyInstallCommand(); dlg.close(); };
    } else {
      $('frText').textContent = 'Tunes Converter needs ffmpeg. Install it with your package manager in a terminal, then click "Check again":';
      cmd.hidden = false;
      cmd.textContent = 'sudo apt install ffmpeg      # Debian / Ubuntu\nsudo dnf install ffmpeg      # Fedora (needs RPM Fusion)\nsudo pacman -S ffmpeg        # Arch';
      yes.textContent = 'OK';
      yes.onclick = () => dlg.close();
    }
    $('frNo').onclick = () => dlg.close();
    dlg.showModal();
  }

  async function init() {
    state = await window.tc.getState();
    $('inDir').value = settings().In;
    $('outDir').value = settings().Out;
    $('version').textContent = `v${state.version}`;
    $('dataDir').textContent = state.dataDir;
    $('dataDir').title = `Settings and log are stored in ${state.dataDir}`;
    render();
    renderBanner(state.ffmpeg);

    offerFfmpeg(state.ffmpeg);
    window.tc.onBatchEvent(onBatchEvent);
    window.tc.onWatchStatus((st) => { state.watch = st; render(); });
    window.tc.onDownloadProgress(({ done, total }) => {
      const mb = (n) => (n / 1048576).toFixed(0);
      $('dlStatus').textContent = total ? `Downloading... ${mb(done)} / ${mb(total)} MB` : `Downloading... ${mb(done)} MB`;
    });

    $('browseIn').addEventListener('click', async () => {
      const p = await window.tc.pickFolder({ title: 'Choose the folder with your music', defaultPath: $('inDir').value });
      if (p) { $('inDir').value = p; save({ In: p }); }
    });
    $('browseOut').addEventListener('click', async () => {
      const p = await window.tc.pickFolder({ title: 'Choose where to save the converted music', defaultPath: $('outDir').value });
      if (p) { $('outDir').value = p; save({ Out: p }); }
    });
    $('inDir').addEventListener('change', () => save({ In: $('inDir').value }));
    $('outDir').addEventListener('change', () => save({ Out: $('outDir').value }));

    const cycle = (list, value) => list[(list.indexOf(value) + 1) % list.length];
    $('knob').addEventListener('click', () => {
      const s = settings();
      // lossless formats: the knob changes the bit depth; lossy formats: the bitrate (Opus tops out at 256)
      if (LOSSLESS.includes(s.Format)) { save({ BitDepth: s.BitDepth === 16 ? 24 : 16 }); return; }
      save({ Bitrate: cycle(bitrateList(s.Format), shownBitrate(s)) });
    });
    // MENU swaps the main view for the menu page (same window); BACK / Escape returns. Nothing in the main view is torn down.
    const setMenu = (open) => {
      $('panel').hidden = !open;
      $('mainView').hidden = open;
      $('gear').textContent = open ? 'BACK' : 'MENU';
      $('gear').title = open ? 'Back to the converter' : 'Menu: all settings';
      $('gear').setAttribute('aria-expanded', String(open));
      if (open) {
        const first = $('panel').querySelector('select:not(:disabled), input:not(:disabled), button:not(:disabled)');
        (first || $('gear')).focus();
      } else {
        $('gear').focus();
        fitZoom(true);
        drawAll();
      }
    };
    $('gear').addEventListener('click', () => setMenu($('panel').hidden));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('panel').hidden && !$('firstRun').open) { e.preventDefault(); setMenu(false); }
    });
    $('setName').addEventListener('change', async () => {
      if ($('setName').value === 'custom') {
        for (const el of document.querySelectorAll('#panel [data-show="custom"]')) el.hidden = false;
        $('setNameTemplate').focus();
      } else {
        await save({ NameTemplate: $('setName').value });
      }
    });
    $('setNameTemplate').addEventListener('change', async () => {
      const typed = $('setNameTemplate').value.trim();
      await save({ NameTemplate: typed });
      if (settings().NameTemplate !== typed) $('nameHelp').textContent = 'Not accepted. Use only {artist} {title} {album} {albumartist} {track} {year} {genre} with your own text around them.';
    });
    $('setFolder').addEventListener('change', async () => {
      if ($('setFolder').value === 'custom') {
        for (const el of document.querySelectorAll('#panel [data-show="fcustom"]')) el.hidden = false;
        $('setFolderTemplate').focus();
      } else {
        await save({ FolderTemplate: $('setFolder').value });
      }
    });
    $('setFolderTemplate').addEventListener('change', async () => {
      const typed = $('setFolderTemplate').value.trim();
      await save({ FolderTemplate: typed });
      if (settings().FolderTemplate !== typed) $('folderHelp').textContent = 'Not accepted. Use up to 3 levels split with /, with only {artist} {albumartist} {album} {genre} {year} and your own text.';
    });
    $('browseSecond').addEventListener('click', async () => {
      const p = await window.tc.pickFolder({ title: 'Choose where to save the second copy', defaultPath: $('setSecondOut').value });
      if (p) { $('setSecondOut').value = p; save({ SecondOut: p }); }
    });
    $('presetList').addEventListener('change', async () => {
      const p = (settings().Presets || []).find((x) => x.name === $('presetList').value);
      $('presetMsg').textContent = '';
      if (p) { await save(p.options); $('presetMsg').textContent = `Loaded "${p.name}".`; }
      renderPresets();
    });
    $('presetSave').addEventListener('click', savePreset);
    $('presetExport').addEventListener('click', async () => {
      const r = await window.tc.exportPresets();
      if (r && r.ok) $('presetMsg').textContent = `Exported ${r.count} preset${r.count === 1 ? '' : 's'}.`;
      else if (r && r.error) $('presetMsg').textContent = r.error;
    });
    $('presetImport').addEventListener('click', async () => {
      const r = await window.tc.importPresets();
      if (r && r.ok) {
        state.settings = r.settings;
        render();
        $('presetMsg').textContent = `Imported ${r.added} preset${r.added === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} (same name or list full)` : ''}.`;
      } else if (r && r.error) {
        $('presetMsg').textContent = r.error;
      }
    });
    $('presetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePreset(); });
    $('presetDelete').addEventListener('click', async () => {
      const name = $('presetList').value;
      if (!name) return;
      await save({ Presets: (settings().Presets || []).filter((p) => p.name !== name) });
      $('presetMsg').textContent = `Deleted "${name}".`;
      renderPresets('');
    });
    for (const el of document.querySelectorAll('#panel [data-key]')) {
      if (el.id === 'setNameTemplate' || el.id === 'setFolderTemplate') continue;
      el.addEventListener('change', () => {
        const value = el.type === 'checkbox' ? el.checked : el.hasAttribute('data-number') ? Number(el.value) : el.value;
        save({ [el.dataset.key]: value });
      });
    }
    for (const pad of document.querySelectorAll('#pads .pad')) pad.addEventListener('click', () => save({ Format: pad.dataset.fmt }));
    for (const opt of document.querySelectorAll('.opt')) opt.addEventListener('click', () => save({ [opt.dataset.opt]: !settings()[opt.dataset.opt] }));
    $('roQuality').addEventListener('click', () => save({ QualityCheck: cycle(MODES, settings().QualityCheck) }));
    window.addEventListener('resize', () => { drawAll(); fitZoom(); });
    // content that changes height (ffmpeg banner, dropped-files bar) re-fits the zoom too
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => fitZoom(true));
      for (const el of document.querySelectorAll('#banner, #dropped, .screen, .deck')) ro.observe(el);
    }
    fitZoom(true);
    $('start').addEventListener('click', async () => {
      if (running) return;
      setRunning(true);
      runStart = Date.now();
      clearLog();
      clearFlags();
      resultCount = 0;
      lastPeak = null;
      phase = 'running';
      setProgress(0, 0);
      renderMeter();
      $('status').textContent = 'Starting...';
      try {
        await window.tc.startBatch($('inDir').value.trim(), $('outDir').value.trim(), droppedCount > 0);
      } catch (err) {
        addMessage(`ERROR: ${err.message}`, 'error');
        $('status').textContent = `ERROR: ${err.message}`;
      } finally {
        ranOnce = true;
        if (phase === 'running') phase = 'failed'; // no 'done' event: the run never started (error is in the log)
        setDropped(0);
        setRunning(false);
        renderReadouts();
        drawAll();
      }
    });
    $('log').addEventListener('click', (e) => {
      const row = e.target.closest('.row-log[data-play]');
      if (row && $('log').contains(row)) {
        const b = e.target.closest('button');
        if (b) b.blur(); // so Space means pause, not "press this button again"
        togglePlay(row);
      }
    });
    $('playStop').addEventListener('click', () => stopPlayback());
    $('playPause').addEventListener('click', () => togglePause());
    setVolume(volume, false);
    $('vol').addEventListener('input', () => setVolume(Number($('vol').value), true));
    // CDJ jog finger pockets: 24 ovals around the vinyl ring (static)
    const pockets = $('cdjPockets');
    for (let i = 0; i < 24; i++) {
      const p = document.createElement('i');
      p.style.transform = `rotate(${i * 15}deg)`;
      pockets.appendChild(p);
    }
    // tempo fader: drag, arrow keys (Shift / PageUp / PageDown = 1 %), Home resets, double-click or the readout resets
    const fader = $('tempo');
    const fdOn = () => playState === 'playing';
    let fdDrag = false;
    // magnetic centre: within +/-0.4 % the value snaps to 0; once there, it takes a little extra movement (0.65 %) to leave
    const SNAP_IN = 0.4;
    const SNAP_OUT = 0.65;
    const fdTick = () => {
      const tr = $('tempo');
      tr.classList.remove('flash');
      void tr.offsetWidth;
      tr.classList.add('flash');
      if (!actx) return;
      try {
        const now = actx.currentTime;
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = 'sine';
        o.frequency.value = 1500;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.03, now + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);
        o.connect(g);
        g.connect(actx.destination);
        o.start(now);
        o.stop(now + 0.03);
      } catch (err) { /* the tick is optional */ }
    };
    $('tempo').addEventListener('animationend', (e) => { if (e.animationName === 'notch-flash') $('tempo').classList.remove('flash'); });
    const fdSet = (e) => {
      const r = fader.getBoundingClientRect();
      const span = Math.max(1, r.height - 50); // thumb centre travels from 25 px to height - 25 px
      const f = clamp((e.clientY - r.top - 25) / span, 0, 1);
      let t = tempoRange - f * 2 * tempoRange;
      const was = tempo;
      if (was === 0 ? Math.abs(t) < SNAP_OUT : Math.abs(t) < SNAP_IN) t = 0;
      setTempo(t);
      if (was !== 0 && tempo === 0) fdTick();
    };
    fader.addEventListener('pointerdown', (e) => {
      if (!fdOn() || e.button !== 0) return;
      fdDrag = true;
      try { fader.setPointerCapture(e.pointerId); } catch (err) { /* dragging still works while over it */ }
      fader.focus({ preventScroll: true });
      fdSet(e);
      e.preventDefault();
    });
    fader.addEventListener('pointermove', (e) => { if (fdDrag) fdSet(e); });
    const fdEnd = (e) => { fdDrag = false; try { fader.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ } };
    fader.addEventListener('pointerup', fdEnd);
    fader.addEventListener('pointercancel', fdEnd);
    fader.addEventListener('dblclick', () => { if (fdOn()) setTempo(0); });
    fader.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const big = e.shiftKey ? 1 : 0.1;
      let t = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') t = tempo + big;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') t = tempo - big;
      else if (e.key === 'PageUp') t = tempo + 1;
      else if (e.key === 'PageDown') t = tempo - 1;
      else if (e.key === 'Home') t = 0;
      else if (e.key === 'End') t = -tempoRange;
      if (t === null) return;
      e.preventDefault();
      e.stopPropagation(); // the fader keeps its own arrow keys (not volume / seek)
      if (fdOn()) {
        if (Math.abs(t) < 0.4) t = tempo === 0 ? (t < 0 ? -0.5 : 0.5) : 0; // snaps to 0 near the centre; the next press leaves it
        setTempo(t);
      }
    });
    $('tempoVal').addEventListener('click', () => { if (fdOn()) setTempo(0); });
    $('tempoRange').addEventListener('click', () => {
      if (!fdOn()) return;
      setRange(RANGES[(RANGES.indexOf(tempoRange) + 1) % RANGES.length], true);
    });
    setRange(tempoRange, false);
    syncTempoEnabled();
    // jog wheel: hold and turn the platter (CDJ look only). 1.8 s of track per turn; the track pauses while it is held.
    const plat = $('track');
    const angleOf = (e) => { const r = plat.getBoundingClientRect(); return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))); };
    plat.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || jog || playState !== 'playing' || !audio || !plat.classList.contains('cdj') || !(dur() > 0)) return;
      jog = { id: e.pointerId, wasPlaying: !audio.paused, last: angleOf(e), t: audio.currentTime };
      try { plat.setPointerCapture(e.pointerId); } catch (err) { /* dragging still works over the platter */ }
      audio.pause();
      plat.classList.add('scrub');
      plat.style.setProperty('--oa', `${(jog.last * 180 / Math.PI).toFixed(1)}deg`);
      e.preventDefault();
    });
    plat.addEventListener('pointermove', (e) => {
      if (!jog || e.pointerId !== jog.id) return;
      const a = angleOf(e);
      let d = a - jog.last;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      jog.last = a;
      jog.t = clamp(jog.t + (d / (2 * Math.PI)) * 1.8, 0, dur());
      pockAng += d * 180 / Math.PI; // the finger-nub band turns with the pointer
      plat.style.setProperty('--pa', `${pockAng.toFixed(1)}deg`);
      seekTo(jog.t);
      plat.style.setProperty('--oa', `${(a * 180 / Math.PI).toFixed(1)}deg`);
    });
    const jogEnd = (e) => {
      if (!jog || e.pointerId !== jog.id) return;
      const was = jog.wasPlaying;
      jog = null;
      try { plat.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      plat.classList.remove('scrub');
      plat.style.removeProperty('--oa');
      if (was && playState === 'playing' && audio && audio.paused) audio.play().catch(() => {});
      syncPause();
    };
    plat.addEventListener('pointerup', jogEnd);
    plat.addEventListener('pointercancel', jogEnd);
    plat.addEventListener('lostpointercapture', jogEnd);
    // skim strip: click or drag to seek
    const ovFrac = (e) => { const r = $('mini').getBoundingClientRect(); return clamp((e.clientX - r.left) / (r.width || 1), 0, 1); };
    const ovShow = (e) => {
      const r = $('mini').getBoundingClientRect();
      const frac = ovFrac(e);
      const tip = $('ovTip');
      tip.hidden = false;
      tip.textContent = fmtTime(frac * dur());
      tip.style.left = `${clamp(frac * r.width, 20, Math.max(20, r.width - 20))}px`;
    };
    const ov = $('overview');
    ov.addEventListener('pointerdown', (e) => {
      if (playState !== 'playing' || !(dur() > 0) || e.button !== 0) return;
      ovDrag = true;
      try { ov.setPointerCapture(e.pointerId); } catch (err) { /* seek still works */ }
      seekTo(ovFrac(e) * dur());
      ovShow(e);
    });
    ov.addEventListener('pointermove', (e) => {
      if (playState !== 'playing') return;
      ovShow(e);
      if (ovDrag) seekTo(ovFrac(e) * dur());
    });
    const ovEnd = (e) => {
      if (!ovDrag) return;
      ovDrag = false;
      try { ov.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    };
    ov.addEventListener('pointerup', ovEnd);
    ov.addEventListener('pointercancel', ovEnd);
    ov.addEventListener('pointerleave', () => { if (!ovDrag) $('ovTip').hidden = true; });
    // big canvas: click jumps relative to the centre line, drag scrubs like a platter
    let wdown = null;
    const wave = $('wave');
    wave.addEventListener('pointerdown', (e) => {
      if (playState !== 'playing' || !(dur() > 0) || e.button !== 0) return;
      const r = wave.getBoundingClientRect();
      wdown = { x: e.clientX, t: audio.currentTime, w: r.width || 1, l: r.left, moved: false };
      try { wave.setPointerCapture(e.pointerId); } catch (err) { /* seek still works */ }
      if (!wf) seekTo(clamp((e.clientX - r.left) / wdown.w, 0, 1) * dur());
    });
    wave.addEventListener('pointermove', (e) => {
      if (!wdown) return;
      const dx = e.clientX - wdown.x;
      if (Math.abs(dx) > 3) wdown.moved = true;
      if (!wf) seekTo(clamp((e.clientX - wdown.l) / wdown.w, 0, 1) * dur());
      else if (wdown.moved) seekTo(wdown.t - (dx / wdown.w) * WIN);
    });
    wave.addEventListener('pointerup', (e) => {
      if (wdown && wf && !wdown.moved) seekTo(wdown.t + ((e.clientX - wdown.l) / wdown.w - 0.5) * WIN);
      wdown = null;
    });
    wave.addEventListener('pointercancel', () => { wdown = null; });
    // keys while a track is loaded: Space pause, Left/Right seek 5 s, Up/Down volume
    const keyOk = (e) => {
      if (playState !== 'playing' || !audio || $('panel').hidden === false || $('firstRun').open) return false;
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'SELECT' || tag === 'TEXTAREA') return false;
      if (tag === 'INPUT' && t.type !== 'range') return false;
      if (tag === 'INPUT' && e.key.startsWith('Arrow')) return false; // a focused slider keeps its own arrow keys
      return true;
    };
    document.addEventListener('keydown', (e) => {
      if (!keyOk(e)) return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); if (!e.repeat) togglePause(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(audio.currentTime - 5); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(audio.currentTime + 5); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(volume + 5, true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(volume - 5, true); }
    });
    // a focused button would also "click" on Space release: keep that from stopping the track
    document.addEventListener('keyup', (e) => { if ((e.key === ' ' || e.code === 'Space') && keyOk(e)) e.preventDefault(); });
    window.addEventListener('beforeunload', () => { try { window.tc.playStop(); } catch (err) { /* closing anyway */ } });
    $('stop').addEventListener('click', () => { $('status').textContent = 'Stopping...'; window.tc.stop(); });
    $('openOut').addEventListener('click', () => window.tc.openFolder('out'));
    // ---- drag and drop ----
    let dragDepth = 0;
    const hint = (on) => { $('dropHint').hidden = !on; };
    document.addEventListener('dragenter', (e) => { e.preventDefault(); if (!running) { dragDepth += 1; hint(true); } });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hint(false); });
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      hint(false);
      if (running) return;
      const list = Array.from(e.dataTransfer.files).map((f) => window.tc.pathForFile(f)).filter(Boolean);
      const r = await window.tc.dropPaths(list);
      if (r.kind === 'folder') {
        state.settings = r.settings;
        $('inDir').value = r.dir;
        setDropped(0);
      } else if (r.kind === 'files') {
        setDropped(r.count);
      } else {
        setDropped(0); // the app side has dropped its selection too
        addMessage('Nothing to convert in what was dropped (music files or a folder are expected).', 'error');
      }
    });
    $('droppedClear').addEventListener('click', () => { window.tc.clearDropped(); setDropped(0); });

    let updateUrl = '';
    $('update').addEventListener('click', async () => {
      if (updateUrl) { window.tc.openExternal(updateUrl); return; }
      $('updateMsg').textContent = 'Checking...';
      const r = await window.tc.checkUpdate();
      if (!r || !r.ok) { $('updateMsg').textContent = (r && r.error) || 'Could not check.'; return; }
      if (r.newer) {
        $('updateMsg').textContent = `Version ${r.latest} is available.`;
        $('update').textContent = 'Open download page';
        updateUrl = r.url;
      } else {
        $('updateMsg').textContent = 'You have the latest version.';
      }
    });
    $('help').addEventListener('click', () => window.tc.openExternal(HELP_URL));

    $('locate').addEventListener('click', async () => { const ff = await window.tc.pickFfmpeg(); if (ff) applyFfmpeg(ff); });
    $('copyCmd').addEventListener('click', async () => {
      $('dlStatus').textContent = (await window.tc.copyInstallCommand()) ? 'Copied.' : 'Could not copy; select the text above instead.';
    });
    $('brewSite').addEventListener('click', () => window.tc.openExternal('https://brew.sh/'));
    $('recheck').addEventListener('click', async () => applyFfmpeg(await window.tc.recheckFfmpeg()));
    $('download').addEventListener('click', async () => {
      downloading = true;
      $('download').disabled = true;
      $('stop').disabled = false;
      $('dlStatus').textContent = 'Starting download...';
      const r = await window.tc.downloadFfmpeg();
      downloading = false;
      $('download').disabled = false;
      $('stop').disabled = !running;
      if (r.ok) { $('dlStatus').textContent = ''; applyFfmpeg({ found: r.found, mp3: r.mp3, path: r.path }); }
      else $('dlStatus').textContent = r.error || 'Download failed.';
    });
  }

  // On short windows the whole UI is scaled down (Electron zoom) instead of scrolling; the track list gets LOG_MIN px.
  const LOG_MIN = 140;
  let zoomNow = 1;
  let lastPhys = { w: 0, h: 0 };
  // The narrow/tiny layouts follow the PHYSICAL window width, so zooming (which changes the CSS width) can never flip the layout
  // back and forth while the zoom is being fitted.
  function layoutMode() {
    const physW = Math.round(window.innerWidth * zoomNow);
    document.documentElement.classList.toggle('narrow', physW < 700);
    document.documentElement.classList.toggle('tiny', physW < 380);
  }

  function fitZoom(force) {
    layoutMode();
    if (!window.tc || !window.tc.setZoom || $('mainView').hidden) return;
    const phys = { w: Math.round(window.innerWidth * zoomNow), h: Math.round(window.innerHeight * zoomNow) };
    // A resize we caused ourselves by zooming leaves the physical window size unchanged: ignore it (no feedback loop).
    if (!force && Math.abs(phys.w - lastPhys.w) < 2 && Math.abs(phys.h - lastPhys.h) < 2) return;
    lastPhys = phys;
    const app = document.querySelector('.app');
    const log = document.querySelector('.log');
    const needed = app.scrollHeight - log.offsetHeight + LOG_MIN; // CSS px, independent of the current zoom
    const raw = Math.floor((phys.h / needed) * 100) / 100;
    // Below the zoom floor nothing more can be shrunk: let the page scroll rather than clip controls.
    document.documentElement.classList.toggle('overflow', raw < 0.7);
    const f = Math.min(1, Math.max(0.7, raw));
    if (Math.abs(f - zoomNow) < 0.01) return;
    if (window.tc.setZoom(f)) zoomNow = f;
  }

  init();
})();
