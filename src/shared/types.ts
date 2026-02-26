// Workspace configuration persisted to disk
export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  startupCommand?: string;
  autoStart: boolean;
  color: string;
  env?: Record<string, string>;
  shell?: string; // Override default shell per workspace
}

// Full app config schema
export interface AppConfig {
  version: number;
  defaultShell: string;
  workspaces: Workspace[];
  window: WindowState;
  activeTabId: string | null;
  theme: 'dark' | 'light';
}

export interface WindowState {
  width: number;
  height: number;
  x: number | undefined;
  y: number | undefined;
  isMaximized: boolean;
}

// Runtime PTY state (not persisted)
export interface PtySession {
  id: string;          // matches workspace.id
  pid: number;
  isRunning: boolean;
}

// IPC message types
export interface PtySpawnRequest {
  workspaceId: string;
  shell?: string;
  cwd: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyDataMessage {
  workspaceId: string;
  data: string;
}

export interface PtyResizeMessage {
  workspaceId: string;
  cols: number;
  rows: number;
}

// Workspace CRUD
export type WorkspaceCreateRequest = Omit<Workspace, 'id'>;
export type WorkspaceUpdateRequest = Partial<Workspace> & { id: string };

// Status for the UI
export type TerminalStatus = 'idle' | 'running' | 'dead' | 'starting';

// IPC channel names as const for type safety
export const IPC_CHANNELS = {
  // PTY operations
  PTY_SPAWN: 'pty:spawn',
  PTY_DATA_TO_RENDERER: 'pty:data:to-renderer',
  PTY_DATA_TO_MAIN: 'pty:data:to-main',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_EXIT: 'pty:exit',
  PTY_WRITE_COMMAND: 'pty:write-command',

  // Workspace operations
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_PICK_FOLDER: 'workspace:pick-folder',

  // App operations
  APP_GET_CONFIG: 'app:get-config',
  APP_SAVE_WINDOW_STATE: 'app:save-window-state',
  APP_SET_ACTIVE_TAB: 'app:set-active-tab',
  APP_MINIMIZE_TO_TRAY: 'app:minimize-to-tray',
  APP_QUIT: 'app:quit',
} as const;

// Preset colors for workspaces
export const WORKSPACE_COLORS = [
  '#58A6FF', // Blue
  '#3FB950', // Green
  '#D29922', // Orange
  '#F85149', // Red
  '#BC8CFF', // Purple
  '#39D2C0', // Cyan
  '#F778BA', // Pink
  '#79C0FF', // Light blue
];
