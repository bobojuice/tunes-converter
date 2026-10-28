'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./src/engine/settings');
const { findTools, hasMp3Encoder } = require('./src/engine/tools');
const { runBatch } = require('./src/engine/batch');
const { buildReport, writeReport } = require('./src/engine/report');
const presetshare = require('./src/engine/presetshare');
const { createWatcher, watchAction, watchOutDirs } =require('./src/engine/watcher');
const { downloadFfmpeg } = require('./src/engine/download');

let win = null;
const { rendererSettingsChanges, folderToOpen, createSlot, classifyDrop, withTerminalEvent } = require('./src/engine/guards');
const { EXTENSIONS } = require('./src/engine/batch');
const { fetchLatest } = require('./src/engine/update');

const batchSlot = createSlot();
let droppedFiles = [];
let dlAbort = null;

// Where settings and the log live: next to the app on Windows (unzipped copy), otherwise the user's app-data folder.
function dataDir() {
  if (process.env.TC_DATA_DIR) return process.env.TC_DATA_DIR;
  // The installer puts an uninstaller beside the exe; an installed copy keeps its data in app data so it survives
  // updates and uninstalls. The unzipped copy has no uninstaller and keeps its data in its own folder.
  const beside = path.dirname(process.execPath);
  const installed = fs.existsSync(path.join(beside, `Uninstall ${app.getName()}.exe`));
  if (app.isPackaged && process.platform === 'win32' && !installed) {
    try {
      const probe = path.join(beside, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.rmSync(probe);
      return beside;
    } catch { /* read-only location, use app data */ }
  }
  return app.getPath('userData');
}

const paths = () => {
  const dir = dataDir();
  return { dir, settings: path.join(dir, 'settings.json'), log: path.join(dir, 'last-run.log'), bin: path.join(dir, 'bin') };
};
const base = () => settings.defaults(app.getPath('desktop'));
const current = () => settings.load(paths().settings, base());

async function toolState(s = current()) {
  const p = paths();
  const appBin = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
  const tools = findTools({ configuredDir: s.FfmpegDir, appDir: appBin, extraDirs: [p.bin] });
  const encoder = tools ? await hasMp3Encoder(tools.ffmpeg) : false;
  return { tools, encoder };
}

function appendLog(text) {
  try { fs.appendFileSync(paths().log, `${text}\n`); } catch { /* logging is best effort */ }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function trusted(event) {
  return win && event.sender === win.webContents;
}

// The shared run: used by START and by the folder watcher. The caller owns the slot (`ctrl`).
// A watch run has no START click waiting for a result, so every way it can end (early return, cancel, error) must still
// send the window a terminal event; withTerminalEvent guarantees that. START runs behave as before.
function executeBatch({ ctrl, s, inputs, resetLog, watch = false }) {
  const emit = (ev) => send('batch:event', ev);
  if (!watch) return runExecute({ ctrl, s, inputs, resetLog }, emit);
  return withTerminalEvent(emit, (onEv) => runExecute({ ctrl, s, inputs, resetLog }, onEv));
}

async function runExecute({ ctrl, s, inputs, resetLog }, emit) {
  const t = await toolState(s);
  if (ctrl.signal.aborted) return { ok: false, cancelled: true };
  if (resetLog) { try { fs.writeFileSync(paths().log, ''); } catch { /* best effort */ } }
  const startedAt = new Date();
  const results = [];
  const onEvent = (ev) => {
    if (ev.type === 'message') appendLog(ev.text);
    if (ev.type === 'result') { results.push(ev); appendLog(`${ev.status.padEnd(6)}${ev.name}  ${ev.note}`); }
    emit(ev);
  };
  const r = await runBatch({ inDir: s.In, outDir: s.Out, settings: s, tools: t.tools, signal: ctrl.signal, inputs, onEvent });
  if (s.SaveReport && results.length) saveRunReport(s, results, startedAt, r, onEvent);
  return r;
}

// Report file in the output folder; the data folder if that fails. Never changes the run's own result.
function saveRunReport(s, results, startedAt, r, onEvent) {
  const text = buildReport(results, { startedAt, summary: r && r.summary, format: s.Format });
  let file = '';
  for (const dir of [s.Out, paths().dir]) {
    try { file = writeReport(dir, text, startedAt); break; } catch { /* try the next folder */ }
  }
  const msg = file ? `Report saved: ${path.basename(file)}` : 'Could not save the report file.';
  if (file) appendLog(`Report saved: ${file}`);
  onEvent({ type: 'message', text: msg, level: file ? 'info' : 'error' });
}

// ---- watch folder: new music files in the songs folder are converted by the same pipeline ----
let watcher = null;
let watchKey = '';
let watchMissing = false; // the songs folder vanished while watching (it may come back)

// What the window shows: is the watch really running, and if the setting is on but it cannot run, why not.
let watchInfo = { active: false, reason: '' };
const watchStatus = () => watchInfo;

function setWatchInfo(info) {
  const changed = info.active !== watchInfo.active || info.reason !== watchInfo.reason;
  watchInfo = info;
  if (changed) send('watch:status', watchInfo);
}

function stopWatcher() {
  if (watcher) watcher.stop();
  watcher = null;
  watchKey = '';
  watchMissing = false;
}

function syncWatcher() {
  const s = current();
  const act = watchAction(s, { hasWatcher: Boolean(watcher), key: watchKey, missing: watchMissing });
  if (act.action === 'stop') { stopWatcher(); setWatchInfo(act.info); return; }
  if (act.action === 'keep') { setWatchInfo(act.info); return; } // also keeps a recovery watcher while the folder is missing
  stopWatcher();
  setWatchInfo(act.info);
  watchKey = act.key;
  watchMissing = !act.info.active;
  watcher = createWatcher({
    dir: s.In, recurse: s.Recurse, outDir: watchOutDirs(s),
    isBusy: () => batchSlot.busy,
    onLog: appendLog,
    onMissing: (gone) => {
      watchMissing = gone;
      setWatchInfo(gone ? { active: false, reason: 'songs folder missing' } : { active: true, reason: '' });
    },
    onFiles: async (files) => {
      const ctrl = batchSlot.take();
      if (!ctrl) return; // cannot happen after isBusy(); the files stay handled rather than looping
      try {
        for (const f of files) send('batch:event', { type: 'message', text: `Watching: new file ${path.basename(f)}`, level: 'info' });
        await executeBatch({ ctrl, s: current(), inputs: files.map((f) => ({ full: f, rel: path.dirname(path.relative(s.In, f)).replace(/^\.$/, '') })), resetLog: false, watch: true });
      } catch (err) {
        send('batch:event', { type: 'message', text: `ERROR: ${err.message}`, level: 'error' });
      } finally {
        batchSlot.release(ctrl);
      }
    }
  });
}

function registerIpc() {
  ipcMain.handle('app:getState', async (event) => {
    if (!trusted(event)) return null;
    const s = current();
    const t = await toolState(s);
    return {
      settings: s,
      ffmpeg: { found: Boolean(t.tools), mp3: t.encoder, path: t.tools ? t.tools.ffmpeg : '' },
      platform: process.platform,
      hasBrew: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].some((b) => fs.existsSync(b)),
      version: require('./package.json').version,
      dataDir: paths().dir,
      watch: watchStatus()
    };
  });

  ipcMain.handle('settings:update', (event, changes) => {
    const safe = rendererSettingsChanges(changes);
    if (!trusted(event) || !safe) return null;
    const next = settings.save(paths().settings, base(), safe);
    syncWatcher(); // starts, restarts (folder changed) or stops the folder watch as the settings say
    return next;
  });

  ipcMain.handle('dialog:pickFolder', async (event, { title, defaultPath } = {}) => {
    if (!trusted(event)) return null;
    const r = await dialog.showOpenDialog(win, {
      title: String(title || 'Choose a folder'),
      defaultPath: typeof defaultPath === 'string' && fs.existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFfmpeg', async (event) => {
    if (!trusted(event)) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose the folder that contains ffmpeg and ffprobe',
      properties: ['openDirectory']
    });
    if (r.canceled) return null;
    settings.save(paths().settings, base(), { FfmpegDir: r.filePaths[0] });
    const t = await toolState();
    return { found: Boolean(t.tools), mp3: t.encoder, path: t.tools ? t.tools.ffmpeg : '' };
  });

  ipcMain.handle('ffmpeg:recheck', async (event) => {
    if (!trusted(event)) return null;
    const t = await toolState();
    return { found: Boolean(t.tools), mp3: t.encoder, path: t.tools ? t.tools.ffmpeg : '' };
  });

  ipcMain.handle('ffmpeg:download', async (event) => {
    if (!trusted(event) || process.platform !== 'win32') return { ok: false, error: 'Automatic download is only offered on Windows.' };
    dlAbort = new AbortController();
    try {
      await downloadFfmpeg({
        destDir: paths().bin,
        signal: dlAbort.signal,
        onProgress: (done, total) => send('ffmpeg:progress', { done, total })
      });
      const t = await toolState();
      return { ok: Boolean(t.tools), found: Boolean(t.tools), mp3: t.encoder, path: t.tools ? t.tools.ffmpeg : '' };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      dlAbort = null;
    }
  });

  // Files or a folder dropped on the window. A folder becomes the songs folder; files are held for the next run.
  ipcMain.handle('drop:paths', (event, dropped) => {
    if (!trusted(event) || batchSlot.busy) return { kind: 'none' };
    const r = classifyDrop(dropped, EXTENSIONS);
    droppedFiles = r.kind === 'files' ? r.files : [];
    if (r.kind === 'folder') {
      const s = settings.save(paths().settings, base(), { In: r.dir });
      syncWatcher();
      return { kind: 'folder', dir: r.dir, settings: s };
    }
    return r.kind === 'files' ? { kind: 'files', count: r.files.length } : { kind: 'none' };
  });

  ipcMain.handle('drop:clear', (event) => {
    if (trusted(event)) droppedFiles = [];
  });

  // Only ever copies the one fixed command shown in the ffmpeg banner, never text from the window.
  ipcMain.handle('app:copyInstallCommand', (event) => {
    if (!trusted(event)) return false;
    clipboard.writeText('brew install ffmpeg');
    return true;
  });

  ipcMain.handle('app:checkUpdate', async (event) => {
    if (!trusted(event)) return null;
    return fetchLatest(require('./package.json').version);
  });

  ipcMain.handle('batch:start', async (event, { inDir, outDir, useDropped } = {}) => {
    if (!trusted(event)) return { ok: false };
    const ctrl = batchSlot.take(); // reserved before any await, so Stop works during preparation and starts cannot overlap
    if (!ctrl) return { ok: false };
    const inputs = useDropped ? droppedFiles.slice() : undefined; // snapshot before any await; [] means "nothing selected"
    try {
      const s = settings.save(paths().settings, base(), { In: inDir, Out: outDir });
      syncWatcher();
      return await executeBatch({ ctrl, s, inputs, resetLog: true });
    } finally {
      if (useDropped) droppedFiles = [];
      batchSlot.release(ctrl);
    }
  });

  // ---- share presets: JSON file through the native dialogs; the window never supplies a path ----
  ipcMain.handle('presets:export', async (event) => {
    if (!trusted(event)) return { ok: false };
    const list = current().Presets;
    if (!list.length) return { ok: false, error: 'No presets to export.' };
    const r = await dialog.showSaveDialog(win, {
      title: 'Export presets',
      defaultPath: path.join(app.getPath('documents'), 'Tunes Converter presets.json'),
      filters: [{ name: 'Presets', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
    try {
      fs.writeFileSync(r.filePath, presetshare.serialize(list));
      return { ok: true, count: list.length };
    } catch (err) {
      return { ok: false, error: `Could not write the file: ${err.message}` };
    }
  });

  ipcMain.handle('presets:import', async (event) => {
    if (!trusted(event)) return { ok: false };
    const r = await dialog.showOpenDialog(win, {
      title: 'Import presets',
      properties: ['openFile'],
      filters: [{ name: 'Presets', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    try {
      if (fs.statSync(r.filePaths[0]).size > presetshare.MAX_FILE_BYTES) throw new Error('That file is too large to be a preset file.');
      const incoming = presetshare.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const m = presetshare.merge(current().Presets, incoming);
      const next = settings.save(paths().settings, base(), { Presets: m.presets });
      return { ok: true, added: m.added, skipped: m.skipped, settings: next };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('batch:stop', (event) => {
    if (!trusted(event)) return;
    batchSlot.abort();
    if (dlAbort) dlAbort.abort();
  });

  // The window names a saved folder ('in' or 'out'); it never supplies a path, and only a directory is opened.
  ipcMain.handle('shell:openFolder', async (event, which) => {
    if (!trusted(event)) return false;
    const dir = folderToOpen(which, current());
    if (!dir) return false;
    // Reveal only: openPath would launch a macOS .app bundle (a directory) through LaunchServices.
    shell.showItemInFolder(dir);
    return true;
  });

  ipcMain.handle('shell:openExternal', (event, url) => {
    if (!trusted(event) || typeof url !== 'string') return false;
    const allowed = ['https://github.com/bobojuice/tunes-converter', 'https://ffmpeg.org/', 'https://www.gyan.dev/ffmpeg/builds/', 'https://brew.sh/'];
    if (!allowed.some((a) => url.startsWith(a))) return false;
    shell.openExternal(url);
    return true;
  });
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  // Never larger than the screen's usable area, and always placed fully on it (centered on the primary display).
  const wa = screen.getPrimaryDisplay().workArea;
  const saved = current();
  const minW = 720;
  const minH = 680; // below this even the 0.7 zoom floor would clip the controls
  const width = Math.min(Math.max(saved.WinW, Math.min(minW, wa.width)), wa.width);
  const height = Math.min(Math.max(saved.WinH, Math.min(minH, wa.height)), wa.height);
  win = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    minWidth: Math.min(minW, wa.width),
    minHeight: Math.min(minH, wa.height),
    show: false,
    title: 'Tunes Converter',
    icon: fs.existsSync(path.join(__dirname, 'build', 'icon.png')) ? path.join(__dirname, 'build', 'icon.png') : undefined,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    try {
      const b = win.getNormalBounds(); // the saved size is clamped to the screen again on the next start
      settings.save(paths().settings, base(), { WinW: b.width, WinH: b.height });
    } catch { /* remembering the size is best effort */ }
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  return win;
}

function start() {
  // The OS sandbox stays on everywhere. If a Linux system cannot start it, the user can launch with --no-sandbox
  // (see docs/HOWTO.md troubleshooting).
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  registerIpc();
  app.on('window-all-closed', () => {
    stopWatcher();
    batchSlot.abort();
    app.quit();
  });
  app.on('before-quit', stopWatcher);
  return app.whenReady().then(() => {
    const w = createWindow();
    syncWatcher();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
    return w;
  });
}

if (!process.env.TC_NO_AUTOSTART) start();

module.exports = { start, createWindow };
