import { app, BrowserWindow, screen } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import { getConfig, saveWindowState } from './store';
import { createTray, updateTrayMenu, destroyTray } from './tray';
import { registerShortcuts, registerWindowShortcuts, unregisterShortcuts } from './shortcuts';
import { killAllPtys } from './pty-manager';

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

function getWindow(): BrowserWindow | null {
  return mainWindow;
}

function createWindow(): void {
  const config = getConfig();
  const { window: windowState } = config;

  // Validate saved position is still on a visible display
  let validPosition = false;
  if (windowState.x !== undefined && windowState.y !== undefined) {
    const displays = screen.getAllDisplays();
    validPosition = displays.some(display => {
      const bounds = display.bounds;
      return (
        windowState.x! >= bounds.x &&
        windowState.x! < bounds.x + bounds.width &&
        windowState.y! >= bounds.y &&
        windowState.y! < bounds.y + bounds.height
      );
    });
  }

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: validPosition ? windowState.x : undefined,
    y: validPosition ? windowState.y : undefined,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#0D1117',
    title: 'KiteTerm',
    icon: path.join(__dirname, '../../assets/icon.png'),
    show: false, // Show after ready-to-show
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // node-pty needs this
    },
    // Frameless window with custom title bar for a polished look
    // Set to true for custom chrome, false for native title bar
    frame: true,
    titleBarStyle: 'default',
  });

  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // Load the renderer
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Save window state on move/resize (debounced to avoid excessive disk writes)
  let saveStateTimeout: ReturnType<typeof setTimeout> | null = null;
  const saveState = () => {
    if (saveStateTimeout) clearTimeout(saveStateTimeout);
    saveStateTimeout = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const bounds = mainWindow.getBounds();
      saveWindowState({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized: mainWindow.isMaximized(),
      });
    }, 300);
  };

  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);
  mainWindow.on('maximize', saveState);
  mainWindow.on('unmaximize', saveState);

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Register menu + in-window shortcuts
  registerWindowShortcuts(mainWindow);
}

// App lifecycle
app.whenReady().then(() => {
  // Register IPC handlers before creating window
  registerIpcHandlers(getWindow);

  createWindow();

  // System tray
  createTray(getWindow);

  // Global shortcuts
  registerShortcuts(getWindow);
});

app.on('window-all-closed', () => {
  // On Windows, don't quit when all windows closed (we have tray)
  // Actually quit only on explicit quit
});

app.on('activate', () => {
  // macOS: re-create window when dock icon clicked
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  killAllPtys();
  unregisterShortcuts();
  destroyTray();
});

// Handle second instance (single instance lock)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
