const {
  app,
  Tray,
  Menu,
  powerMonitor,
  BrowserWindow,
  ipcMain,
  dialog,
  net
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const screenshot = require('screenshot-desktop');
const AutoLaunch = require('auto-launch');
const fs = require('fs');
const sharp = require('sharp');

require('dotenv').config({
  path: path.join(__dirname, '.env')
});
const { initPresence, leavePresence, publishStatusUpdate } = require('./ably');
const googleDrive = require('./googleDrive.js');

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

let isProcessingQueue = false;
let lastQueueProcessTime = 0;
const QUEUE_PROCESS_INTERVAL = 60000; // 1 minute
const MIN_PROCESS_INTERVAL = 30000; // 30 seconds minimum between runs

const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const logFile = require('fs').createWriteStream(path.join(app.getPath('userData'), 'log.txt'), { flags: 'a' });
const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  logFile.write(line);
  console.log(...args);
};

/* ─── Screenshot Upload Queue path helpers ────────────────────────────────────────────────────── */
const queueDir = path.join(app.getPath('userData'), 'screenshot-queue');
if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });

/* ─── Offline Queue helpers form Idle time request ────────────────────────────────────────────────────── */
class IdleTimeQueue {
  constructor() {
    this.queuePath = path.join(app.getPath('userData'), 'idle-time-queue.json');
    this.currentSession = null;
    this.queue = this.loadQueue();
  }

  loadQueue() {
    try {
      return fs.existsSync(this.queuePath) ? 
        JSON.parse(fs.readFileSync(this.queuePath)) : [];
    } catch (e) {
      console.error('Error loading queue:', e);
      return [];
    }
  }

  saveQueue() {
    try {
      fs.writeFileSync(this.queuePath, JSON.stringify(this.queue));
    } catch (e) {
      console.error('Error saving queue:', e);
    }
  }

  startNewSession(startTime) {
    this.currentSession = {
      timeStart: startTime,
      pending: true
    };
  }

  completeSession(endTime, idleSeconds) {
    if (!this.currentSession) return;
    
    const session = {
      ...this.currentSession,
      timeEnd: endTime,
      totalIdleTime: idleSeconds,
      localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      pending: false
    };
    
    this.queue.push(session);
    this.saveQueue();
    this.currentSession = null;
  }

  async processQueue() {
    if (this.queue.length === 0) return;

    const successItems = [];
    const remainingItems = [];
    
    for (const item of this.queue) {
      try {
        const result = await this.sendSession(item);
        if (result.success) {
          successItems.push(item);
        } else {
          remainingItems.push(item);
        }
      } catch (err) {
        remainingItems.push(item);
        break; // Stop on first error
      }
    }

    if (successItems.length > 0) {
      this.queue = remainingItems;
      this.saveQueue();
      console.log(`✅ Sent ${successItems.length} queued idle sessions`);
    }
  }

  async sendSession(session) {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user-id': currentUserId
      },
      body: JSON.stringify({
        totalIdleTime: session.totalIdleTime,
        timeStart: formatLocalForServer(new Date(session.timeStart)),
        timeEnd: formatLocalForServer(new Date(session.timeEnd)),
        localTimezone: session.localTimezone
      })
    };

    try {
      const res = await fetch(`${process.env.SERVER_URL}/idle-time`, options);
      if (!res.ok) throw new Error(await res.text());
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  hasItems() {
    return this.queue.length > 0;
  }

  itemCount() {
    return this.queue.length;
  }
}

const idleTimeQueue = new IdleTimeQueue();

// Queue process function
function initializeQueueProcessing() {
  // Process queue immediately if there are items and we're online
  processQueueIfNeeded();

  // Set up periodic processing
  const queueInterval = setInterval(processQueueIfNeeded, QUEUE_PROCESS_INTERVAL);

  // Clean up on app quit
  app.on('will-quit', async () => {
    clearInterval(queueInterval);
    await processQueueOnExit();
  });
}

async function processQueueIfNeeded() {
  if (shouldSkipQueueProcessing()) return;

  isProcessingQueue = true;
  try {
    const online = await checkInternetConnection();
    if (online && idleTimeQueue.hasItems()) {
      //log(`🔄 Processing ${idleTimeQueue.itemCount()} queued idle sessions`);
      await idleTimeQueue.processQueue();
      lastQueueProcessTime = Date.now();
      //log(`✅ Queue processed (${idleTimeQueue.itemCount()} remaining)`);
    }
  } catch (err) {
    console.error('Queue processing error:', err);
  } finally {
    isProcessingQueue = false;
  }
}
async function checkInternetConnection() {
  return new Promise((resolve) => {
    try {
      const request = net.request({
        method: 'HEAD',
        url: 'https://www.google.com',
        timeout: 5000
      });
      
      request.on('response', () => {
        request.abort();
        resolve(true);
      });
      
      request.on('error', () => resolve(false));
      request.on('timeout', () => {
        request.abort();
        resolve(false);
      });
      
      request.end();
    } catch (err) {
      console.error('Connection check error:', err);
      resolve(false);
    }
  });
}

function shouldSkipQueueProcessing() {
  const now = Date.now();
  return (
    isProcessingQueue ||
    !currentUserId ||
    !idleTimeQueue.hasItems() ||
    (now - lastQueueProcessTime < MIN_PROCESS_INTERVAL)
  );
}

async function processQueueOnExit() {
  if (!currentUserId || isProcessingQueue) return;
  
  try {
    const online = await checkInternetConnection();
    if (online && idleTimeQueue.hasItems()) {
      log(`🚪 Processing ${idleTimeQueue.itemCount()} items before exit...`);
      await idleTimeQueue.processQueue();
      log(`🏁 Exit processing completed (${idleTimeQueue.itemCount()} remaining)`);
    }
  } catch (err) {
    console.error('Exit queue processing error:', err);
  }
}
// Queue process function

/* ─── Offline Queue helpers END ────────────────────────────────────────────────────── */


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
    //alwaysOnTop: true,
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

// Enhanced sendToServer with offline support
async function sendToServer(endpoint, data = {}) {
  if (!currentUserId) {
    console.warn(`🔒 Skipped ${endpoint} — not logged in`);
    return { success: false, message: 'Not logged in' };
  }

  try {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user-id': currentUserId
      },
      body: JSON.stringify(data),
      timeout: 10000
    };

    const res = await fetch(`${process.env.SERVER_URL}/${endpoint}`, options);
    
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(errorText || `HTTP error ${res.status}`);
    }
    
    const responseData = await res.json();
    console.log(`✅ ${endpoint}: Success`);
    return responseData;
  } catch (err) {
    console.error(`❌ ${endpoint} failed:`, err.message);
    throw err;
  }
}
// Helper function for fetch with timeout


async function takeScreenshot() {
  //log('📸 Taking screenshot...');
  try {
    const imgBuf = await screenshot({ format: 'png' });
    //log('✅ Screenshot captured. Size:', imgBuf.length);

    const buf = await sharp(imgBuf)
      .resize({ width: 1280 })
      .jpeg({ quality: 70, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toBuffer();
    //log('✅ Screenshot compressed. Size:', buf.length);

    const now = new Date();
    const timestamp = now.getFullYear() +
                      '-' + String(now.getMonth() + 1).padStart(2, '0') +
                      '-' + String(now.getDate()).padStart(2, '0') +
                      '_' + String(now.getHours()).padStart(2, '0') +
                      '-' + String(now.getMinutes()).padStart(2, '0') +
                      '-' + String(now.getSeconds()).padStart(2, '0');
    
    // Sanitize username to be filesystem-friendly
    const safeUsername = (currentUserName || 'UNKNOWN_USER').replace(/[\\/\\:\\*\?"<>\|]/g, '_');

    const fileName = `${safeUsername}_${timestamp}.jpg`;
    const uploaded = await googleDrive.uploadScreenshot(buf, fileName);

    if (!uploaded) {
      const filePath = path.join(queueDir, fileName);
      fs.writeFileSync(filePath, buf);
      //log('📦 Stored for retry:', fileName);
    }

  } catch (e) {
    log('❌ Screenshot capture error:', e.message);
  }

  //retryQueuedScreenshots();
}

let isRetryingScreenshots = false;
async function retryQueuedScreenshots() {
  if (isRetryingScreenshots) {
    // console.log('[Queue] Retry process already running, skipping.');
    return;
  }

  isRetryingScreenshots = true;
  try {
    const files = fs.readdirSync(queueDir);
    if (!files.length) {
      return;
    }

    // console.log(`[Queue] Retrying ${files.length} screenshots...`);
    for (const file of files) {
      const filePath = path.join(queueDir, file);
      if (!fs.existsSync(filePath)) {
          continue; // Skip if file is already gone
      }
      
      try {
        const buf = fs.readFileSync(filePath);
        const ok = await googleDrive.uploadScreenshot(buf, file);
        if (ok) {
          fs.unlinkSync(filePath);
          console.log('🧹 Removed from queue:', file);
        } else {
          console.log('[Queue] Upload failed, will retry later.');
          break;
        }
      } catch (err) {
        console.error(`[Queue] Error processing ${file}:`, err);
      }
    }
  } finally {
    isRetryingScreenshots = false;
  }
}

// Helper function to format local time for server
function formatLocalForServer(date) {
  const pad = num => String(num).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':');
}





let idleTimeCounter = 0; // Tracks idle time AFTER threshold is exceeded
let thresholdExceededTime = null;
function monitorActivity() {
  setInterval(async () => {
    try {
      if (!currentUserId) return;

      const idleTime = powerMonitor.getSystemIdleTime();
      const now = Date.now();

      if (idleTime >= parseInt(process.env.IDLE_THRESHOLD)) {
        if (!isOnBreak) {
          // Start of new idle period
          isOnBreak = true;
          publishStatusUpdate('idle'); // <-- Add this line
          thresholdExceededTime = now - (idleTime * 1000) + (parseInt(process.env.IDLE_THRESHOLD) * 1000);
          idleTimeQueue.startNewSession(thresholdExceededTime);
          
          const localStartTime = new Date(thresholdExceededTime);
          log(`🧪 Idle threshold exceeded at ${localStartTime.toLocaleString()}`);
        }
        
        // Update current idle duration
        idleTimeCounter = Math.floor((now - thresholdExceededTime) / 1000);
      } else {
        if (isOnBreak) {
          // End of idle period
          const finalIdleDuration = Math.floor((now - thresholdExceededTime) / 1000);
          idleTimeCounter = finalIdleDuration;
          
          if (idleTimeCounter > 0) {
            idleTimeQueue.completeSession(now, idleTimeCounter);
          }
          
          // Reset for next idle period
          isOnBreak = false;
          publishStatusUpdate('active'); // <-- Add this line
          idleTimeCounter = 0;
          thresholdExceededTime = null;
        }
      }

      if (now - lastScreenshot > parseInt(process.env.SCREENSHOT_INTERVAL)) {
        await takeScreenshot();
        lastScreenshot = now;
      }
    } catch (err) {
      console.error('Activity monitor error:', err);
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
    { type: 'separator' },
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
          //console.log('Current auto-start entries:', result[key].values);
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
  initializeQueueProcessing();

  // Other listeners
  // powerMonitor.on('suspend', () => sendToServer('sleep'));
  // powerMonitor.on('resume', () => sendToServer('resume'));

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
      detail: 'Would you like to install the update?'
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    } else {
      BrowserWindow.getAllWindows().forEach(win => {
      if (win === loginWindow && win.isVisible()) {
        win.setAlwaysOnTop(true);
      }
    });
      log('🕓 User chose to install later.');
    }
  });
  //autoUpdater.checkForUpdatesAndNotify();

  setInterval(function(){
    autoUpdater.checkForUpdatesAndNotify();
  },600000)

  retryQueuedScreenshots();

});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // prevent quitting
});