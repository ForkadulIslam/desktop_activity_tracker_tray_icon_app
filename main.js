const {
  app,
  Tray,
  Menu,
  powerMonitor,
  BrowserWindow,
  ipcMain,
  dialog,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const screenshot = require('screenshot-desktop');
const AutoLaunch = require('auto-launch');
const fs = require('fs');
require('dotenv').config({
  path: path.join(__dirname, '.env')
});
const { initPresence, leavePresence } = require('./ably');

// Ensure proper installation path
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  // Running from temp folder - warn user
  require('electron').dialog.showErrorBox(
    'Installation Error',
    'Please properly install the application instead of running from temporary location.'
  );
  app.quit();
}

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
    resizable: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
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
  initPresence(userId);
  console.log(`✅ Logged in as ${name} [${userId}]`);
  if (loginWindow) loginWindow.hide();
});

ipcMain.on('logout', () => {
  console.log(`👋 Logged out ${currentUserName}`);
  clearSession();
  currentUserId = null;
  currentUserName = null;
  leavePresence();
});

ipcMain.handle('get-session', () => {
  return {
    userId: currentUserId,
    name: currentUserName
  };
});
// Expose the version to renderer
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});






app.whenReady().then(() => {
  // Tray and other UI setup
  tray = new Tray(path.join(__dirname, 'tray.png'));
  tray.setToolTip('Activity Tracker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Login Window', click: toggleLoginWindow },
    //{ label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', toggleLoginWindow);

  // Windows-specific setup
  if (process.platform === 'win32') {
    app.setAppUserModelId('Techvenger Activity Tracker');
  }

  // Improved auto-launch
  const appLauncher = new AutoLaunch({
    name: 'Techvenger Activity Tracker',
    path: app.getPath('exe'), // Gets the correct installed path
    isHidden: true
  });

  // Remove any existing broken entries
  appLauncher.disable()
    .then(() => {
      // Create new correct entry
      return appLauncher.enable();
    })
    .then(() => {
      console.log('✅ Auto-start configured correctly');
      // Verify the registry entry
      verifyAutoStart();
    })
    .catch(err => {
      console.error('Auto-start error:', err);
      showManualInstallInstructions();
    });

    function verifyAutoStart() {
      const regedit = require('regedit');
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
      
      regedit.list(key, (err, result) => {
        if (!err) {
          console.log('Current auto-start entries:', result[key].values);
        }
      });
    }

    function showManualInstallInstructions() {
      const { dialog } = require('electron');
      dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        title: 'Installation Required',
        message: 'For auto-start to work:',
        detail: '1. Please install the application properly\n' +
                '2. Don\'t run from temporary location\n' +
                '3. Reinstall using the setup installer'
      });
    }

  // Network-aware session restore
  const savedSession = loadSession();
  if (savedSession) {
    currentUserId = savedSession.userId;
    currentUserName = savedSession.name;
    
    const tryInitPresence = () => {
      require('dns').resolve('www.google.com', (err) => {
        if (!err) {
          try {
            initPresence(savedSession.userId);
            log(`Restored session for ${currentUserName}`);
          } catch (err) {
            log('Presence init failed:', err);
          }
        } else {
          setTimeout(tryInitPresence, 5000);
        }
      });
    };
    
    tryInitPresence();
  }

  // Start monitoring
  createLoginWindow();
  monitorActivity();

  // Other listeners
  powerMonitor.on('suspend', () => sendToServer('sleep'));
  powerMonitor.on('resume', () => sendToServer('resume'));

  const backgroundWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true
    }
  });
  backgroundWindow.loadURL('https://trends.google.com/tv/');

  //Updater
  autoUpdater.on('checking-for-update', () => log('🔄 Checking for update...'));
  autoUpdater.on('update-available', (info) => log('📦 Update available:', info));
  autoUpdater.on('update-not-available', (info) => log('✅ No updates available:', info));
  autoUpdater.on('error', (err) => log('❌ Update error:', err));
  autoUpdater.on('download-progress', (progress) => log(`⬇️ Downloading: ${Math.round(progress.percent)}%`));
  autoUpdater.on('update-downloaded', () => {
    log('✅ Update downloaded.');
    const response = dialog.showMessageBoxSync({
      type: 'info',
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: 'A new version has been downloaded.',
      detail: 'Would you like to restart the app now to install the update?'
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    } else {
      log('🕓 User chose to install later.');
    }
  });
  autoUpdater.checkForUpdatesAndNotify();

});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // prevent quitting
});