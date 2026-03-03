// ============================================
// Tarca Terminal Plugin Interface — Re-export from npm package
// ============================================
//
// The canonical types live in @tarca/plugin-types (npm package).
// This file re-exports everything so existing imports still work:
//   import { ShieldPlugin } from '../shared/plugin-types'
//
// Both repos consume the same types:
//   - Tarca Terminal (this repo):    devDependency on @tarca/plugin-types
//   - tarca-shield (private):       dependency on @tarca/plugin-types

import type {
  ShieldPlugin as BaseShieldPlugin,
  PluginContext as BasePluginContext,
} from '@kiteterm/plugin-types';

import type { ScanResult, ScanFinding, ScanProgress, ScanProviderConfig, ScanProviderConfigField } from './types';

export {
  // Version
  PLUGIN_API_VERSION,
  // Data events
  type DataEvent,
  type InterceptResult,
  type Detection,
  type DetectionCategory,
  // Lifecycle
  type LicenseStatus,
  type ShieldStatusInfo,
  // Policy
  type PolicyRule,
  type WorkspacePolicy,
  type PolicyConfig,
  type CustomPattern,
  // Audit
  type AuditEntry,
  // Discovery
  type PluginManifest,
  PLUGIN_SEARCH_PATHS,
  PLUGIN_REGISTRY_KEY,
} from '@kiteterm/plugin-types';

// Re-export scan types from the app's shared types (these are consumed by both repos)
export type { ScanResult, ScanFinding, ScanProgress, ScanProviderConfig, ScanProviderConfigField };

// Extended PluginContext with scan emit callbacks (API version 3)
export interface PluginContext extends BasePluginContext {
  emitScanProgress?: (progress: ScanProgress) => void;
  emitScanResult?: (result: ScanResult) => void;
}

// Extended ShieldPlugin with optional scan methods (API version 3)
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
