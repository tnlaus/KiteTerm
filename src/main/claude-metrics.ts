import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import { IPC_CHANNELS, ClaudeMetrics, ClaudeMetricsEntry, ClaudeAuthStatus, ClaudeAnalytics } from '../shared/types';
import { getWorkspaces } from './store';

// ============================================
// Metrics directory + file paths
// ============================================

export function getMetricsDir(): string {
  return path.join(app.getPath('userData'), 'claude-metrics');
}

function getMetricsFilePath(workspaceId: string): string {
  // Sanitize workspace ID for safe file names
  const safe = workspaceId.replace(/[:<>"|?*]/g, '_');
  return path.join(getMetricsDir(), `${safe}.jsonl`);
}

// ============================================
// In-memory cache of latest metrics per workspace
// ============================================

const latestMetrics = new Map<string, ClaudeMetricsEntry>();

export function getLatestMetrics(workspaceId: string): ClaudeMetricsEntry | null {
  return latestMetrics.get(workspaceId) || null;
}

// ============================================
// File watchers — reads only new bytes
// ============================================

interface WatcherState {
  watcher: fs.FSWatcher;
  offset: number;
  filePath: string;
}

const activeWatchers = new Map<string, WatcherState>();

export function startMetricsWatcher(workspaceId: string, window: BrowserWindow): void {
  // Don't double-watch
  if (activeWatchers.has(workspaceId)) return;

  const dir = getMetricsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = getMetricsFilePath(workspaceId);

  // Create file if it doesn't exist
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf8');
  }

  // Start offset at current file size (only read new data)
  const stats = fs.statSync(filePath);
  let offset = stats.size;

  const readNewBytes = () => {
    try {
      const currentStats = fs.statSync(filePath);
      if (currentStats.size <= offset) return;

      const fd = fs.openSync(filePath, 'r');
      const newBytes = Buffer.alloc(currentStats.size - offset);
      fs.readSync(fd, newBytes, 0, newBytes.length, offset);
      fs.closeSync(fd);

      offset = currentStats.size;

      const text = newBytes.toString('utf8');
      const lines = text.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as ClaudeMetricsEntry;
          latestMetrics.set(workspaceId, entry);

          if (window && !window.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.CLAUDE_METRICS_UPDATE, entry);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File may have been deleted or locked — skip
    }
  };

  const watcher = fs.watch(filePath, (eventType) => {
    if (eventType === 'change') {
      readNewBytes();
    }
  });

  watcher.on('error', () => {
    // Watcher error — clean up silently
    stopMetricsWatcher(workspaceId);
  });

  activeWatchers.set(workspaceId, { watcher, offset, filePath });
}

export function stopMetricsWatcher(workspaceId: string): void {
  const state = activeWatchers.get(workspaceId);
  if (state) {
    try {
      state.watcher.close();
    } catch {
      // Already closed
    }
    activeWatchers.delete(workspaceId);
  }
}

export function stopAllMetricsWatchers(): void {
  for (const [id] of activeWatchers) {
    stopMetricsWatcher(id);
  }
}

// ============================================
// Hook installation — configures ~/.claude/settings.json
// ============================================

export function getHookScriptPath(): string {
  // In packaged app, assets are in resources/assets
  // In dev, they're in the project root/assets
  const appPath = app.getAppPath();
  const possiblePaths = [
    path.join(appPath, 'assets', 'claude-statusline-hook.js'),
    path.join(appPath, '..', 'assets', 'claude-statusline-hook.js'),
    path.join(__dirname, '..', '..', 'assets', 'claude-statusline-hook.js'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }

  // Fallback to first path
  return possiblePaths[0];
}

export function isHookInstalled(): boolean {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hookCommand = settings?.hooks?.['StatusLine command'];
    if (!hookCommand) return false;
    return hookCommand.includes('claude-statusline-hook');
  } catch {
    return false;
  }
}

function getClaudeSettingsPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.claude', 'settings.json');
}

export function setupStatuslineHook(): { success: boolean; error?: string } {
  try {
    const hookScriptPath = getHookScriptPath();
    const settingsPath = getClaudeSettingsPath();
    const settingsDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    // Read existing settings or create new
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        settings = {};
      }
    }

    // Set up the hooks section
    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Use node to run the hook script, with proper path quoting
    const normalizedPath = hookScriptPath.replace(/\\/g, '/');
    settings.hooks['StatusLine command'] = `node "${normalizedPath}"`;

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to setup hook' };
  }
}

// ============================================
// Phase 2: Auth pre-check
// ============================================

export function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    // Try to run `claude auth status --json`
    execFile('claude', ['auth', 'status', '--json'], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        // claude CLI not found or errored
        if (err.message?.includes('ENOENT') || err.message?.includes('not found')) {
          resolve({ authenticated: false, error: 'Claude CLI not installed' });
        } else {
          resolve({ authenticated: false, error: err.message });
        }
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve({
          authenticated: !!result.authenticated || !!result.loggedIn,
          account_type: result.account_type || result.accountType,
          email: result.email,
        });
      } catch {
        // If JSON parse fails, check if stdout contains success indicators
        const text = stdout.toLowerCase();
        if (text.includes('authenticated') || text.includes('logged in')) {
          resolve({ authenticated: true });
        } else {
          resolve({ authenticated: false, error: 'Could not parse auth status' });
        }
      }
    });
  });
}

// ============================================
// Phase 3: Analytics aggregation
// ============================================

export function getAnalytics(): ClaudeAnalytics {
  const metricsDir = getMetricsDir();
  const workspaces = getWorkspaces();
  const workspaceNames = new Map<string, string>();
  for (const ws of workspaces) {
    workspaceNames.set(ws.id, ws.name);
  }

  const totals = {
    cost_usd: 0,
    sessions: 0,
    lines_added: 0,
    lines_removed: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
  };

  const perWorkspaceMap = new Map<string, {
    workspaceId: string;
    name: string;
    cost_usd: number;
    sessions: number;
    model: string;
    lastActive: number;
    lines_added: number;
    lines_removed: number;
  }>();

  const dailyCosts = new Map<string, { cost_usd: number; sessions: number }>();

  if (!fs.existsSync(metricsDir)) {
    return { totals, perWorkspace: [], history: [] };
  }

  const files = fs.readdirSync(metricsDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(metricsDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n').filter(l => l.trim());
    const wsId = path.basename(file, '.jsonl');

    let sessionCount = 0;
    let lastCost = 0;
    let lastModel = '';
    let lastActive = 0;
    let lastLinesAdded = 0;
    let lastLinesRemoved = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ClaudeMetricsEntry;
        const m = entry.metrics;

        // Each entry is a snapshot — use the latest cost value (it's cumulative per session)
        lastCost = m.cost_usd || 0;
        lastModel = m.model || '';
        lastLinesAdded = m.lines_added || 0;
        lastLinesRemoved = m.lines_removed || 0;

        if (entry.timestamp > lastActive) {
          lastActive = entry.timestamp;
        }

        // Aggregate daily
        const date = new Date(entry.timestamp).toISOString().split('T')[0];
        const dayEntry = dailyCosts.get(date) || { cost_usd: 0, sessions: 0 };
        // We'll reconcile daily costs after processing all entries
        dailyCosts.set(date, dayEntry);

        sessionCount++;
      } catch {
        // Skip malformed
      }
    }

    // A "session" is a contiguous set of entries for a workspace
    // For simplicity, count unique dates as sessions
    const uniqueDates = new Set<string>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ClaudeMetricsEntry;
        const date = new Date(entry.timestamp).toISOString().split('T')[0];
        uniqueDates.add(date);
      } catch {}
    }

    const sessions = uniqueDates.size || (sessionCount > 0 ? 1 : 0);

    totals.cost_usd += lastCost;
    totals.sessions += sessions;
    totals.lines_added += lastLinesAdded;
    totals.lines_removed += lastLinesRemoved;

    perWorkspaceMap.set(wsId, {
      workspaceId: wsId,
      name: workspaceNames.get(wsId) || wsId,
      cost_usd: lastCost,
      sessions,
      model: lastModel,
      lastActive,
      lines_added: lastLinesAdded,
      lines_removed: lastLinesRemoved,
    });

    // Update daily aggregation
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ClaudeMetricsEntry;
        const date = new Date(entry.timestamp).toISOString().split('T')[0];
        const dayEntry = dailyCosts.get(date) || { cost_usd: 0, sessions: 0 };
        dayEntry.cost_usd += (entry.metrics.cost_usd || 0) / Math.max(lines.length, 1);
        dayEntry.sessions = 1; // At least one session on this day
        dailyCosts.set(date, dayEntry);
      } catch {}
    }
  }

  // Sort daily history
  const history = Array.from(dailyCosts.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const perWorkspace = Array.from(perWorkspaceMap.values())
    .sort((a, b) => b.lastActive - a.lastActive);

  return { totals, perWorkspace, history };
}

export function clearAnalytics(): boolean {
  const metricsDir = getMetricsDir();
  if (!fs.existsSync(metricsDir)) return true;

  try {
    const files = fs.readdirSync(metricsDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      fs.unlinkSync(path.join(metricsDir, file));
    }
    latestMetrics.clear();
    return true;
  } catch {
    return false;
  }
}
