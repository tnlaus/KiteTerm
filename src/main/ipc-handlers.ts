import { ipcMain, BrowserWindow, dialog, app } from 'electron';
import { IPC_CHANNELS, PtySpawnRequest, PtyResizeMessage, Workspace, WorkspaceTemplate, AppSettings, AnthropicApiConfig, ScaffoldRequest, ScanResult, ScanRequest, LibraryPushRequest } from '../shared/types';
import { spawnPty, writeToPty, resizePty, killPty, killPtysForWorkspace, writeCommandToPty, registerWarnResponseHandler } from './pty-manager';
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
  getSettings,
  updateSettings,
  getApiConfig,
  setApiConfig,
} from './store';
import {
  getLatestMetrics,
  setupStatuslineHook,
  checkClaudeAuth,
  getAnalytics,
  clearAnalytics,
} from './claude-metrics';
import { testApiConnection, fetchOrgUsage } from './anthropic-api';
import { getShieldPlugin } from './plugin-loader';
import { listScaffoldTemplates, scaffoldProject } from './scaffolder';
import { importToLibrary, removeFromLibrary, refreshLibrary, pushToWorkspaces, getWorkspaceView, scanWorkspaceForItems, discoverFromAllWorkspaces } from './skills-library';
import { refreshBackgroundScans } from './scan-scheduler';
import { startGitWatcher, stopGitWatcher } from './git-watcher';
import * as fs from 'fs';
import * as path from 'path';

function sanitizeFileName(name: string): string {
  return name.replace(/[:<>"|?*]/g, '_');
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  // --- PTY Operations ---

  ipcMain.handle(IPC_CHANNELS.PTY_SPAWN, async (_event, request: PtySpawnRequest) => {
    const win = getWindow();
    if (!win) return { error: 'No window available' };

    // Enforce-before-spawn gate: check if workspace requires a passing scan
    const baseWorkspaceId = request.workspaceId.split(':')[0].split('~')[0];
    const workspaces = getWorkspaces();
    const workspace = workspaces.find(ws => ws.id === baseWorkspaceId);
    if (!request.bypassScanGate && workspace?.scanConfig?.enforcementMode === 'enforce-before-spawn') {
      const shield = getShieldPlugin();
      if (shield && shield.getLastScanResult) {
        const lastScan: ScanResult | null = await shield.getLastScanResult(baseWorkspaceId);
        const SCAN_STALENESS_MS = 5 * 60 * 1000; // 5 minutes
        const isRecent = lastScan && (Date.now() - lastScan.timestamp) < SCAN_STALENESS_MS;
        if (!isRecent || !lastScan?.passed) {
          return { scanRequired: true };
        }
      }
    }

    const spawnResult = spawnPty(request, win);

    // Start git watcher for workspaces with enforce-before-spawn
    if (workspace?.scanConfig?.enforcementMode === 'enforce-before-spawn') {
      startGitWatcher(baseWorkspaceId, request.cwd, () => {
        // Invalidate cached scan result in Shield plugin
        const shield = getShieldPlugin();
        if (shield && shield.invalidateScanResult) {
          shield.invalidateScanResult(baseWorkspaceId);
        }
        // Notify renderer that scan is stale
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.SHIELD_SCAN_INVALIDATE, baseWorkspaceId);
        }
      });
    }

    return spawnResult;
  });

  ipcMain.on(IPC_CHANNELS.PTY_DATA_TO_MAIN, (_event, { workspaceId, data }: { workspaceId: string; data: string }) => {
    writeToPty(workspaceId, data, getWindow());
  });

  // Register Shield warn response handler
  registerWarnResponseHandler();

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, { workspaceId, cols, rows }: PtyResizeMessage) => {
    resizePty(workspaceId, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, workspaceId: string) => {
    killPty(workspaceId);
    stopGitWatcher(workspaceId.split(':')[0].split('~')[0]);
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
    const result = updateWorkspace(id, updates);
    // Refresh background scan timers if scan config may have changed
    if (updates.scanConfig !== undefined) {
      refreshBackgroundScans();
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, (_event, id: string) => {
    killPtysForWorkspace(id);
    stopGitWatcher(id);
    const result = deleteWorkspace(id);
    refreshBackgroundScans();
    return result;
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
      defaultPath: 'tarca-config.json',
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

  // #1: Save scrollback (sanitize for Windows paths)
  ipcMain.handle(IPC_CHANNELS.APP_SAVE_SCROLLBACK, (_event, { workspaceId, content }: { workspaceId: string; content: string }) => {
    const scrollbackDir = path.join(app.getPath('userData'), 'scrollback');
    if (!fs.existsSync(scrollbackDir)) {
      fs.mkdirSync(scrollbackDir, { recursive: true });
    }
    const filePath = path.join(scrollbackDir, `${sanitizeFileName(workspaceId)}.txt`);
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  });

  // #1: Load scrollback (sanitize for Windows paths)
  ipcMain.handle(IPC_CHANNELS.APP_LOAD_SCROLLBACK, (_event, workspaceId: string) => {
    const filePath = path.join(app.getPath('userData'), 'scrollback', `${sanitizeFileName(workspaceId)}.txt`);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
  });

  // Pane layout persistence
  ipcMain.handle(IPC_CHANNELS.APP_SAVE_PANE_LAYOUT, (_event, { workspaceId, layout }: { workspaceId: string; layout: any }) => {
    const layoutDir = path.join(app.getPath('userData'), 'pane-layouts');
    if (!fs.existsSync(layoutDir)) {
      fs.mkdirSync(layoutDir, { recursive: true });
    }
    const filePath = path.join(layoutDir, `${sanitizeFileName(workspaceId)}.json`);
    fs.writeFileSync(filePath, JSON.stringify(layout), 'utf-8');
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.APP_LOAD_PANE_LAYOUT, (_event, workspaceId: string) => {
    const filePath = path.join(app.getPath('userData'), 'pane-layouts', `${sanitizeFileName(workspaceId)}.json`);
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        return null;
      }
    }
    return null;
  });

  // Settings
  ipcMain.handle(IPC_CHANNELS.APP_GET_SETTINGS, () => {
    return getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_SETTINGS, (_event, updates: Partial<AppSettings>) => {
    return updateSettings(updates);
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

  // --- Claude Code Integration ---

  // Phase 1: Metrics
  ipcMain.handle(IPC_CHANNELS.CLAUDE_METRICS_GET, (_event, workspaceId: string) => {
    return getLatestMetrics(workspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_METRICS_SETUP_HOOK, () => {
    return setupStatuslineHook();
  });

  // Phase 2: Auth check
  ipcMain.handle(IPC_CHANNELS.CLAUDE_AUTH_CHECK, async () => {
    return checkClaudeAuth();
  });

  // Phase 3: Analytics
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ANALYTICS_GET, () => {
    return getAnalytics();
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_ANALYTICS_CLEAR, () => {
    return clearAnalytics();
  });

  // Phase 4: Anthropic API
  ipcMain.handle(IPC_CHANNELS.ANTHROPIC_API_GET_CONFIG, () => {
    return getApiConfig();
  });

  ipcMain.handle(IPC_CHANNELS.ANTHROPIC_API_SET_CONFIG, (_event, config: AnthropicApiConfig) => {
    return setApiConfig(config);
  });

  ipcMain.handle(IPC_CHANNELS.ANTHROPIC_API_TEST, async (_event, apiKey: string) => {
    return testApiConnection(apiKey);
  });

  ipcMain.handle(IPC_CHANNELS.ANTHROPIC_API_GET_USAGE, async (_event, { apiKey, period }: { apiKey: string; period?: string }) => {
    return fetchOrgUsage(apiKey, period);
  });

  // --- Scaffold Operations ---

  ipcMain.handle(IPC_CHANNELS.SCAFFOLD_LIST, () => {
    return listScaffoldTemplates();
  });

  ipcMain.handle(IPC_CHANNELS.SCAFFOLD_CREATE, (_event, request: ScaffoldRequest) => {
    return scaffoldProject(request);
  });

  // --- Shield Policy Management ---

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_GET, () => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    return shield.getPolicy();
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_UPSERT_PATTERN, (_event, pattern: any) => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    return shield.upsertCustomPattern(pattern);
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_DELETE_PATTERN, (_event, patternId: string) => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    return shield.deleteCustomPattern(patternId);
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_TEST_PATTERN, (_event, { pattern, isRegex, sampleText }: { pattern: string; isRegex: boolean; sampleText: string }) => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    return shield.testPattern(pattern, isRegex, sampleText);
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_EXPORT, async () => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };

    const win = getWindow();
    if (!win) return { error: 'No window' };

    const result = await dialog.showSaveDialog(win, {
      title: 'Export Shield Policy',
      defaultPath: 'shield-policy.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) return { canceled: true };

    const policyJson = shield.exportPolicy();
    fs.writeFileSync(result.filePath, policyJson, 'utf-8');
    return { success: true, path: result.filePath };
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_IMPORT, async () => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };

    const win = getWindow();
    if (!win) return { error: 'No window' };

    const result = await dialog.showOpenDialog(win, {
      title: 'Import Shield Policy',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) return { canceled: true };

    try {
      const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
      const policy = shield.importPolicy(raw);
      return { success: true, policy };
    } catch (err: any) {
      return { error: err.message || 'Failed to import policy' };
    }
  });

  // --- Shield Policy Rule Management ---

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_UPDATE_RULES, (_event, rules: any[]) => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    const policy = JSON.parse(JSON.stringify(shield.getPolicy()));
    policy.globalRules = rules;
    return shield.importPolicy(JSON.stringify(policy));
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_UPDATE_DEFAULT, (_event, action: string) => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    const policy = JSON.parse(JSON.stringify(shield.getPolicy()));
    policy.defaultAction = action as 'monitor' | 'warn' | 'block';
    return shield.importPolicy(JSON.stringify(policy));
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_UPDATE_WORKSPACE, (_event, { workspaceId, override }: { workspaceId: string; override: any }) => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    const policy = JSON.parse(JSON.stringify(shield.getPolicy()));
    policy.workspaceOverrides[workspaceId] = override;
    return shield.importPolicy(JSON.stringify(policy));
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_POLICY_DELETE_WORKSPACE, (_event, workspaceId: string) => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    const policy = JSON.parse(JSON.stringify(shield.getPolicy()));
    delete policy.workspaceOverrides[workspaceId];
    return shield.importPolicy(JSON.stringify(policy));
  });

  // --- Shield License Management ---

  ipcMain.handle(IPC_CHANNELS.SHIELD_LICENSE_STATUS, async () => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    return shield.validateLicense();
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_LICENSE_INSTALL, async (_event, token: string) => {
    const shield = getShieldPlugin();
    if (!shield) return { error: 'Shield not loaded' };
    if (shield.installLicense) {
      return shield.installLicense(token);
    }
    // Fallback for older Shield versions without installLicense
    return { error: 'Shield version does not support license installation' };
  });

  // --- Shield Audit ---

  ipcMain.handle(IPC_CHANNELS.SHIELD_AUDIT_QUERY, (_event, date?: string) => {
    const userData = app.getPath('userData');
    const targetDate = date || new Date().toISOString().slice(0, 10);
    // Validate date format to prevent path traversal
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return { entries: [], date: targetDate, error: 'Invalid date format' };
    }
    const logPath = path.join(userData, 'shield', 'audit', `${targetDate}.jsonl`);
    if (!fs.existsSync(logPath)) return { entries: [], date: targetDate };
    try {
      const content = fs.readFileSync(logPath, 'utf8').trim();
      if (!content) return { entries: [], date: targetDate };
      const entries = content.split('\n').map(line => JSON.parse(line));
      return { entries, date: targetDate };
    } catch {
      return { entries: [], date: targetDate, error: 'Failed to parse audit log' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_AUDIT_EXPORT, async () => {
    const win = getWindow();
    if (!win) return { error: 'No window' };

    const userData = app.getPath('userData');
    const auditDir = path.join(userData, 'shield', 'audit');
    if (!fs.existsSync(auditDir)) return { error: 'No audit logs found' };

    const result = await dialog.showSaveDialog(win, {
      title: 'Export Audit Logs',
      defaultPath: `shield-audit-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) return { canceled: true };

    try {
      const files = fs.readdirSync(auditDir).filter(f => f.endsWith('.jsonl')).sort();
      const allEntries: any[] = [];
      for (const file of files) {
        const content = fs.readFileSync(path.join(auditDir, file), 'utf8').trim();
        if (content) {
          content.split('\n').forEach(line => {
            try { allEntries.push(JSON.parse(line)); } catch {}
          });
        }
      }
      fs.writeFileSync(result.filePath, JSON.stringify(allEntries, null, 2), 'utf-8');
      return { success: true, path: result.filePath, count: allEntries.length };
    } catch (err: any) {
      return { error: err.message || 'Failed to export audit logs' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_AUDIT_VERIFY, (_event, date?: string) => {
    const shield = getShieldPlugin();
    const targetDate = date || new Date().toISOString().slice(0, 10);
    // Validate date format to prevent path traversal
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return { valid: false, entries: 0, date: targetDate, error: 'Invalid date format' };
    }

    // Prefer Shield's built-in verifyAuditLog to avoid duplicating hash logic
    if (shield && shield.verifyAuditLog) {
      const result = shield.verifyAuditLog(targetDate);
      return { ...result, date: targetDate };
    }

    // Fallback: check if log file exists at all
    const userData = app.getPath('userData');
    const logPath = path.join(userData, 'shield', 'audit', `${targetDate}.jsonl`);
    if (!fs.existsSync(logPath)) {
      return { valid: true, entries: 0, date: targetDate, error: 'No log file for this date' };
    }
    return { valid: false, entries: 0, date: targetDate, error: 'Shield not loaded — cannot verify' };
  });

  // --- Shield Repo Scanning ---

  ipcMain.handle(IPC_CHANNELS.SHIELD_SCAN_START, async (_event, request: ScanRequest | string) => {
    const shield = getShieldPlugin();
    if (!shield || !shield.scanWorkspace) return { error: 'Shield scanning not available' };
    // Support both old (string) and new (ScanRequest) signatures
    const workspaceId = typeof request === 'string' ? request : request.workspaceId;
    const incremental = typeof request === 'string' ? false : (request.incremental ?? false);
    const workspace = getWorkspaces().find(ws => ws.id === workspaceId);
    if (!workspace) return { error: 'Workspace not found' };
    return shield.scanWorkspace(workspaceId, workspace.cwd, { incremental });
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_SCAN_CANCEL, async (_event, jobId: string) => {
    const shield = getShieldPlugin();
    if (!shield || !shield.cancelScan) return { error: 'Shield scanning not available' };
    await shield.cancelScan(jobId);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_SCAN_GET_LAST, async (_event, workspaceId: string) => {
    const shield = getShieldPlugin();
    if (!shield || !shield.getLastScanResult) return null;
    return shield.getLastScanResult(workspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_SCAN_PROVIDER_STATUS, () => {
    const shield = getShieldPlugin();
    if (!shield || !shield.getScanProviderConfig) {
      return { configured: false, providerName: 'None', hasApiToken: false };
    }
    return shield.getScanProviderConfig();
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_SCAN_PROVIDER_SCHEMA, () => {
    const shield = getShieldPlugin();
    if (!shield || !shield.getScanProviderConfigSchema) return [];
    return shield.getScanProviderConfigSchema();
  });

  ipcMain.handle(IPC_CHANNELS.SHIELD_SCAN_PROVIDER_CONFIGURE, async (_event, config: Record<string, string>) => {
    const shield = getShieldPlugin();
    if (!shield || !shield.configureScanProvider) return { success: false, error: 'Shield scanning not available' };
    return shield.configureScanProvider(config);
  });

  // --- Skills & Agents Library ---

  ipcMain.handle(IPC_CHANNELS.LIBRARY_LIST, () => {
    const { getLibraryIndex } = require('./store');
    return getLibraryIndex();
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_IMPORT_FOLDER, async () => {
    const win = getWindow();
    if (!win) return { error: 'No window' };

    const result = await dialog.showOpenDialog(win, {
      title: 'Import Skill or Agent',
      properties: ['openDirectory', 'openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) return { canceled: true };

    const sourcePath = result.filePaths[0];
    const isDir = fs.statSync(sourcePath).isDirectory();

    // Detect type: if path contains 'agent' → agent, otherwise skill
    const lowerPath = sourcePath.toLowerCase();
    const type = lowerPath.includes('agent') ? 'agent' as const : 'skill' as const;

    try {
      const entry = importToLibrary(sourcePath, type);
      return { success: true, entry };
    } catch (err: any) {
      return { error: err.message || 'Import failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_IMPORT_FROM_PATH, (_event, { sourcePath, type }: { sourcePath: string; type: 'skill' | 'agent' }) => {
    try {
      const entry = importToLibrary(sourcePath, type);
      return { success: true, entry };
    } catch (err: any) {
      return { error: err.message || 'Import failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_REMOVE, (_event, entryId: string) => {
    try {
      removeFromLibrary(entryId);
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Remove failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_REFRESH, () => {
    try {
      return refreshLibrary();
    } catch (err: any) {
      return { error: err.message || 'Refresh failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_PUSH, (_event, request: LibraryPushRequest) => {
    return pushToWorkspaces(request);
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_WORKSPACE_VIEW, (_event, workspaceId: string) => {
    return getWorkspaceView(workspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_SCAN_WORKSPACE, (_event, workspaceId: string) => {
    return scanWorkspaceForItems(workspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_DISCOVER_ALL, () => {
    return discoverFromAllWorkspaces();
  });
}
