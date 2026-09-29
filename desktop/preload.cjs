const { contextBridge, ipcRenderer } = require('electron');

// 只向页面提供版本更新所需的四个操作；页面不能访问 Node 或文件系统。
contextBridge.exposeInMainWorld('nexusDesktop', Object.freeze({
  info: () => ipcRenderer.invoke('nexus:update-info'),
  saveFeed: (url) => ipcRenderer.invoke('nexus:update-save-feed', url),
  check: () => ipcRenderer.invoke('nexus:update-check'),
  install: () => ipcRenderer.invoke('nexus:update-install'),
  onUpdateState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('nexus:update-state', handler);
    return () => ipcRenderer.removeListener('nexus:update-state', handler);
  },
  chooseLocal: () => ipcRenderer.invoke('nexus:update-choose-local'),
  openProtocol: (url) => ipcRenderer.invoke('nexus:open-protocol', url),
  openExternal: (url) => ipcRenderer.invoke('nexus:open-external', url),
  retryLoad: () => ipcRenderer.invoke('nexus:retry-load')
}));
