import Store from 'electron-store';
import { AppConfig, Workspace, WindowState } from '../shared/types';
import { v4 as uuid } from 'uuid';

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  defaultShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh',
  workspaces: [],
  window: {
    width: 1200,
    height: 800,
    x: undefined,
    y: undefined,
    isMaximized: false,
  },
  activeTabId: null,
  theme: 'dark',
};

const store = new Store<AppConfig>({
  name: 'claude-terminal-config',
  defaults: DEFAULT_CONFIG,
});

export function getConfig(): AppConfig {
  return {
    version: store.get('version', DEFAULT_CONFIG.version),
    defaultShell: store.get('defaultShell', DEFAULT_CONFIG.defaultShell),
    workspaces: store.get('workspaces', []),
    window: store.get('window', DEFAULT_CONFIG.window),
    activeTabId: store.get('activeTabId', null),
    theme: store.get('theme', 'dark'),
  };
}

export function getWorkspaces(): Workspace[] {
  return store.get('workspaces', []);
}

export function createWorkspace(data: Omit<Workspace, 'id'>): Workspace {
  const workspace: Workspace = { ...data, id: uuid() };
  const workspaces = getWorkspaces();
  workspaces.push(workspace);
  store.set('workspaces', workspaces);
  return workspace;
}

export function updateWorkspace(id: string, updates: Partial<Workspace>): Workspace | null {
  const workspaces = getWorkspaces();
  const index = workspaces.findIndex(w => w.id === id);
  if (index === -1) return null;
  workspaces[index] = { ...workspaces[index], ...updates, id }; // id is immutable
  store.set('workspaces', workspaces);
  return workspaces[index];
}

export function deleteWorkspace(id: string): boolean {
  const workspaces = getWorkspaces();
  const filtered = workspaces.filter(w => w.id !== id);
  if (filtered.length === workspaces.length) return false;
  store.set('workspaces', filtered);
  return true;
}

export function reorderWorkspaces(ids: string[]): void {
  const workspaces = getWorkspaces();
  const ordered = ids.map(id => workspaces.find(w => w.id === id)).filter(Boolean) as Workspace[];
  store.set('workspaces', ordered);
}

export function saveWindowState(state: WindowState): void {
  store.set('window', state);
}

export function setActiveTab(id: string | null): void {
  store.set('activeTabId', id);
}

export function getDefaultShell(): string {
  return store.get('defaultShell', DEFAULT_CONFIG.defaultShell);
}

export { store };
