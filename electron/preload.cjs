const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
    platform: process.platform,
    windowAction: action => ipcRenderer.invoke('window:action', action),
    copyText: value => ipcRenderer.invoke('clipboard:write', value),
    openExternal: url => ipcRenderer.invoke('external:open', url)
});
