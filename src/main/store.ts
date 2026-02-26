import Store from 'electron-store';
import { AppConfig, Workspace, WindowState, WorkspaceTemplate, WorkspaceGroup } from '../shared/types';
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
  templates: [],
  groups: [],
};

const store = new Store<AppConfig>({
  name: 'kiteterm-config',
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
    templates: store.get('templates', []),
    groups: store.get('groups', []),
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
  const idSet = new Set(ids);
  const ordered = ids.map(id => workspaces.find(w => w.id === id)).filter(Boolean) as Workspace[];
  // Append any workspaces missing from the provided list to prevent data loss
  for (const ws of workspaces) {
    if (!idSet.has(ws.id)) {
      ordered.push(ws);
    }
  }
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

// #8: Template operations
export function getTemplates(): WorkspaceTemplate[] {
  return store.get('templates', []);
}

export function createTemplate(template: WorkspaceTemplate): WorkspaceTemplate {
  const templates = getTemplates();
  templates.push(template);
  store.set('templates', templates);
  return template;
}

export function deleteTemplate(name: string): boolean {
  const templates = getTemplates();
  const filtered = templates.filter(t => t.name !== name);
  if (filtered.length === templates.length) return false;
  store.set('templates', filtered);
  return true;
}

// #3: Group operations
export function getGroups(): WorkspaceGroup[] {
  return store.get('groups', []);
}

export function toggleGroup(name: string): WorkspaceGroup {
  const groups = getGroups();
  const existing = groups.find(g => g.name === name);
  if (existing) {
    existing.collapsed = !existing.collapsed;
    store.set('groups', groups);
    return existing;
  }
  const newGroup: WorkspaceGroup = { name, collapsed: false, order: groups.length };
  groups.push(newGroup);
  store.set('groups', groups);
  return newGroup;
}

export function ensureGroup(name: string): WorkspaceGroup {
  const groups = getGroups();
  const existing = groups.find(g => g.name === name);
  if (existing) return existing;
  const newGroup: WorkspaceGroup = { name, collapsed: false, order: groups.length };
  groups.push(newGroup);
  store.set('groups', groups);
  return newGroup;
}

// #10: Import config (imports workspaces + templates + groups + theme, not window state)
export function importConfig(data: Partial<AppConfig>): void {
  if (data.workspaces) store.set('workspaces', data.workspaces);
  if (data.templates) store.set('templates', data.templates);
  if (data.groups) store.set('groups', data.groups);
  if (data.theme) store.set('theme', data.theme);
  if (data.defaultShell) store.set('defaultShell', data.defaultShell);
}

export { store };
