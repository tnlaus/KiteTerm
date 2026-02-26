import { ipcMain, BrowserWindow, dialog, app } from 'electron';
import { IPC_CHANNELS, PtySpawnRequest, PtyResizeMessage, Workspace, WorkspaceTemplate } from '../shared/types';
import { spawnPty, writeToPty, resizePty, killPty, killPtysForWorkspace, writeCommandToPty } from './pty-manager';
import {
  getConfig,
  getWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  setActiveTab,
  getTemplates,
  createTemplate,
  deleteTemplate,
  getGroups,
  toggleGroup,
  ensureGroup,
  importConfig,
} from './store';
import * as fs from 'fs';
import * as path from 'path';

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  // --- PTY Operations ---

  ipcMain.handle(IPC_CHANNELS.PTY_SPAWN, (_event, request: PtySpawnRequest) => {
    const win = getWindow();
    if (!win) return { error: 'No window available' };
    return spawnPty(request, win);
  });

  ipcMain.on(IPC_CHANNELS.PTY_DATA_TO_MAIN, (_event, { workspaceId, data }: { workspaceId: string; data: string }) => {
    writeToPty(workspaceId, data);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, { workspaceId, cols, rows }: PtyResizeMessage) => {
    resizePty(workspaceId, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, workspaceId: string) => {
    killPty(workspaceId);
  });

  ipcMain.on(IPC_CHANNELS.PTY_WRITE_COMMAND, (_event, { workspaceId, command, delay }: { workspaceId: string; command: string; delay?: number }) => {
    writeCommandToPty(workspaceId, command, delay);
  });

  // --- Workspace Operations ---

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, () => {
    return getWorkspaces();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, (_event, data: Omit<Workspace, 'id'>) => {
    return createWorkspace(data);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UPDATE, (_event, { id, updates }: { id: string; updates: Partial<Workspace> }) => {
    return updateWorkspace(id, updates);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, (_event, id: string) => {
    killPtysForWorkspace(id);
    return deleteWorkspace(id);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_PICK_FOLDER, async () => {
    const win = getWindow();
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Workspace Folder',
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // #6: Workspace reorder
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REORDER, (_event, ids: string[]) => {
    reorderWorkspaces(ids);
    return true;
  });

  // #3: Group operations
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_TOGGLE_GROUP, (_event, name: string) => {
    return toggleGroup(name);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SET_GROUP, (_event, { workspaceId, group }: { workspaceId: string; group: string }) => {
    if (group) ensureGroup(group);
    return updateWorkspace(workspaceId, { group: group || undefined });
  });

  // --- App Operations ---

  ipcMain.handle(IPC_CHANNELS.APP_GET_CONFIG, () => {
    return getConfig();
  });

  ipcMain.on(IPC_CHANNELS.APP_SET_ACTIVE_TAB, (_event, id: string | null) => {
    setActiveTab(id);
  });

  ipcMain.on(IPC_CHANNELS.APP_MINIMIZE_TO_TRAY, () => {
    const win = getWindow();
    if (win) win.hide();
  });

  ipcMain.on(IPC_CHANNELS.APP_QUIT, () => {
    app.quit();
  });

  // #10: Export config
  ipcMain.handle(IPC_CHANNELS.APP_EXPORT_CONFIG, async () => {
    const win = getWindow();
    if (!win) return { error: 'No window' };

    const result = await dialog.showSaveDialog(win, {
      title: 'Export Configuration',
      defaultPath: 'kiteterm-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) return { canceled: true };

    const config = getConfig();
    const exportData = {
      version: config.version,
      defaultShell: config.defaultShell,
      workspaces: config.workspaces,
      theme: config.theme,
      templates: config.templates,
      groups: config.groups,
    };

    fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8');
    return { success: true, path: result.filePath };
  });

  // #10: Import config
  ipcMain.handle(IPC_CHANNELS.APP_IMPORT_CONFIG, async () => {
    const win = getWindow();
    if (!win) return { error: 'No window' };

    const result = await dialog.showOpenDialog(win, {
      title: 'Import Configuration',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) return { canceled: true };

    try {
      const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
      const data = JSON.parse(raw);

      // Validate imported data shape before writing to store
      if (data.workspaces && !Array.isArray(data.workspaces)) {
        return { error: 'Invalid config: workspaces must be an array' };
      }
      if (data.templates && !Array.isArray(data.templates)) {
        return { error: 'Invalid config: templates must be an array' };
      }
      if (data.groups && !Array.isArray(data.groups)) {
        return { error: 'Invalid config: groups must be an array' };
      }
      if (data.theme && data.theme !== 'dark' && data.theme !== 'light') {
        return { error: 'Invalid config: theme must be "dark" or "light"' };
      }
      if (data.defaultShell && typeof data.defaultShell !== 'string') {
        return { error: 'Invalid config: defaultShell must be a string' };
      }

      importConfig(data);
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Failed to import config' };
    }
  });

  // #1: Save scrollback
  ipcMain.handle(IPC_CHANNELS.APP_SAVE_SCROLLBACK, (_event, { workspaceId, content }: { workspaceId: string; content: string }) => {
    const scrollbackDir = path.join(app.getPath('userData'), 'scrollback');
    if (!fs.existsSync(scrollbackDir)) {
      fs.mkdirSync(scrollbackDir, { recursive: true });
    }
    const filePath = path.join(scrollbackDir, `${workspaceId}.txt`);
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  });

  // #1: Load scrollback
  ipcMain.handle(IPC_CHANNELS.APP_LOAD_SCROLLBACK, (_event, workspaceId: string) => {
    const filePath = path.join(app.getPath('userData'), 'scrollback', `${workspaceId}.txt`);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
  });

  // #8: Template operations
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_LIST, () => {
    return getTemplates();
  });

  ipcMain.handle(IPC_CHANNELS.TEMPLATE_CREATE, (_event, template: WorkspaceTemplate) => {
    return createTemplate(template);
  });

  ipcMain.handle(IPC_CHANNELS.TEMPLATE_DELETE, (_event, name: string) => {
    return deleteTemplate(name);
  });
}
