import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, PtySpawnRequest } from '../shared/types';
import { getDefaultShell } from './store';

interface ManagedPty {
  process: pty.IPty;
  workspaceId: string;
  isAlive: boolean;
}

const activePtys = new Map<string, ManagedPty>();

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
    TERM_PROGRAM: 'kiteterm',
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

    // Pipe PTY output to renderer
    ptyProcess.onData((data: string) => {
      if (window && !window.isDestroyed()) {
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

    return { pid: ptyProcess.pid };
  } catch (err: any) {
    return { error: err.message || 'Failed to spawn PTY' };
  }
}

export function writeToPty(workspaceId: string, data: string): void {
  const managed = activePtys.get(workspaceId);
  if (managed?.isAlive) {
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
