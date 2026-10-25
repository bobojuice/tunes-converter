'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./src/engine/settings');
const { findTools, hasMp3Encoder } = require('./src/engine/tools');
const { runBatch } = require('./src/engine/batch');
const { downloadFfmpeg } = require('./src/engine/download');

let win = null;
const { rendererSettingsChanges, folderToOpen, createSlot, classifyDrop } = require('./src/engine/guards');
const { EXTENSIONS } = require('./src/engine/batch');
const { fetchLatest } = require('./src/engine/update');

const batchSlot = createSlot();
let droppedFiles = [];
let dlAbort = null;

// Where settings and the log live: next to the app on Windows (portable zip), otherwise the user's app-data folder.
function dataDir() {
  if (process.env.TC_DATA_DIR) return process.env.TC_DATA_DIR;
  if (app.isPackaged && process.platform === 'win32') {
    const beside = path.dirname(process.execPath);
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

function registerIpc() {
  ipcMain.handle('app:getState', async (event) => {
    if (!trusted(event)) return null;
    const s = current();
    const t = await toolState(s);
    return {
      settings: s,
      ffmpeg: { found: Boolean(t.tools), mp3: t.encoder, path: t.tools ? t.tools.ffmpeg : '' },
      platform: process.platform,
      version: require('./package.json').version,
      dataDir: paths().dir
    };
  });

  ipcMain.handle('settings:update', (event, changes) => {
    const safe = rendererSettingsChanges(changes);
    if (!trusted(event) || !safe) return null;
    return settings.save(paths().settings, base(), safe);
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
      return { kind: 'folder', dir: r.dir, settings: s };
    }
    return r.kind === 'files' ? { kind: 'files', count: r.files.length } : { kind: 'none' };
  });

  ipcMain.handle('drop:clear', (event) => {
    if (trusted(event)) droppedFiles = [];
  });

  ipcMain.handle('app:checkUpdate', async (event) => {
    if (!trusted(event)) return null;
    return fetchLatest(require('./package.json').version);
  });

  ipcMain.handle('batch:start', async (event, { inDir, outDir, useDropped } = {}) => {
    if (!trusted(event)) return { ok: false };
    const ctrl = batchSlot.take(); // reserved before any await, so Stop works during preparation and starts cannot overlap
    if (!ctrl) return { ok: false };
    try {
      const s = settings.save(paths().settings, base(), { In: inDir, Out: outDir });
      const t = await toolState(s);
      if (ctrl.signal.aborted) return { ok: false, cancelled: true };
      try { fs.writeFileSync(paths().log, ''); } catch { /* best effort */ }
      return await runBatch({
        inDir: s.In, outDir: s.Out, settings: s, tools: t.tools, signal: ctrl.signal,
        inputs: useDropped ? droppedFiles : undefined,
        onEvent: (ev) => {
          if (ev.type === 'message') appendLog(ev.text);
          if (ev.type === 'result') appendLog(`${ev.status.padEnd(6)}${ev.name}  ${ev.note}`);
          send('batch:event', ev);
        }
      });
    } finally {
      if (useDropped) droppedFiles = [];
      batchSlot.release(ctrl);
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
  win = new BrowserWindow({
    width: current().WinW,
    height: current().WinH,
    minWidth: 720,
    minHeight: 700,
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
      const b = win.getNormalBounds();
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
    batchSlot.abort();
    app.quit();
  });
  return app.whenReady().then(() => {
    const w = createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
    return w;
  });
}

if (!process.env.TC_NO_AUTOSTART) start();

module.exports = { start, createWindow };
