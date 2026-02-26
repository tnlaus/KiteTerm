import { globalShortcut, BrowserWindow } from 'electron';

export function registerShortcuts(getWindow: () => BrowserWindow | null): void {
  // Global shortcut to toggle window visibility
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    const win = getWindow();
    if (!win) return;

    if (win.isVisible() && win.isFocused()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
}

export function registerWindowShortcuts(window: BrowserWindow): void {
  const { Menu } = require('electron');

  // Use before-input-event for reliable shortcut capture —
  // menu accelerators don't reliably catch Ctrl+Tab or Ctrl+1-9
  // when xterm has focus.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (!ctrl) return;

    // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs
    if (input.key === 'Tab') {
      event.preventDefault();
      if (input.shift) {
        window.webContents.send('shortcut:prev-tab');
      } else {
        window.webContents.send('shortcut:next-tab');
      }
      return;
    }

    // Ctrl+1 through Ctrl+9 — go to tab by index
    const num = parseInt(input.key, 10);
    if (num >= 1 && num <= 9) {
      event.preventDefault();
      window.webContents.send('shortcut:go-to-tab', num - 1);
      return;
    }

    // Ctrl+Shift+R — restart terminal
    if (input.key === 'R' && input.shift) {
      event.preventDefault();
      window.webContents.send('shortcut:restart-terminal');
      return;
    }
  });

  // Menu bar for discoverability (and Ctrl+T, Ctrl+W, Ctrl+Q)
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workspace',
          accelerator: 'CommandOrControl+T',
          click: () => window.webContents.send('shortcut:new-workspace'),
        },
        {
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          click: () => window.webContents.send('shortcut:close-tab'),
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CommandOrControl+Q', role: 'quit' },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', enabled: true, click: () => {} },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', enabled: true, click: () => {} },
        { type: 'separator' },
        {
          label: 'Restart Terminal',
          accelerator: 'CommandOrControl+Shift+R',
          enabled: true,
          click: () => {},
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CommandOrControl+=', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', role: 'zoomOut' },
        { label: 'Reset Zoom', accelerator: 'CommandOrControl+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
