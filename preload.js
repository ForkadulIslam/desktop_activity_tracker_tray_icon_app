const { contextBridge, ipcRenderer } = require('electron');

// Use process.env in main.js to inject this dynamically if needed
contextBridge.exposeInMainWorld('electronAPI', {
  sendLoginSuccess: (data) => ipcRenderer.send('login-success', data),
  sendLogout: () => ipcRenderer.send('logout'),
  getSession: () => ipcRenderer.invoke('get-session'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version')
});
contextBridge.exposeInMainWorld('env', {
  SERVER_URL: 'http://52.7.213.112/api'
  //SERVER_URL: 'http://attendance.test/api'
});