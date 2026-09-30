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
  openLocalApp: (appId) => ipcRenderer.invoke('nexus:open-local-app', appId),
  openExternal: (url) => ipcRenderer.invoke('nexus:open-external', url),
  accountServerInfo: () => ipcRenderer.invoke('nexus:account-server-info'),
  accountServerSave: (url) => ipcRenderer.invoke('nexus:account-server-save', url),
  accountRegister: (username, password) => ipcRenderer.invoke('nexus:account-register', username, password),
  accountLogin: (username, password) => ipcRenderer.invoke('nexus:account-login', username, password),
  accountLogout: () => ipcRenderer.invoke('nexus:account-logout'),
  accountSession: () => ipcRenderer.invoke('nexus:account-session'),
  accountWorkspace: () => ipcRenderer.invoke('nexus:account-workspace'),
  accountSave: (revision, data) => ipcRenderer.invoke('nexus:account-save', revision, data),
  retryLoad: () => ipcRenderer.invoke('nexus:retry-load')
}));
