import { ipcMain, BrowserWindow, dialog, app } from 'electron';
import { IPC_CHANNELS, PtySpawnRequest, PtyResizeMessage } from '../shared/types';
import { spawnPty, writeToPty, resizePty, killPty, writeCommandToPty } from './pty-manager';
import {
  getConfig,
  getWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  saveWindowState,
  setActiveTab,
} from './store';

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

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, (_event, data) => {
    return createWorkspace(data);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UPDATE, (_event, { id, updates }: { id: string; updates: any }) => {
    return updateWorkspace(id, updates);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, (_event, id: string) => {
    killPty(id);
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

  // --- App Operations ---

  ipcMain.handle(IPC_CHANNELS.APP_GET_CONFIG, () => {
    return getConfig();
  });

  ipcMain.on(IPC_CHANNELS.APP_SAVE_WINDOW_STATE, (_event, state) => {
    saveWindowState(state);
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
}
