// ============================================
// KiteTerm Plugin Interface
// ============================================
//
// This file defines the contract between KiteTerm (free, open source)
// and KiteTerm Shield (paid, closed source plugin).
//
// The free app loads the plugin dynamically at runtime via require().
// If the plugin is not installed, the app works identically.
// This file is part of the open source codebase — Shield implements it.

// ============================================
// Data Events (passed through interceptor pipeline)
// ============================================

export interface DataEvent {
  workspaceId: string;
  paneId: string;
  data: string;
  direction: 'input' | 'output';
  timestamp: number;
}

export interface InterceptResult {
  /** The (potentially modified) data to pass through. null = blocked entirely. */
  data: string | null;
  /** If blocked or warned, the detection details. */
  detection?: Detection;
}

export interface Detection {
  category: DetectionCategory;
  pattern: string;
  action: 'monitor' | 'warn' | 'block';
  context: string;
  /** If action is 'warn', renderer shows a toast and waits for user response. */
  userPrompt?: string;
}

export type DetectionCategory =
  | 'pii'
  | 'credential'
  | 'classification'
  | 'code_secret'
  | 'data_pattern'
  | 'custom';

// ============================================
// Plugin Lifecycle
// ============================================

export interface PluginContext {
  /** Electron app.getPath('userData') */
  userDataPath: string;
  /** Current KiteTerm version */
  appVersion: string;
  /** Workspace metadata (id, name, cwd) for policy resolution */
  getWorkspaces(): Array<{ id: string; name: string; cwd: string }>;
  /** Send a detection event to the renderer for toast/status bar display */
  emitDetection(workspaceId: string, detection: Detection): void;
  /** Send a status update to the renderer status bar */
  emitStatus(status: ShieldStatusInfo): void;
}

export interface LicenseStatus {
  valid: boolean;
  org?: string;
  seats?: number;
  expiresAt?: number;
  error?: string;
}

export interface ShieldStatusInfo {
  enabled: boolean;
  detectionCount: number;
  lastDetection?: Detection;
  licenseValid: boolean;
}

// ============================================
// Shield Plugin Interface
// ============================================

export interface ShieldPlugin {
  readonly name: string;
  readonly version: string;

  /** Called once on app startup. Initialize patterns, load policies, validate license. */
  initialize(context: PluginContext): Promise<void>;

  /** Called on app quit. Flush logs, close file handles. */
  shutdown(): Promise<void>;

  /**
   * Intercept data flowing TO the PTY (user input, pastes, startup commands).
   * Called in the main process before writeToPty().
   * Return { data: null } to block. Return { data } to pass through (possibly modified).
   */
  interceptInput(event: DataEvent): InterceptResult;

  /**
   * Intercept data flowing FROM the PTY (terminal output, Claude responses).
   * Called in the main process before sending to renderer.
   * Return { data: null } to suppress. Return { data } to pass through.
   */
  interceptOutput(event: DataEvent): InterceptResult;

  /** Validate the license key. Called on startup and periodically. */
  validateLicense(): Promise<LicenseStatus>;

  /** Get current shield status for the status bar. */
  getStatus(): ShieldStatusInfo;
}

// ============================================
// Plugin Discovery
// ============================================

/**
 * Plugin package.json must contain:
 * {
 *   "kiteterm-plugin": "shield",
 *   "main": "./dist/index.js",
 *   "version": "1.0.0"
 * }
 *
 * The main export must be a factory function:
 *   module.exports = function createShieldPlugin(): ShieldPlugin { ... }
 */
export interface PluginManifest {
  'kiteterm-plugin': 'shield';
  main: string;
  version: string;
  name?: string;
}

/** Locations checked for Shield plugin (in order): */
export const PLUGIN_SEARCH_PATHS = [
  // 1. Bundled with enterprise installer
  '{appPath}/plugins/kiteterm-shield/',
  // 2. User-installed
  '{userData}/plugins/kiteterm-shield/',
  // 3. Adjacent to app (dev mode)
  '{appPath}/../kiteterm-shield/',
] as const;

/**
 * Windows registry key for IT-deployed path (via GPO):
 * HKLM\SOFTWARE\KiteTerm\ShieldPath
 */
export const PLUGIN_REGISTRY_KEY = 'HKLM\\SOFTWARE\\KiteTerm\\ShieldPath';
