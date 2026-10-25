'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const BITRATES = [128, 160, 192, 224, 256, 320];
  const MIN_ORDER = [320, 256, 224, 192, 160, 128];
  const MODES = ['off', 'warn', 'skip'];
  const FORMATS = { mp3: 'MP3', m4a: 'AAC (M4A)', flac: 'FLAC', opus: 'Opus' };
  const FORMAT_ORDER = Object.keys(FORMATS);
  const MODE_LABEL = { off: 'Quality check: off', warn: 'Quality check: warn', skip: 'Quality check: skip fakes' };
  const MODE_TIP = {
    off: 'No quality check (fastest). Click to change.',
    warn: 'Convert everything but flag low-quality files. Click to change.',
    skip: 'Do not convert files below the minimum. Click to change.'
  };
  const HELP_URL = 'https://github.com/bobojuice/tunes-converter/blob/main/docs/HOWTO.md';

  let state = null;
  let running = false;
  let downloading = false;
  let droppedCount = 0;
  let runStart = 0;
  let ranOnce = false;

  const settings = () => state.settings;

  async function save(changes) {
    const next = await window.tc.updateSettings(changes);
    if (next) state.settings = next;
    renderChips();
  }

  function renderChips() {
    const s = settings();
    $('chipFormat').querySelector('.t').textContent = FORMATS[s.Format];
    $('chipFormat').title = 'Output format. Click to change.';
    $('chipRecurse').querySelector('.t').textContent = s.Recurse ? 'Subfolders: included' : 'Subfolders: off';
    $('chipRecurse').dataset.on = String(s.Recurse);
    $('chipRecurse').title = 'Also convert music in sub-folders, keeping the same folder layout. Click to change.';
    $('chipBitrate').querySelector('.t').textContent = s.Format === 'flac' ? 'Lossless' : `${s.Format === 'opus' ? Math.min(s.Bitrate, 256) : s.Bitrate} kbps`;
    $('chipBitrate').title = 'Output bitrate. Click to change.';
    $('chipRate').querySelector('.t').textContent = `${s.SampleRate / 1000} kHz`;
    $('chipRate').title = 'Output sample rate. Click to change.';
    $('chipMode').querySelector('.t').textContent = MODE_LABEL[s.QualityCheck];
    $('chipMode').dataset.mode = s.QualityCheck;
    $('chipMode').title = MODE_TIP[s.QualityCheck];
    $('chipMin').querySelector('.t').textContent = `Minimum: ${s.MinKbps} kbps`;
    $('chipMin').dataset.dim = String(s.QualityCheck === 'off');
    $('chipMin').title = 'Lowest real quality you accept (judged from the audio, not the file label). Click to change.';
  }

  function setRunning(value) {
    running = value;
    $('start').disabled = value;
    $('start').textContent = value ? 'Converting...' : ranOnce ? 'RUN AGAIN' : 'START';
    $('stop').disabled = !value && !downloading;
    for (const id of ['browseIn', 'browseOut', 'inDir', 'outDir', 'chipFormat', 'chipRecurse', 'chipBitrate', 'chipRate', 'chipMode', 'chipMin']) $(id).disabled = value;
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
    const tag = document.createElement('span');
    tag.className = `tag ${status.toLowerCase()}`;
    tag.textContent = status;
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = name || '';
    if (note) {
      const n = document.createElement('span');
      n.className = 'note';
      n.textContent = `  ${note}`;
      body.appendChild(n);
    }
    row.append(tag, body);
    addLine(row);
  }
  function clearLog() {
    $('log').textContent = '';
    $('log').hidden = true;
    $('empty').hidden = false;
  }

  function setProgress(index, total) {
    const pct = total ? Math.round((index / total) * 100) : 0;
    $('fill').style.width = `${pct}%`;
    $('track').setAttribute('aria-valuenow', String(pct));
    let eta = '';
    if (running && index > 0 && index < total) {
      const secs = Math.round(((Date.now() - runStart) / index) * (total - index) / 1000);
      eta = secs >= 90 ? ` - about ${Math.round(secs / 60)} min left` : ` - about ${Math.max(secs, 5)} s left`;
    }
    $('count').textContent = `${index} / ${total}${eta}`;
  }

  function onBatchEvent(ev) {
    if (ev.type === 'message') {
      addMessage(ev.text, ev.level);
      if (ev.level === 'summary' || ev.level === 'error') $('status').textContent = ev.text;
    } else if (ev.type === 'progress') {
      setProgress(ev.index, ev.total);
      if (ev.text) $('status').textContent = ev.text;
    } else if (ev.type === 'result') {
      addResult(ev);
    } else if (ev.type === 'done') {
      $('status').textContent = ev.summary;
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
      $('bannerText').textContent = 'Tunes Converter needs ffmpeg. With Homebrew (brew.sh), run this in Terminal, then press "Check again":';
      cmd.hidden = false;
      cmd.textContent = 'brew install ffmpeg';
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

  async function init() {
    state = await window.tc.getState();
    $('inDir').value = settings().In;
    $('outDir').value = settings().Out;
    $('version').textContent = `v${state.version}`;
    $('dataDir').textContent = state.dataDir;
    $('dataDir').title = `Settings and log are stored in ${state.dataDir}`;
    renderChips();
    renderBanner(state.ffmpeg);

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
    $('chipBitrate').addEventListener('click', () => save({ Bitrate: cycle(BITRATES.slice().reverse(), settings().Bitrate) }));
    $('chipFormat').addEventListener('click', () => save({ Format: cycle(FORMAT_ORDER, settings().Format) }));
    $('chipRecurse').addEventListener('click', () => save({ Recurse: !settings().Recurse }));
    $('chipRate').addEventListener('click', () => save({ SampleRate: settings().SampleRate === 44100 ? 48000 : 44100 }));
    $('chipMode').addEventListener('click', () => save({ QualityCheck: cycle(MODES, settings().QualityCheck) }));
    $('chipMin').addEventListener('click', () => save({ MinKbps: cycle(MIN_ORDER, settings().MinKbps) }));

    $('start').addEventListener('click', async () => {
      if (running) return;
      setRunning(true);
      runStart = Date.now();
      clearLog();
      setProgress(0, 0);
      $('status').textContent = 'Starting...';
      try {
        await window.tc.startBatch($('inDir').value.trim(), $('outDir').value.trim(), droppedCount > 0);
      } catch (err) {
        addMessage(`ERROR: ${err.message}`, 'error');
        $('status').textContent = `ERROR: ${err.message}`;
      } finally {
        ranOnce = true;
        setDropped(0);
        setRunning(false);
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
