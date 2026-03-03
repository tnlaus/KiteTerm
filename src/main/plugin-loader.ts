import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import {
  ShieldPlugin,
  PluginContext,
  PluginManifest,
  Detection,
  ShieldStatusInfo,
  PLUGIN_SEARCH_PATHS,
  PLUGIN_API_VERSION,
} from '../shared/plugin-types';
import { IPC_CHANNELS, ScanProgress, ScanResult } from '../shared/types';
import { getWorkspaces } from './store';

// ============================================
// Plugin State
// ============================================

let shieldPlugin: ShieldPlugin | null = null;
let mainWindow: BrowserWindow | null = null;

export function getShieldPlugin(): ShieldPlugin | null {
  return shieldPlugin;
}

export function isShieldActive(): boolean {
  return shieldPlugin !== null;
}

// ============================================
// Plugin Discovery
// ============================================

function resolveSearchPaths(): string[] {
  const appPath = app.getAppPath();
  const userData = app.getPath('userData');

  return PLUGIN_SEARCH_PATHS.map(template =>
    template
      .replace('{appPath}', appPath)
      .replace('{userData}', userData)
  );
}

function tryRegistryPath(): string | null {
  // Windows-only: check registry for IT-deployed Shield path
  if (process.platform !== 'win32') return null;

  try {
    const { execSync } = require('child_process');
    const result = execSync(
      'reg query "HKLM\\SOFTWARE\\TarcaTerminal" /v ShieldPath 2>nul',
      { encoding: 'utf8', timeout: 3000 }
    );
    const match = result.match(/ShieldPath\s+REG_SZ\s+(.+)/);
    if (match) return match[1].trim();
  } catch {
    // Registry key doesn't exist — not deployed via GPO
  }
  return null;
}

function findPluginPath(): string | null {
  // Check standard locations
  const searchPaths = resolveSearchPaths();
  for (const dir of searchPaths) {
    const manifestPath = path.join(dir, 'package.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest: PluginManifest = JSON.parse(
          fs.readFileSync(manifestPath, 'utf8')
        );
        if (((manifest as any)['tarca-plugin'] === 'shield' || manifest['kiteterm-plugin'] === 'shield') && manifest.main) {
          return dir;
        }
      } catch {
        // Invalid manifest — skip
      }
    }
  }

  // Check Windows registry
  const registryPath = tryRegistryPath();
  if (registryPath && fs.existsSync(path.join(registryPath, 'package.json'))) {
    return registryPath;
  }

  return null;
}

// ============================================
// Plugin Loading
// ============================================

export async function loadShieldPlugin(window: BrowserWindow): Promise<boolean> {
  mainWindow = window;

  const pluginPath = findPluginPath();
  if (!pluginPath) {
    console.log('[Shield] Plugin not found — running in free mode');
    return false;
  }

  try {
    const manifestPath = path.join(pluginPath, 'package.json');
    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8')
    );

    const mainPath = path.join(pluginPath, manifest.main);
    if (!fs.existsSync(mainPath)) {
      console.warn(`[Shield] Main entry not found: ${mainPath}`);
      return false;
    }

    // Dynamic require — loads the closed-source Shield module
    const createPlugin = require(mainPath);
    if (typeof createPlugin !== 'function') {
      console.warn('[Shield] Plugin main export is not a factory function');
      return false;
    }

    const plugin: ShieldPlugin = createPlugin();

    // API version compatibility check — warn but still attempt to load
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      console.warn(
        `[Shield] API version mismatch: plugin=${plugin.apiVersion}, host=${PLUGIN_API_VERSION}. ` +
        `Shield may not work correctly. Please update ${plugin.apiVersion < PLUGIN_API_VERSION ? 'Shield' : 'Tarca Terminal'}.`
      );
      // Continue loading — Shield may still work with minor version differences
    }

    // Build the context object that Shield uses to interact with Tarca Terminal
    const context: PluginContext = {
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion(),
      getWorkspaces: () =>
        getWorkspaces().map(ws => ({ id: ws.id, name: ws.name, cwd: ws.cwd })),
      emitDetection: (workspaceId: string, detection: Detection) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shield:detection', { workspaceId, detection });
        }
      },
      emitStatus: (status: ShieldStatusInfo) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shield:status', status);
        }
      },
      emitScanProgress: (progress: ScanProgress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.SHIELD_SCAN_PROGRESS, progress);
        }
      },
      emitScanResult: (result: ScanResult) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.SHIELD_SCAN_RESULT_PUSH, result);
        }
      },
    };

    await plugin.initialize(context);

    // Validate license
    const license = await plugin.validateLicense();
    if (!license.valid) {
      console.warn(`[Shield] License invalid: ${license.error || 'unknown'}`);
      // Still load plugin — it may operate in limited/monitor-only mode
    }

    shieldPlugin = plugin;
    console.log(`[Shield] Loaded v${plugin.version} (license: ${license.valid ? 'valid' : 'invalid'})`);

    // Send initial status to renderer
    context.emitStatus(plugin.getStatus());

    return true;
  } catch (err: any) {
    console.error(`[Shield] Failed to load plugin: ${err.message}`);
    return false;
  }
}

export async function unloadShieldPlugin(): Promise<void> {
  if (shieldPlugin) {
    try {
      await shieldPlugin.shutdown();
    } catch (err: any) {
      console.error(`[Shield] Error during shutdown: ${err.message}`);
    }
    shieldPlugin = null;
  }
}
