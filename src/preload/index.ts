import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, PtySpawnRequest, Workspace } from '../shared/types';

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('api', {
  // --- PTY ---
  pty: {
    spawn: (request: PtySpawnRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_SPAWN, request),

    write: (workspaceId: string, data: string) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_DATA_TO_MAIN, { workspaceId, data }),

    resize: (workspaceId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, { workspaceId, cols, rows }),

    kill: (workspaceId: string) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_KILL, workspaceId),

    writeCommand: (workspaceId: string, command: string, delay?: number) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_WRITE_COMMAND, { workspaceId, command, delay }),

    onData: (callback: (data: { workspaceId: string; data: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PTY_DATA_TO_RENDERER, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA_TO_RENDERER, handler);
    },

    onExit: (callback: (data: { workspaceId: string; exitCode: number; signal?: number }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler);
    },
  },

  // --- Workspaces ---
  workspace: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),
    create: (data: Omit<Workspace, 'id'>) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, data),
    update: (id: string, updates: Partial<Workspace>) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE, { id, updates }),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, id),
    pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_PICK_FOLDER),
  },

  // --- App ---
  app: {
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_CONFIG),
    setActiveTab: (id: string | null) => ipcRenderer.send(IPC_CHANNELS.APP_SET_ACTIVE_TAB, id),
    minimizeToTray: () => ipcRenderer.send(IPC_CHANNELS.APP_MINIMIZE_TO_TRAY),
    quit: () => ipcRenderer.send(IPC_CHANNELS.APP_QUIT),
  },

  // --- Shortcut listeners ---
  shortcuts: {
    onNewWorkspace: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:new-workspace', handler);
      return () => ipcRenderer.removeListener('shortcut:new-workspace', handler);
    },
    onCloseTab: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:close-tab', handler);
      return () => ipcRenderer.removeListener('shortcut:close-tab', handler);
    },
    onNextTab: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:next-tab', handler);
      return () => ipcRenderer.removeListener('shortcut:next-tab', handler);
    },
    onPrevTab: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:prev-tab', handler);
      return () => ipcRenderer.removeListener('shortcut:prev-tab', handler);
    },
    onGoToTab: (cb: (index: number) => void) => {
      const handler = (_event: any, index: number) => cb(index);
      ipcRenderer.on('shortcut:go-to-tab', handler);
      return () => ipcRenderer.removeListener('shortcut:go-to-tab', handler);
    },
    onRestartTerminal: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:restart-terminal', handler);
      return () => ipcRenderer.removeListener('shortcut:restart-terminal', handler);
    },
  },

  // --- Tray events ---
  tray: {
    onActivateWorkspace: (cb: (workspaceId: string) => void) => {
      const handler = (_event: any, id: string) => cb(id);
      ipcRenderer.on('tray:activate-workspace', handler);
      return () => ipcRenderer.removeListener('tray:activate-workspace', handler);
    },
  },
});

// Type declaration for the renderer
export interface ElectronAPI {
  pty: {
    spawn: (request: PtySpawnRequest) => Promise<{ pid: number } | { error: string }>;
    write: (workspaceId: string, data: string) => void;
    resize: (workspaceId: string, cols: number, rows: number) => void;
    kill: (workspaceId: string) => void;
    writeCommand: (workspaceId: string, command: string, delay?: number) => void;
    onData: (callback: (data: { workspaceId: string; data: string }) => void) => () => void;
    onExit: (callback: (data: { workspaceId: string; exitCode: number; signal?: number }) => void) => () => void;
  };
  workspace: {
    list: () => Promise<Workspace[]>;
    create: (data: Omit<Workspace, 'id'>) => Promise<Workspace>;
    update: (id: string, updates: Partial<Workspace>) => Promise<Workspace | null>;
    delete: (id: string) => Promise<boolean>;
    pickFolder: () => Promise<string | null>;
  };
  app: {
    getConfig: () => Promise<any>;
    setActiveTab: (id: string | null) => void;
    minimizeToTray: () => void;
    quit: () => void;
  };
  shortcuts: {
    onNewWorkspace: (cb: () => void) => () => void;
    onCloseTab: (cb: () => void) => () => void;
    onNextTab: (cb: () => void) => () => void;
    onPrevTab: (cb: () => void) => () => void;
    onGoToTab: (cb: (index: number) => void) => () => void;
    onRestartTerminal: (cb: () => void) => () => void;
  };
  tray: {
    onActivateWorkspace: (cb: (workspaceId: string) => void) => () => void;
  };
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
