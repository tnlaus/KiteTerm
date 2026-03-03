import { getWorkspaces } from './store';
import { getShieldPlugin } from './plugin-loader';

// ============================================
// Background Scan Scheduler
// ============================================
// Manages interval-based background repo scans for workspaces
// with backgroundScanEnabled in their scanConfig.

const scanTimers = new Map<string, ReturnType<typeof setInterval>>();

export function startBackgroundScans(): void {
  stopBackgroundScans();

  const shield = getShieldPlugin();
  if (!shield || !shield.scanWorkspace || !shield.supportsRepoScanning) return;

  const workspaces = getWorkspaces();
  for (const ws of workspaces) {
    if (ws.scanConfig?.backgroundScanEnabled) {
      scheduleWorkspaceScan(ws.id, ws.scanConfig.backgroundScanIntervalMinutes);
    }
  }
}

function scheduleWorkspaceScan(workspaceId: string, intervalMinutes?: number): void {
  const minutes = intervalMinutes || 30;
  const ms = minutes * 60 * 1000;

  const timer = setInterval(async () => {
    const shield = getShieldPlugin();
    if (!shield || !shield.scanWorkspace) return;

    const workspace = getWorkspaces().find(ws => ws.id === workspaceId);
    if (!workspace) {
      // Workspace was deleted — clean up timer
      clearInterval(timer);
      scanTimers.delete(workspaceId);
      return;
    }

    try {
      await shield.scanWorkspace(workspaceId, workspace.cwd);
    } catch (err: any) {
      console.warn(`[ScanScheduler] Background scan failed for ${workspaceId}: ${err.message}`);
    }
  }, ms);

  scanTimers.set(workspaceId, timer);
}

export function stopBackgroundScans(): void {
  for (const timer of scanTimers.values()) {
    clearInterval(timer);
  }
  scanTimers.clear();
}

export function refreshBackgroundScans(): void {
  startBackgroundScans();
}
