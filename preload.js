'use strict';
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

// The only things the window can ask the app to do.
contextBridge.exposeInMainWorld('tc', {
  getState: () => ipcRenderer.invoke('app:getState'),
  updateSettings: (changes) => ipcRenderer.invoke('settings:update', changes),
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
  pickFfmpeg: () => ipcRenderer.invoke('dialog:pickFfmpeg'),
  recheckFfmpeg: () => ipcRenderer.invoke('ffmpeg:recheck'),
  downloadFfmpeg: () => ipcRenderer.invoke('ffmpeg:download'),
  startBatch: (inDir, outDir, useDropped) => ipcRenderer.invoke('batch:start', { inDir, outDir, useDropped: Boolean(useDropped) }),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  dropPaths: (list) => ipcRenderer.invoke('drop:paths', list),
  clearDropped: () => ipcRenderer.invoke('drop:clear'),
  copyInstallCommand: () => ipcRenderer.invoke('app:copyInstallCommand'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  // Scales the whole window content down on short screens (never below 0.7, never above 1).
  setZoom: (factor) => {
    const f = Number(factor);
    if (!Number.isFinite(f) || f < 0.7 || f > 1) return false;
    webFrame.setZoomFactor(f);
    return true;
  },
  exportPresets: () => ipcRenderer.invoke('presets:export'),
  importPresets: () => ipcRenderer.invoke('presets:import'),
  stop: () => ipcRenderer.invoke('batch:stop'),
  openFolder: (folder) => ipcRenderer.invoke('shell:openFolder', folder),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onBatchEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('batch:event', h);
    return () => ipcRenderer.removeListener('batch:event', h);
  },
  onWatchStatus: (cb) => {
    const h = (_e, st) => cb(st);
    ipcRenderer.on('watch:status', h);
    return () => ipcRenderer.removeListener('watch:status', h);
  },
  onDownloadProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('ffmpeg:progress', h);
    return () => ipcRenderer.removeListener('ffmpeg:progress', h);
  }
});
