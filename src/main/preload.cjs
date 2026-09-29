// Bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function listen(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  version: ipcRenderer.sendSync('app:version'),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  probe: (paths) => ipcRenderer.invoke('media:probe', paths),
  prepareMedia: (media) => ipcRenderer.invoke('media:prepare', media),
  onMediaUpdate: (cb) => listen('media:update', cb),

  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (args) => ipcRenderer.invoke('project:save', args),

  pickExportPath: (name) => ipcRenderer.invoke('export:pick', name),
  startExport: (args) => ipcRenderer.invoke('export:start', args),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => listen('export:progress', cb),

  onCommand: (cb) => listen('menu:command', cb),
  setDirty: (dirty) => ipcRenderer.send('app:dirty', dirty),
  setTitle: (title) => ipcRenderer.send('app:title', title),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
});
