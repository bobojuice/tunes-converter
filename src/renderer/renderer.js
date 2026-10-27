'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const BITRATES = [128, 160, 192, 224, 256, 320];
  const MODES = ['off', 'warn', 'skip'];
  const FORMATS = { mp3: 'MP3', m4a: 'AAC (M4A)', flac: 'FLAC', wav: 'WAV', aiff: 'AIFF', opus: 'Opus' };
  const LOSSLESS = ['flac', 'wav', 'aiff'];
  const PRESET_KEYS = ['Format', 'Bitrate', 'SampleRate', 'QualityCheck', 'MinKbps', 'BitDepth', 'NameTemplate', 'TagMode', 'Recurse', 'CoverArt', 'JoinArtists', 'ClipCheck', 'DuplicateMode'];
  const SHORT = { mp3: 'MP3', m4a: 'AAC', flac: 'FLAC', wav: 'WAV', aiff: 'AIFF', opus: 'OPUS' };
  const MODE_LABEL = { off: 'OFF', warn: 'WARN', skip: 'SKIP' };
  const MODE_TIP = {
    off: 'Quality check: off (fastest). Click to change.',
    warn: 'Quality check: convert everything but flag low-quality files. Click to change.',
    skip: 'Quality check: do not convert files below the minimum. Click to change.'
  };
  const COL = { blue: '#2EA7FF', dim: '#1C6FA8', orange: '#FF8A1F', red: '#FF5C7A', pink: '#FF7AD9' };
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
    renderPresets();
    for (const el of document.querySelectorAll('#panel [data-show]')) {
      const kind = el.dataset.show;
      el.hidden = kind === 'depth' ? !LOSSLESS.includes(s.Format)
        : kind === 'lossy' ? LOSSLESS.includes(s.Format)
          : $('setName').value !== 'custom';
    }
    renderControls();
    renderReadouts();
    renderMeter();
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
    const frac = lossless ? (at === 0 ? 1 / 3 : 2 / 3) : values.length > 1 ? at / (values.length - 1) : 0;
    const ang = -135 + frac * 270;
    $('knobPtr').style.setProperty('--ang', ang + 'deg');
    $('knobVal').textContent = String(cur);
    $('knobLo').textContent = String(values[0]);
    $('knobHi').textContent = String(values[values.length - 1]);
    const label = lossless ? `Bit depth ${cur}` : `Bitrate ${cur} kbps`;
    $('knob').setAttribute('aria-label', `${label}. Click to change.`);
    $('knob').title = `${label}. Click to change.`;
    const ticks = $('knobTicks');
    if (!ticks.childNodes.length) {
      for (let i = 0; i < 9; i++) {
        const t = document.createElement('b');
        const a = ((-135 + i * 33.75) * Math.PI) / 180;
        t.style.left = `${Math.round(40 + 38 * Math.sin(a) - 2)}px`;
        t.style.top = `${Math.round(40 - 38 * Math.cos(a) - 2)}px`;
        ticks.appendChild(t);
      }
    }
    const lit = Math.round((ang + 135) / 33.75);
    Array.from(ticks.children).forEach((t, i) => t.classList.toggle('on', i === lit));
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
      $('hubLabel').textContent = 'READY';
      $('hubBig').textContent = SHORT[s.Format];
      $('count').textContent = '';
    }
  }

  // ---- peak meter: 20 segments (13 green, 4 amber, 3 red), -30 dB .. 0 dB ----
  function renderMeter() {
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
    for (const el of document.querySelectorAll('#panel [data-key], #setName, #presetList, #presetName, #presetSave')) el.disabled = value;
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

  function drawWave() {
    const f = fitCanvas($('wave'));
    if (!f) return;
    const { ctx, w, h } = f;
    const p = playFraction();
    const idle = phase === 'idle';
    for (let i = 0; i < 25; i++) {
      ctx.fillStyle = i % 4 === 0 ? COL.red : '#6B8A92';
      const x = Math.round((i / 24) * (w - 1));
      ctx.fillRect(x, 0, 1, 6);
      ctx.fillRect(x, h - 6, 1, 6);
    }
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

  function addFlag(res) {
    const note = `${res.note || ''}`;
    let color = null;
    let why = '';
    if (/clipping|over 0|dBFS/i.test(note)) { color = COL.red; why = 'clipping'; }
    else if (/duplicate/i.test(note)) { color = COL.orange; why = 'duplicate'; }
    else if (['WARN', 'LOW', 'FAKE'].includes(res.status)) { color = COL.pink; why = `quality ${res.status}`; }
    if (!color) return;
    const n = flags.length;
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
  function addResult({ status, name, note }) {
    const row = document.createElement('div');
    row.className = 'row-log';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = pad2(resultCount);
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
  }
  function clearLog() {
    $('log').textContent = '';
    $('log').hidden = true;
    $('empty').hidden = false;
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

  function onBatchEvent(ev) {
    if (ev.type === 'message') {
      addMessage(ev.text, ev.level);
      if (ev.level === 'summary' || ev.level === 'error') $('status').textContent = ev.text;
    } else if (ev.type === 'progress') {
      setProgress(ev.index, ev.total);
      // the screen title is the file being converted
      if (ev.text) $('status').textContent = /^Converting \d+ of/.test(ev.text) && ev.file ? ev.file : ev.text;
    } else if (ev.type === 'result') {
      resultCount += 1;
      addResult(ev);
      addFlag(ev);
      // a converted track with no reading (silent file) clears the meter; skipped or failed ones leave it alone
      if (ev.status === 'OK' || ev.status === 'WARN') lastPeak = typeof ev.peak === 'number' ? ev.peak : null;
      renderMeter();
      renderReadouts();
    } else if (ev.type === 'done') {
      const c = ev.counts || {};
      phase = ev.stopped ? 'stopped' : (c.OK || 0) + (c.WARN || 0) === 0 && (c.FAIL || 0) > 0 ? 'failed' : 'done';
      etaSecs = null;
      renderReadouts();
      drawAll();
      $('status').textContent = ev.summary;
      if (settings().OpenWhenDone && !ev.stopped) window.tc.openFolder('out');
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
    window.tc.onDownloadProgress(({ done, total }) => {
      const mb = (n) => (n / 1048576).toFixed(0);
      $('dlStatus').textContent = total ? `Downloading... ${mb(done)} / ${mb(total)} MB` : `Downloading... ${mb(done)} MB`;
    });

    $('browseIn').addEventListener('click', async () => {
      const p = await window.tc.pickFolder({ title: 'Choose the folder with your music', defaultPath: $('inDir').value });
      if (p) { $('inDir').value = p; save({ In: p }); }
    });
    $('browseOut').addEventListener('click', async () => {
      const p = await window.tc.pickFolder({ title: 'Choose where to save the MP3s', defaultPath: $('outDir').value });
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
    $('gear').addEventListener('click', () => {
      const open = $('panel').hidden;
      $('panel').hidden = !open;
      $('gear').setAttribute('aria-expanded', String(open));
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
      if (settings().NameTemplate !== typed) $('nameHelp').textContent = 'Not accepted. Use only {artist} {title} {album} {albumartist} {track} {year} with your own text around them.';
    });
    $('presetList').addEventListener('change', async () => {
      const p = (settings().Presets || []).find((x) => x.name === $('presetList').value);
      $('presetMsg').textContent = '';
      if (p) { await save(p.options); $('presetMsg').textContent = `Loaded "${p.name}".`; }
      renderPresets();
    });
    $('presetSave').addEventListener('click', savePreset);
    $('presetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePreset(); });
    $('presetDelete').addEventListener('click', async () => {
      const name = $('presetList').value;
      if (!name) return;
      await save({ Presets: (settings().Presets || []).filter((p) => p.name !== name) });
      $('presetMsg').textContent = `Deleted "${name}".`;
      renderPresets('');
    });
    for (const el of document.querySelectorAll('#panel [data-key]')) {
      if (el.id === 'setNameTemplate') continue;
      el.addEventListener('change', () => {
        const value = el.type === 'checkbox' ? el.checked : el.hasAttribute('data-number') ? Number(el.value) : el.value;
        save({ [el.dataset.key]: value });
      });
    }
    for (const pad of document.querySelectorAll('#pads .pad')) pad.addEventListener('click', () => save({ Format: pad.dataset.fmt }));
    for (const opt of document.querySelectorAll('.opt')) opt.addEventListener('click', () => save({ [opt.dataset.opt]: !settings()[opt.dataset.opt] }));
    $('roQuality').addEventListener('click', () => save({ QualityCheck: cycle(MODES, settings().QualityCheck) }));
    window.addEventListener('resize', drawAll);
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

  init();
})();
