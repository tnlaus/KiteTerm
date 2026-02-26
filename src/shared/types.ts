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
  autoRestart?: boolean; // #9: Auto-restart on crash
  maxRestarts?: number; // #9: Max restart attempts (default 3)
  group?: string; // #3: Workspace group name
}

// #8: Workspace template (like Workspace but no id/cwd)
export interface WorkspaceTemplate {
  name: string;
  startupCommand?: string;
  autoStart: boolean;
  color: string;
  env?: Record<string, string>;
  shell?: string;
  autoRestart?: boolean;
  maxRestarts?: number;
  group?: string;
}

// #3: Workspace group
export interface WorkspaceGroup {
  name: string;
  collapsed: boolean;
  order: number;
}

// Full app config schema
export interface AppConfig {
  version: number;
  defaultShell: string;
  workspaces: Workspace[];
  window: WindowState;
  activeTabId: string | null;
  theme: 'dark' | 'light';
  templates: WorkspaceTemplate[]; // #8
  groups: WorkspaceGroup[]; // #3
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
  WORKSPACE_REORDER: 'workspace:reorder', // #6
  WORKSPACE_TOGGLE_GROUP: 'workspace:toggle-group', // #3
  WORKSPACE_SET_GROUP: 'workspace:set-group', // #3

  // App operations
  APP_GET_CONFIG: 'app:get-config',
  APP_SET_ACTIVE_TAB: 'app:set-active-tab',
  APP_MINIMIZE_TO_TRAY: 'app:minimize-to-tray',
  APP_QUIT: 'app:quit',
  APP_EXPORT_CONFIG: 'app:export-config', // #10
  APP_IMPORT_CONFIG: 'app:import-config', // #10
  APP_SAVE_SCROLLBACK: 'app:save-scrollback', // #1
  APP_LOAD_SCROLLBACK: 'app:load-scrollback', // #1

  // Template operations (#8)
  TEMPLATE_LIST: 'template:list',
  TEMPLATE_CREATE: 'template:create',
  TEMPLATE_DELETE: 'template:delete',
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
