// ============================================
// Tarca Terminal Plugin Interface
// ============================================
//
// All types and constants inlined here so the free app has zero
// runtime dependency on the @kiteterm/plugin-types npm package.
//
// Both repos consume compatible types:
//   - Tarca Terminal (this repo):  defines types here
//   - tarca-shield (private):      dependency on @tarca/plugin-types

import type { ScanResult, ScanFinding, ScanProgress, ScanProviderConfig, ScanProviderConfigField } from './types';

// Re-export scan types from the app's shared types (consumed by both repos)
export type { ScanResult, ScanFinding, ScanProgress, ScanProviderConfig, ScanProviderConfigField };

// ============================================
// Plugin API Version
// ============================================

/** Increment on breaking interface changes so Shield can detect incompatibility. */
export const PLUGIN_API_VERSION = 2;

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

export interface BasePluginContext {
  /** Electron app.getPath('userData') */
  userDataPath: string;
  /** Current app version */
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
// Shield Plugin Interface (base)
// ============================================

export interface BaseShieldPlugin {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: number;

  initialize(context: BasePluginContext): Promise<void>;
  shutdown(): Promise<void>;
  interceptInput(event: DataEvent): InterceptResult;
  interceptOutput(event: DataEvent): InterceptResult;
  validateLicense(): Promise<LicenseStatus>;
  getStatus(): ShieldStatusInfo;
  getPolicy(): PolicyConfig;
  upsertCustomPattern(pattern: CustomPattern): PolicyConfig;
  deleteCustomPattern(patternId: string): PolicyConfig;
  testPattern(pattern: string, isRegex: boolean, sampleText: string): Array<{ match: string; index: number }>;
  exportPolicy(): string;
  importPolicy(jsonString: string): PolicyConfig;
  logWarnResponse?(workspaceId: string, userResponse: 'continued' | 'cancelled', detection: Detection): void;
  verifyAuditLog?(date?: string): { valid: boolean; entries: number; brokenAt?: number; error?: string };
  installLicense?(token: string): Promise<LicenseStatus>;
}

// ============================================
// Custom Pattern Types
// ============================================

export interface CustomPattern {
  id: string;
  name: string;
  pattern: string;
  isRegex: boolean;
  category: 'custom';
  action: 'monitor' | 'warn' | 'block';
  description: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// Policy Types
// ============================================

export interface PolicyRule {
  category: DetectionCategory;
  action: 'monitor' | 'warn' | 'block';
  customPatterns?: string[];
}

export interface WorkspacePolicy {
  name: string;
  rules: PolicyRule[];
  sessionRecording?: boolean;
}

export interface PolicyConfig {
  version: number;
  defaultAction: 'monitor' | 'warn' | 'block';
  globalRules: PolicyRule[];
  workspaceOverrides: Record<string, WorkspacePolicy>;
  customPatterns?: CustomPattern[];
}

// ============================================
// Audit Log Types
// ============================================

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  workspace: string;
  workspaceId: string;
  user: string;
  event: 'dlp_detection' | 'policy_change' | 'license_check' | 'session_start' | 'session_end';
  direction?: 'input' | 'output';
  category?: DetectionCategory;
  pattern?: string;
  action?: 'monitored' | 'warned' | 'blocked';
  userResponse?: 'continued' | 'cancelled';
  context?: string;
  hash: string;
}

// ============================================
// Plugin Discovery
// ============================================

export interface PluginManifest {
  'kiteterm-plugin': 'shield';
  main: string;
  version: string;
  name?: string;
}

/** Locations checked for Shield plugin (in order): */
export const PLUGIN_SEARCH_PATHS = [
  // 1. Bundled with enterprise installer
  '{appPath}/plugins/tarca-shield/',
  // 2. User-installed
  '{userData}/plugins/tarca-shield/',
  // 3. Adjacent to app (dev mode)
  '{appPath}/../tarca-shield/',
] as const;

/**
 * Windows registry key for IT-deployed path (via GPO):
 * HKLM\SOFTWARE\Tarca\ShieldPath
 */
export const PLUGIN_REGISTRY_KEY = 'HKLM\\SOFTWARE\\Tarca\\ShieldPath';

// ============================================
// Extended interfaces (API version 3 — scan support)
// ============================================

/** Extended PluginContext with scan emit callbacks */
export interface PluginContext extends BasePluginContext {
  emitScanProgress?: (progress: ScanProgress) => void;
  emitScanResult?: (result: ScanResult) => void;
}

/** Extended ShieldPlugin with optional scan methods */
export interface ShieldPlugin extends BaseShieldPlugin {
  readonly supportsRepoScanning?: boolean;
  scanWorkspace?(workspaceId: string, cwd: string, options?: { incremental?: boolean }): Promise<{ jobId: string }>;
  cancelScan?(jobId: string): Promise<void>;
  getLastScanResult?(workspaceId: string): Promise<ScanResult | null>;
  invalidateScanResult?(workspaceId: string): void;
  getScanProviderConfig?(): ScanProviderConfig;
  configureScanProvider?(config: Record<string, string>): Promise<{ success: boolean; error?: string }>;
  getScanProviderConfigSchema?(): ScanProviderConfigField[];
}
