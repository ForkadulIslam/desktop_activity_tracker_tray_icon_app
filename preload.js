const { contextBridge, ipcRenderer } = require('electron');

// Use process.env in main.js to inject this dynamically if needed
contextBridge.exposeInMainWorld('electronAPI', {
  sendLoginSuccess: (data) => ipcRenderer.send('login-success', data),
  sendLogout: () => ipcRenderer.send('logout'),
  getSession: () => ipcRenderer.invoke('get-session'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version')
});
contextBridge.exposeInMainWorld('env', {
  SERVER_URL: 'http://3.109.202.213/api'
});