const { contextBridge, ipcRenderer } = require('electron');

// Use process.env in main.js to inject this dynamically if needed
contextBridge.exposeInMainWorld('electronAPI', {
  sendLoginSuccess: (data) => ipcRenderer.send('login-success', data),
  sendLogout: () => ipcRenderer.send('logout'),
  getSession: () => ipcRenderer.invoke('get-session'),
});

contextBridge.exposeInMainWorld('env', {
  SERVER_URL: 'http://3.109.202.213/api' // Replace this with actual value or inject from main.js
});