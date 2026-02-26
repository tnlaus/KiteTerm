import { globalShortcut, BrowserWindow, Menu } from 'electron';

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

    // #7: Ctrl+F — terminal search
    if (input.key === 'f' && !input.shift && !input.alt) {
      event.preventDefault();
      window.webContents.send('shortcut:search');
      return;
    }

    // #5: Ctrl+P — quick switcher
    if (input.key === 'p' && !input.shift && !input.alt) {
      event.preventDefault();
      window.webContents.send('shortcut:quick-switcher');
      return;
    }

    // #2: Ctrl+Shift+D — split pane down
    if (input.key === 'D' && input.shift && !input.alt) {
      event.preventDefault();
      window.webContents.send('shortcut:split-down');
      return;
    }

    // #2: Ctrl+Shift+E — split pane right
    if (input.key === 'E' && input.shift && !input.alt) {
      event.preventDefault();
      window.webContents.send('shortcut:split-right');
      return;
    }

    // #2: Ctrl+Shift+W — close pane
    if (input.key === 'W' && input.shift && !input.alt) {
      event.preventDefault();
      window.webContents.send('shortcut:close-pane');
      return;
    }

    // Ctrl+B — toggle sidebar
    if (input.key === 'b' && !input.shift && !input.alt) {
      event.preventDefault();
      window.webContents.send('shortcut:toggle-sidebar');
      return;
    }

    // Ctrl+, — settings
    if (input.key === ',' && !input.shift && !input.alt) {
      event.preventDefault();
      window.webContents.send('shortcut:settings');
      return;
    }

    // Ctrl+Shift+A — analytics dashboard
    if (input.key === 'A' && input.shift && !input.alt) {
      event.preventDefault();
      window.webContents.send('shortcut:analytics-dashboard');
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
        {
          label: 'Export Config...',
          click: () => window.webContents.send('shortcut:export-config'),
        },
        {
          label: 'Import Config...',
          click: () => window.webContents.send('shortcut:import-config'),
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CommandOrControl+,',
          click: () => window.webContents.send('shortcut:settings'),
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
        { type: 'separator' },
        { label: 'Find', accelerator: 'CommandOrControl+F', enabled: true, click: () => window.webContents.send('shortcut:search') },
        { label: 'Quick Switcher', accelerator: 'CommandOrControl+P', enabled: true, click: () => window.webContents.send('shortcut:quick-switcher') },
        { type: 'separator' },
        { label: 'Split Down', accelerator: 'CommandOrControl+Shift+D', enabled: true, click: () => window.webContents.send('shortcut:split-down') },
        { label: 'Split Right', accelerator: 'CommandOrControl+Shift+E', enabled: true, click: () => window.webContents.send('shortcut:split-right') },
        { label: 'Close Pane', accelerator: 'CommandOrControl+Shift+W', enabled: true, click: () => window.webContents.send('shortcut:close-pane') },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CommandOrControl+B',
          click: () => window.webContents.send('shortcut:toggle-sidebar'),
        },
        {
          label: 'Analytics Dashboard',
          accelerator: 'CommandOrControl+Shift+A',
          click: () => window.webContents.send('shortcut:analytics-dashboard'),
        },
        { type: 'separator' },
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
