'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only things the window can ask the app to do.
contextBridge.exposeInMainWorld('tc', {
  getState: () => ipcRenderer.invoke('app:getState'),
  updateSettings: (changes) => ipcRenderer.invoke('settings:update', changes),
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
  pickFfmpeg: () => ipcRenderer.invoke('dialog:pickFfmpeg'),
  recheckFfmpeg: () => ipcRenderer.invoke('ffmpeg:recheck'),
  downloadFfmpeg: () => ipcRenderer.invoke('ffmpeg:download'),
  startBatch: (inDir, outDir) => ipcRenderer.invoke('batch:start', { inDir, outDir }),
  stop: () => ipcRenderer.invoke('batch:stop'),
  openFolder: (folder) => ipcRenderer.invoke('shell:openFolder', folder),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onBatchEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('batch:event', h);
    return () => ipcRenderer.removeListener('batch:event', h);
  },
  onDownloadProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('ffmpeg:progress', h);
    return () => ipcRenderer.removeListener('ffmpeg:progress', h);
  }
});
