import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, PtySpawnRequest, Workspace, WorkspaceTemplate, WorkspaceGroup, AppConfig } from '../shared/types';

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
    reorder: (ids: string[]) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REORDER, ids), // #6
    toggleGroup: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_TOGGLE_GROUP, name), // #3
    setGroup: (workspaceId: string, group: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET_GROUP, { workspaceId, group }), // #3
  },

  // --- App ---
  app: {
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_CONFIG),
    setActiveTab: (id: string | null) => ipcRenderer.send(IPC_CHANNELS.APP_SET_ACTIVE_TAB, id),
    minimizeToTray: () => ipcRenderer.send(IPC_CHANNELS.APP_MINIMIZE_TO_TRAY),
    quit: () => ipcRenderer.send(IPC_CHANNELS.APP_QUIT),
    exportConfig: () => ipcRenderer.invoke(IPC_CHANNELS.APP_EXPORT_CONFIG), // #10
    importConfig: () => ipcRenderer.invoke(IPC_CHANNELS.APP_IMPORT_CONFIG), // #10
    saveScrollback: (workspaceId: string, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_SAVE_SCROLLBACK, { workspaceId, content }), // #1
    loadScrollback: (workspaceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_LOAD_SCROLLBACK, workspaceId), // #1
  },

  // --- Templates (#8) ---
  template: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_LIST),
    create: (template: WorkspaceTemplate) => ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_CREATE, template),
    delete: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_DELETE, name),
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
    // #7: Search
    onSearch: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:search', handler);
      return () => ipcRenderer.removeListener('shortcut:search', handler);
    },
    // #5: Quick Switcher
    onQuickSwitcher: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:quick-switcher', handler);
      return () => ipcRenderer.removeListener('shortcut:quick-switcher', handler);
    },
    // #2: Split panes
    onSplitDown: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:split-down', handler);
      return () => ipcRenderer.removeListener('shortcut:split-down', handler);
    },
    onSplitRight: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:split-right', handler);
      return () => ipcRenderer.removeListener('shortcut:split-right', handler);
    },
    onClosePane: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:close-pane', handler);
      return () => ipcRenderer.removeListener('shortcut:close-pane', handler);
    },
    // #10: Export/Import
    onExportConfig: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:export-config', handler);
      return () => ipcRenderer.removeListener('shortcut:export-config', handler);
    },
    onImportConfig: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:import-config', handler);
      return () => ipcRenderer.removeListener('shortcut:import-config', handler);
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
    reorder: (ids: string[]) => Promise<boolean>;
    toggleGroup: (name: string) => Promise<WorkspaceGroup>;
    setGroup: (workspaceId: string, group: string) => Promise<Workspace | null>;
  };
  app: {
    getConfig: () => Promise<AppConfig>;
    setActiveTab: (id: string | null) => void;
    minimizeToTray: () => void;
    quit: () => void;
    exportConfig: () => Promise<{ success?: boolean; canceled?: boolean; error?: string; path?: string }>;
    importConfig: () => Promise<{ success?: boolean; canceled?: boolean; error?: string }>;
    saveScrollback: (workspaceId: string, content: string) => Promise<boolean>;
    loadScrollback: (workspaceId: string) => Promise<string | null>;
  };
  template: {
    list: () => Promise<WorkspaceTemplate[]>;
    create: (template: WorkspaceTemplate) => Promise<WorkspaceTemplate>;
    delete: (name: string) => Promise<boolean>;
  };
  shortcuts: {
    onNewWorkspace: (cb: () => void) => () => void;
    onCloseTab: (cb: () => void) => () => void;
    onNextTab: (cb: () => void) => () => void;
    onPrevTab: (cb: () => void) => () => void;
    onGoToTab: (cb: (index: number) => void) => () => void;
    onRestartTerminal: (cb: () => void) => () => void;
    onSearch: (cb: () => void) => () => void;
    onQuickSwitcher: (cb: () => void) => () => void;
    onSplitDown: (cb: () => void) => () => void;
    onSplitRight: (cb: () => void) => () => void;
    onClosePane: (cb: () => void) => () => void;
    onExportConfig: (cb: () => void) => () => void;
    onImportConfig: (cb: () => void) => () => void;
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
