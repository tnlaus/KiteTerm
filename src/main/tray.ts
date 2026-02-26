import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import * as path from 'path';
import { getWorkspaces } from './store';

let tray: Tray | null = null;

export function createTray(getWindow: () => BrowserWindow | null): Tray {
  // Create a simple 16x16 tray icon programmatically (placeholder)
  // Replace with a real .ico file in assets/ for production
  const icon = nativeImage.createEmpty();

  // Try to load icon from assets, fall back to empty
  try {
    const iconPath = path.join(
      app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../'),
      'assets',
      'icon.png'
    );
    const loaded = nativeImage.createFromPath(iconPath);
    if (!loaded.isEmpty()) {
      tray = new Tray(loaded.resize({ width: 16, height: 16 }));
    } else {
      // Create a minimal icon if asset doesn't exist
      tray = new Tray(createPlaceholderIcon());
    }
  } catch {
    tray = new Tray(createPlaceholderIcon());
  }

  tray.setToolTip('KiteTerm');
  updateTrayMenu(getWindow);

  // Click tray icon to show/hide window
  tray.on('click', () => {
    const win = getWindow();
    if (win) {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    }
  });

  return tray;
}

export function updateTrayMenu(getWindow: () => BrowserWindow | null): void {
  if (!tray) return;

  const workspaces = getWorkspaces();

  const workspaceItems: Electron.MenuItemConstructorOptions[] = workspaces.map(ws => ({
    label: `${ws.name}`,
    sublabel: ws.cwd,
    click: () => {
      const win = getWindow();
      if (win) {
        win.show();
        win.focus();
        // Tell renderer to activate this workspace tab
        win.webContents.send('tray:activate-workspace', ws.id);
      }
    },
  }));

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Window', click: () => { const w = getWindow(); if (w) { w.show(); w.focus(); } } },
    { type: 'separator' },
    ...(workspaceItems.length > 0
      ? [{ label: 'Workspaces', submenu: workspaceItems } as Electron.MenuItemConstructorOptions]
      : [{ label: 'No workspaces', enabled: false } as Electron.MenuItemConstructorOptions]),
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
}

function createPlaceholderIcon(): Electron.NativeImage {
  // Create a tiny 16x16 PNG buffer (blue square) as placeholder
  // In production, replace with a proper .ico/.png
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = 88;      // R
    canvas[i * 4 + 1] = 166;  // G
    canvas[i * 4 + 2] = 255;  // B
    canvas[i * 4 + 3] = 255;  // A
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
