import * as pty from 'node-pty';
import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS, PtySpawnRequest } from '../shared/types';
import { getDefaultShell } from './store';
import { getMetricsDir, startMetricsWatcher, stopMetricsWatcher, startSessionWatcher, stopSessionWatcher } from './claude-metrics';
import { getShieldPlugin } from './plugin-loader';

interface ManagedPty {
  process: pty.IPty;
  workspaceId: string;
  isAlive: boolean;
}

const activePtys = new Map<string, ManagedPty>();

// Pending warn prompts: workspaceId → { data, resolve }
// When Shield returns action='warn', we hold the data and wait for user response
interface PendingWarn {
  data: string;
  resolve: (allow: boolean) => void;
}
const pendingWarns = new Map<string, PendingWarn>();

// Guard to prevent duplicate registration of the warn response handler
let warnResponseHandlerRegistered = false;

// Register warn response handler (called once from registerIpcHandlers)
export function registerWarnResponseHandler(): void {
  if (warnResponseHandlerRegistered) return;
  warnResponseHandlerRegistered = true;

  ipcMain.on(IPC_CHANNELS.SHIELD_WARN_RESPONSE, (_event, { workspaceId, allow }: { workspaceId: string; allow: boolean }) => {
    const pending = pendingWarns.get(workspaceId);
    if (pending) {
      pendingWarns.delete(workspaceId);
      pending.resolve(allow);
    }
  });
}

export function spawnPty(
  request: PtySpawnRequest,
  window: BrowserWindow
): { pid: number } | { error: string } {
  const { workspaceId, cwd, cols, rows, env } = request;

  // Kill existing PTY for this workspace if any
  killPty(workspaceId);

  const shell = request.shell || getDefaultShell();

  // Strip Claude Code session markers so spawned terminals
  // don't think they're inside a Claude session
  const BLOCKED_KEYS = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']);
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.toUpperCase().startsWith('CLAUDE') || BLOCKED_KEYS.has(key)) {
      delete cleanEnv[key];
    }
  }

  const processEnv = {
    ...cleanEnv,
    ...env,
    // Force color support in terminals
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'tarca-terminal',
    // Claude Code integration: inject metrics env vars
    // Use base workspace ID (strip :pane-N suffix) so session files use clean filenames
    TARCA_METRICS_DIR: getMetricsDir(),
    TARCA_WORKSPACE_ID: workspaceId.split(':')[0],
  };

  try {
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd,
      env: processEnv as { [key: string]: string },
      // Windows-specific: use ConPTY
      ...(process.platform === 'win32' ? { useConpty: true } : {}),
    });

    const managed: ManagedPty = {
      process: ptyProcess,
      workspaceId,
      isAlive: true,
    };

    // Pipe PTY output to renderer (with Shield interception if active)
    ptyProcess.onData((data: string) => {
      if (window && !window.isDestroyed()) {
        // Shield output interception hook
        const shield = getShieldPlugin();
        if (shield) {
          const result = shield.interceptOutput({
            workspaceId, paneId: workspaceId, data,
            direction: 'output', timestamp: Date.now(),
          });
          if (result.data === null) return; // Blocked by Shield
          data = result.data;
        }

        window.webContents.send(IPC_CHANNELS.PTY_DATA_TO_RENDERER, {
          workspaceId,
          data,
        });
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      managed.isAlive = false;
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.PTY_EXIT, {
          workspaceId,
          exitCode,
          signal,
        });
      }
      activePtys.delete(workspaceId);
    });

    activePtys.set(workspaceId, managed);

    // Start metrics watcher for this workspace
    startMetricsWatcher(workspaceId, window);
    // Session watcher uses base workspace ID (without :pane-N suffix)
    startSessionWatcher(workspaceId.split(':')[0], window);

    return { pid: ptyProcess.pid };
  } catch (err: any) {
    return { error: err.message || 'Failed to spawn PTY' };
  }
}

export function writeToPty(workspaceId: string, data: string, window?: BrowserWindow | null): void {
  const managed = activePtys.get(workspaceId);
  if (managed?.isAlive) {
    // Shield input interception hook
    const shield = getShieldPlugin();
    if (shield) {
      const result = shield.interceptInput({
        workspaceId, paneId: workspaceId, data,
        direction: 'input', timestamp: Date.now(),
      });
      if (result.data === null) return; // Blocked by Shield

      // Warn flow: pause data and prompt the user
      if (result.detection?.action === 'warn' && window && !window.isDestroyed()) {
        const heldData = result.data;
        window.webContents.send(IPC_CHANNELS.SHIELD_WARN_PROMPT, {
          workspaceId,
          data: heldData,
          detection: result.detection,
        });

        // Auto-cancel any existing pending warn for this workspace (prevents race condition)
        const existingWarn = pendingWarns.get(workspaceId);
        if (existingWarn) {
          pendingWarns.delete(workspaceId);
          existingWarn.resolve(false);
        }

        // Wait for user response asynchronously
        const warnPromise = new Promise<boolean>((resolve) => {
          pendingWarns.set(workspaceId, { data: heldData, resolve });
          // Auto-cancel after 30 seconds if no response
          setTimeout(() => {
            if (pendingWarns.has(workspaceId)) {
              pendingWarns.delete(workspaceId);
              resolve(false);
            }
          }, 30000);
        });

        warnPromise.then((allow) => {
          // Log user's response
          if (shield.logWarnResponse) {
            shield.logWarnResponse(workspaceId, allow ? 'continued' : 'cancelled', result.detection!);
          }

          if (allow && managed.isAlive) {
            managed.process.write(heldData);
          }
        });
        return;
      }

      data = result.data;
    }

    managed.process.write(data);
  }
}

export function resizePty(workspaceId: string, cols: number, rows: number): void {
  const managed = activePtys.get(workspaceId);
  if (managed?.isAlive) {
    try {
      managed.process.resize(cols, rows);
    } catch {
      // Resize can fail if process just exited
    }
  }
}

export function killPty(workspaceId: string): void {
  const managed = activePtys.get(workspaceId);
  if (managed?.isAlive) {
    try {
      managed.process.kill();
    } catch {
      // Already dead
    }
    managed.isAlive = false;
    activePtys.delete(workspaceId);
    stopMetricsWatcher(workspaceId);
    stopSessionWatcher(workspaceId.split(':')[0]);

    // Clean up any pending warn prompt for this workspace
    const pending = pendingWarns.get(workspaceId);
    if (pending) {
      pendingWarns.delete(workspaceId);
      pending.resolve(false);
    }
  }
}

export function killAllPtys(): void {
  for (const [id] of activePtys) {
    killPty(id);
  }
}

// Kill all PTYs whose key starts with the given workspace ID prefix.
// Split panes use keys like "workspaceId:pane-0", "workspaceId:pane-1", etc.
export function killPtysForWorkspace(workspaceIdPrefix: string): void {
  for (const [id] of activePtys) {
    if (id === workspaceIdPrefix || id.startsWith(workspaceIdPrefix + ':')) {
      killPty(id);
    }
  }
}

export function isPtyAlive(workspaceId: string): boolean {
  return activePtys.get(workspaceId)?.isAlive ?? false;
}

export function writeCommandToPty(workspaceId: string, command: string, delay = 500): void {
  // Write a command to PTY stdin with optional delay
  // Delay lets the shell initialize before sending startup commands
  setTimeout(() => {
    writeToPty(workspaceId, command + '\r');
  }, delay);
}

export function getActivePtyIds(): string[] {
  return Array.from(activePtys.keys());
}
