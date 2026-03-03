import * as fs from 'fs';
import * as path from 'path';

const watchers = new Map<string, fs.FSWatcher>();

export function startGitWatcher(workspaceId: string, cwd: string, onBranchChange: () => void): void {
  // Stop existing watcher for this workspace if any
  stopGitWatcher(workspaceId);

  const gitHeadPath = path.join(cwd, '.git', 'HEAD');
  if (!fs.existsSync(gitHeadPath)) return;

  let lastContent = '';
  try {
    lastContent = fs.readFileSync(gitHeadPath, 'utf-8').trim();
  } catch {
    return;
  }

  try {
    const watcher = fs.watch(gitHeadPath, { persistent: false }, () => {
      try {
        const current = fs.readFileSync(gitHeadPath, 'utf-8').trim();
        if (current !== lastContent) {
          lastContent = current;
          onBranchChange();
        }
      } catch {
        // File may be temporarily unavailable during git operations
      }
    });

    watcher.on('error', () => {
      stopGitWatcher(workspaceId);
    });

    watchers.set(workspaceId, watcher);
  } catch {
    // If fs.watch fails (e.g., path doesn't exist), silently skip
  }
}

export function stopGitWatcher(workspaceId: string): void {
  const watcher = watchers.get(workspaceId);
  if (watcher) {
    watcher.close();
    watchers.delete(workspaceId);
  }
}

export function stopAllGitWatchers(): void {
  for (const [id, watcher] of watchers) {
    watcher.close();
    watchers.delete(id);
  }
}
