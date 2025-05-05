const {
  app,
  Tray,
  Menu,
  powerMonitor,
  BrowserWindow,
  ipcMain,
} = require('electron');
const path = require('path');
const screenshot = require('screenshot-desktop');
const AutoLaunch = require('auto-launch');
const fs = require('fs');
require('dotenv').config({
  path: path.join(__dirname, '.env')
});

let tray = null;
let loginWindow = null;
let isOnBreak = false;
let lastScreenshot = 0;
let currentUserId = null;
let currentUserName = null;

const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const logFile = require('fs').createWriteStream(path.join(app.getPath('userData'), 'log.txt'), { flags: 'a' });
const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  logFile.write(line);
  console.log(...args);
};

// Session persistence
function saveSession(userId, name) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ userId, name }));
}

function loadSession() {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SESSION_FILE));
    } catch (err) {
      console.error('Failed to read session file:', err);
    }
  }
  return null;
}

function clearSession() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
  }
}

// Create login window
function createLoginWindow() {
  if (loginWindow) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 300,
    height: 300,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  loginWindow.loadFile('auth.html');
  //loginWindow.webContents.openDevTools();

  loginWindow.on('close', (e) => {
    e.preventDefault();
    loginWindow.hide();
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

function toggleLoginWindow() {
  if (!loginWindow) {
    createLoginWindow();
  } else if (loginWindow.isVisible()) {
    loginWindow.hide();
  } else {
    loginWindow.show();
  }
}

async function sendToServer(endpoint) {
  if (!currentUserId) {
    console.warn(`🔒 Skipped ${endpoint} — not logged in`);
    return;
  }

  try {
    const res = await fetch(`${process.env.SERVER_URL}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user-id': currentUserId
      }
    });

    const data = await res.json();

    if (res.ok) {
      console.log(`✅ ${endpoint}: ${data.message}`);
    } else {
      console.warn(`⚠️ ${endpoint} failed: ${data.message}`);
    }
  } catch (err) {
    console.error(`❌ Failed to send ${endpoint}:`, err.message);
  }
}

async function takeScreenshot() {
  try {
    const img = await screenshot();
    // Upload logic if needed
  } catch (err) {
    console.error('❌ Screenshot error:', err.message);
  }
}

function monitorActivity() {
  setInterval(async () => {
    console.log(`🧪 Idle threshold: ${parseInt(process.env.IDLE_THRESHOLD)}`);
    log(`🧪 Idle threshold: ${parseInt(process.env.IDLE_THRESHOLD)}`);
    if (!currentUserId) return;

    const idleTime = powerMonitor.getSystemIdleTime();
    const now = Date.now();

    if (idleTime >= parseInt(process.env.IDLE_THRESHOLD)) {
      if (!isOnBreak) {
        await sendToServer('break-start');
        isOnBreak = true;
        log(`🧪 Break started`);
      }
    } else {
      if (isOnBreak) {
        await sendToServer('break-end');
        isOnBreak = false;
      }
    }

    if (now - lastScreenshot > parseInt(process.env.SCREENSHOT_INTERVAL)) {
      await takeScreenshot();
      lastScreenshot = now;
    }
  }, 30000);
}




// Handle login by IPC event
ipcMain.on('login-success', (event, { userId, name }) => {
  currentUserId = userId;
  currentUserName = name;
  saveSession(userId, name);
  console.log(`✅ Logged in as ${name} [${userId}]`);
  if (loginWindow) loginWindow.hide();
});

ipcMain.on('logout', () => {
  console.log(`👋 Logged out ${currentUserName}`);
  clearSession();
  currentUserId = null;
  currentUserName = null;
});

ipcMain.handle('get-session', () => {
  return {
    userId: currentUserId,
    name: currentUserName
  };
});






app.whenReady().then(() => {
  tray = new Tray(path.join(__dirname, 'tray.png'));
  tray.setToolTip('Activity Tracker');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Login Window', click: toggleLoginWindow },
    { label: 'Quit', click: () => app.quit() }
  ]));

  tray.on('click', toggleLoginWindow);

  const savedSession = loadSession();
  if (savedSession) {
    currentUserId = savedSession.userId;
    currentUserName = savedSession.name;
    console.log(`🔁 Restored session for ${currentUserName} [${currentUserId}]`);
  }

  createLoginWindow();
  monitorActivity();

  const autoLauncher = new AutoLaunch({ name: 'Techvenger Activity Tracker' });
  autoLauncher.enable().catch(console.error);

  powerMonitor.on('suspend', () => sendToServer('sleep'));
  powerMonitor.on('resume', () => sendToServer('resume'));

  const backgroundWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true
    }
  });
  backgroundWindow.loadURL('https://trends.google.com/tv/');
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // prevent quitting
});
