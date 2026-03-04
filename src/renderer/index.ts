import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Workspace, WORKSPACE_COLORS, TerminalStatus, WorkspaceTemplate, WorkspaceGroup, SerializedPaneNode, SerializedPaneLeaf, SerializedPaneSplit, AppSettings, ClaudeMetricsEntry, ClaudeAnalytics, AnthropicApiConfig, ScaffoldTemplateInfo, ScanProgress, ScanResult, ScanFinding, ScanProviderConfigField, ScanRequest, LibraryEntry, LibraryWorkspaceView, LibrarySyncStatus, DiscoveredItem } from '../shared/types';

// Type-safe access to the preload API
const api = window.api;

// ============================================
// #2: Split Pane Types
// ============================================

interface PaneLeaf {
  type: 'leaf';
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  container: HTMLDivElement;
  pid: number | null;
  status: TerminalStatus;
  dataDisposable: { dispose: () => void } | null;
  resizeDisposable: { dispose: () => void } | null;
}

interface PaneSplit {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  children: [PaneNode, PaneNode];
  ratio: number; // 0-1, fraction of first child
  container: HTMLDivElement;
}

type PaneNode = PaneLeaf | PaneSplit;

// ============================================
// State
// ============================================

interface TabState {
  tabId: string; // unique instance ID: "{workspaceId}~{N}"
  workspace: Workspace;
  paneRoot: PaneNode;
  activePaneId: string;
  paneCounter: number;
  // #4: Unread badge
  hasUnread: boolean;
  unreadCount: number;
  // #9: Auto-restart
  restartCount: number;
  restartStabilityTimer: ReturnType<typeof setTimeout> | null;
  // Session resume tracking
  _resumeAttemptTime: number | null;
  // Shield detection badge
  shieldDetectionCount: number;
  shieldHasBlock: boolean;
}

const tabs = new Map<string, TabState>();
let activeTabId: string | null = null;
let editingWorkspaceId: string | null = null;
let selectedColor = WORKSPACE_COLORS[0];

// #3: Group collapse state (kept in sync with store)
let groupStates = new Map<string, boolean>(); // name → collapsed

// #8: Templates cache
let templates: WorkspaceTemplate[] = [];

// Sidebar state
let allWorkspaces: Workspace[] = [];
let sidebarVisible = true;

// Settings cache
let currentSettings: AppSettings = {
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Consolas', 'JetBrains Mono', 'Fira Code', monospace",
  defaultShell: 'powershell.exe',  // Overwritten by getSettings() in init()
  scrollbackLimit: 10000,
  theme: 'dark',
  notifyOnIdle: false,
  notifyDelaySeconds: 5,
};

// Notification on command completion state
const paneIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastOutputSnippet = new Map<string, string>();
let windowIsFocused = true;

// Claude Code metrics state
const claudeMetrics = new Map<string, ClaudeMetricsEntry>();

// Shield state
let shieldActive = false;
let shieldDetectionCount = 0;

// Scaffold state
let scaffoldMode = false;
let scaffoldTemplates: ScaffoldTemplateInfo[] = [];
let selectedScaffold: ScaffoldTemplateInfo | null = null;
let scaffoldSelectedColor = WORKSPACE_COLORS[0];

// Scan state
let shieldSupportsScanning = false;
const scanOverlays = new Map<string, HTMLElement>(); // workspaceId → overlay element
const scanStates = new Map<string, { jobId?: string; progress?: ScanProgress; result?: ScanResult }>(); // workspaceId → scan state
const pendingScanSpawns = new Set<string>(); // workspaceIds waiting for scan to auto-spawn

// Library state
let libraryEntries: LibraryEntry[] = [];
let selectedLibraryEntry: LibraryEntry | null = null;

// ============================================
// Tab Instance ID Helpers (multi-tab per workspace)
// ============================================

let nextInstanceId = 1;

function generateTabInstanceId(workspaceId: string): string {
  return `${workspaceId}~${nextInstanceId++}`;
}

function getWorkspaceIdFromTabId(tabId: string): string {
  // Strip ~N suffix to get base workspace ID
  const tildeIdx = tabId.indexOf('~');
  return tildeIdx >= 0 ? tabId.substring(0, tildeIdx) : tabId;
}

function getTabsForWorkspace(workspaceId: string): TabState[] {
  const result: TabState[] = [];
  for (const tab of tabs.values()) {
    if (tab.workspace.id === workspaceId) {
      result.push(tab);
    }
  }
  return result;
}

function hasOpenTabsForWorkspace(workspaceId: string): boolean {
  for (const tab of tabs.values()) {
    if (tab.workspace.id === workspaceId) return true;
  }
  return false;
}

function getFirstTabForWorkspace(workspaceId: string): TabState | undefined {
  for (const tab of tabs.values()) {
    if (tab.workspace.id === workspaceId) return tab;
  }
  return undefined;
}

function getTabDisplayName(tabState: TabState): string {
  const wsId = tabState.workspace.id;
  const wsTabs = getTabsForWorkspace(wsId);
  if (wsTabs.length <= 1) return tabState.workspace.name;
  // Number them in order of appearance
  const idx = wsTabs.indexOf(tabState);
  return `${tabState.workspace.name} (${idx + 1})`;
}

// ============================================
// DOM References
// ============================================

const tabList = document.getElementById('tab-list')!;
const addTabBtn = document.getElementById('add-tab-btn')!;
const terminalContainer = document.getElementById('terminal-container')!;
const statusDot = document.getElementById('status-dot')!;
const statusText = document.getElementById('status-text')!;
const statusCwd = document.getElementById('status-cwd')!;
const statusShell = document.getElementById('status-shell')!;
const statusShield = document.getElementById('status-shield')!;
const shieldCountEl = document.getElementById('shield-count')!;
const shieldToastContainer = document.getElementById('shield-toast-container')!;
const modalOverlay = document.getElementById('modal-overlay')!;
const modalTitle = document.getElementById('modal-title')!;
const wsNameInput = document.getElementById('ws-name') as HTMLInputElement;
const wsCwdInput = document.getElementById('ws-cwd') as HTMLInputElement;
const wsCommandInput = document.getElementById('ws-command') as HTMLInputElement;
const wsAutostartInput = document.getElementById('ws-autostart') as HTMLInputElement;
const wsBrowseBtn = document.getElementById('ws-browse-btn')!;
const wsColorsDiv = document.getElementById('ws-colors')!;
const modalCancel = document.getElementById('modal-cancel')!;
const modalSave = document.getElementById('modal-save')!;
const emptyState = document.getElementById('empty-state')!;
const emptyAddBtn = document.getElementById('empty-add-btn')!;

// #9: Auto-restart modal fields
const wsAutorestartInput = document.getElementById('ws-autorestart') as HTMLInputElement;
const wsMaxRestartsInput = document.getElementById('ws-max-restarts') as HTMLInputElement;
const maxRestartsGroup = document.getElementById('max-restarts-group')!;

// #3: Group field
const wsGroupInput = document.getElementById('ws-group') as HTMLInputElement;

// #8: Template selector
const wsTemplateSelect = document.getElementById('ws-template') as HTMLSelectElement;
const templateGroup = document.getElementById('template-group')!;

// Session resume mode
const wsResumeModeSelect = document.getElementById('ws-resume-mode') as HTMLSelectElement;
const resumeModeGroup = document.getElementById('resume-mode-group')!;

// Advanced section toggle
const wsAdvancedToggle = document.getElementById('ws-advanced-toggle')!;
const wsAdvancedChevron = document.getElementById('ws-advanced-chevron')!;
const wsAdvancedSection = document.getElementById('ws-advanced-section')!;

// #7: Search bar
const searchBar = document.getElementById('search-bar')!;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchMatchCount = document.getElementById('search-match-count')!;
const searchPrevBtn = document.getElementById('search-prev')!;
const searchNextBtn = document.getElementById('search-next')!;
const searchCloseBtn = document.getElementById('search-close')!;

// #5: Quick switcher
const qsOverlay = document.getElementById('quick-switcher-overlay')!;
const qsInput = document.getElementById('qs-input') as HTMLInputElement;
const qsResults = document.getElementById('qs-results')!;
let qsSelectedIndex = 0;

// Sidebar
const sidebar = document.getElementById('sidebar')!;
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn')!;
const sidebarAddBtn = document.getElementById('sidebar-add-btn')!;
const sidebarFilter = document.getElementById('sidebar-filter') as HTMLInputElement;
const sidebarList = document.getElementById('sidebar-list')!;

// Claude metrics status bar
const statusClaude = document.getElementById('status-claude')!;
const statusModel = document.getElementById('status-model')!;
const statusContextPct = document.getElementById('status-context-pct')!;
const statusCost = document.getElementById('status-cost')!;
const statusLines = document.getElementById('status-lines')!;
const contextBarFill = document.querySelector('.context-bar-fill') as HTMLElement;

// Analytics dashboard
const dashboardOverlay = document.getElementById('dashboard-overlay')!;
const dashCloseBtn = document.getElementById('dash-close-btn')!;
const dashClearBtn = document.getElementById('dash-clear-btn')!;
const dashTotalCost = document.getElementById('dash-total-cost')!;
const dashTotalSessions = document.getElementById('dash-total-sessions')!;
const dashTotalAdded = document.getElementById('dash-total-added')!;
const dashTotalRemoved = document.getElementById('dash-total-removed')!;
const dashWorkspaceTbody = document.getElementById('dash-workspace-tbody')!;
const dashChart = document.getElementById('dash-chart')!;
const dashOrgSection = document.getElementById('dash-org-section')!;
const dashOrgContent = document.getElementById('dash-org-content')!;

// Scaffold DOM refs
const scaffoldModeToggle = document.getElementById('scaffold-mode-toggle')!;
const existingModeBtn = document.getElementById('existing-mode-btn')!;
const scaffoldModeBtn = document.getElementById('scaffold-mode-btn')!;
const existingForm = document.getElementById('existing-form')!;
const scaffoldForm = document.getElementById('scaffold-form')!;
const scaffoldTemplateGrid = document.getElementById('scaffold-template-grid')!;
const scaffoldProjectNameInput = document.getElementById('scaffold-project-name') as HTMLInputElement;
const scaffoldParentDirInput = document.getElementById('scaffold-parent-dir') as HTMLInputElement;
const scaffoldBrowseBtn = document.getElementById('scaffold-browse-btn')!;
const scaffoldVariablesDiv = document.getElementById('scaffold-variables')!;
const scaffoldGitInitInput = document.getElementById('scaffold-git-init') as HTMLInputElement;
const scaffoldRunClaudeInput = document.getElementById('scaffold-run-claude') as HTMLInputElement;
const scaffoldColorsDiv = document.getElementById('scaffold-colors')!;
const scaffoldGroupInput = document.getElementById('scaffold-group') as HTMLInputElement;

// Scan results modal DOM refs
const scanResultsOverlay = document.getElementById('scan-results-overlay')!;
const scanResultsTitle = document.getElementById('scan-results-title')!;
const scanResultsSummary = document.getElementById('scan-results-summary')!;
const scanResultsList = document.getElementById('scan-results-list')!;
const scanResultsClose = document.getElementById('scan-results-close')!;
const scanResultsRescan = document.getElementById('scan-results-rescan')!;
const scanResultsForce = document.getElementById('scan-results-force')!;

// Workspace modal scan fields
const scanPolicyGroup = document.getElementById('scan-policy-group')!;
const wsScanPolicySelect = document.getElementById('ws-scan-policy') as HTMLSelectElement;
const scanBackgroundGroup = document.getElementById('scan-background-group')!;
const wsScanBackgroundInput = document.getElementById('ws-scan-background') as HTMLInputElement;
const scanBypassGroup = document.getElementById('scan-bypass-group')!;
const wsScanBypassInput = document.getElementById('ws-scan-bypass') as HTMLInputElement;
const scanThresholdGroup = document.getElementById('scan-threshold-group')!;
const wsScanThresholdSelect = document.getElementById('ws-scan-threshold') as HTMLSelectElement;
const scanExcludeGroup = document.getElementById('scan-exclude-group')!;
const wsScanExcludeTextarea = document.getElementById('ws-scan-exclude') as HTMLTextAreaElement;

// Scan provider settings DOM refs
const scanProviderSection = document.getElementById('shield-scan-provider-section')!;
const scanProviderName = document.getElementById('scan-provider-name')!;
const scanProviderIndicator = document.getElementById('scan-provider-indicator')!;
const scanProviderFields = document.getElementById('scan-provider-fields')!;
const scanProviderSaveBtn = document.getElementById('scan-provider-save')!;
const scanProviderResult = document.getElementById('scan-provider-result')!;

// ============================================
// Terminal Factory
// ============================================

const TERMINAL_THEME_DARK = {
  background: '#0D1117',
  foreground: '#E6EDF3',
  cursor: '#58A6FF',
  cursorAccent: '#0D1117',
  selectionBackground: '#264F78',
  selectionForeground: '#E6EDF3',
  black: '#484F58',
  red: '#FF7B72',
  green: '#3FB950',
  yellow: '#D29922',
  blue: '#58A6FF',
  magenta: '#BC8CFF',
  cyan: '#39D2C0',
  white: '#B1BAC4',
  brightBlack: '#6E7681',
  brightRed: '#FFA198',
  brightGreen: '#56D364',
  brightYellow: '#E3B341',
  brightBlue: '#79C0FF',
  brightMagenta: '#D2A8FF',
  brightCyan: '#56D4DD',
  brightWhite: '#F0F6FC',
};

const TERMINAL_THEME_LIGHT = {
  background: '#FFFFFF',
  foreground: '#1F2328',
  cursor: '#0969DA',
  cursorAccent: '#FFFFFF',
  selectionBackground: '#B6E3FF',
  selectionForeground: '#1F2328',
  black: '#1F2328',
  red: '#CF222E',
  green: '#1A7F37',
  yellow: '#9A6700',
  blue: '#0969DA',
  magenta: '#8250DF',
  cyan: '#0A6B5E',
  white: '#6E7781',
  brightBlack: '#57606A',
  brightRed: '#A40E26',
  brightGreen: '#116329',
  brightYellow: '#7D4E00',
  brightBlue: '#0550AE',
  brightMagenta: '#6639BA',
  brightCyan: '#096A5E',
  brightWhite: '#8C959F',
};

function getTerminalTheme() {
  return currentSettings.theme === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;
}

function createTerminal(): { terminal: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
  const terminal = new Terminal({
    fontFamily: currentSettings.fontFamily,
    fontSize: currentSettings.fontSize,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: currentSettings.scrollbackLimit,
    theme: getTerminalTheme(),
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.loadAddon(searchAddon);

  return { terminal, fitAddon, searchAddon };
}

// ============================================
// #2: Pane Management
// ============================================

function createPaneLeaf(tabId: string, paneIndex: number): PaneLeaf {
  const { terminal, fitAddon, searchAddon } = createTerminal();
  const container = document.createElement('div');
  container.className = 'pane-leaf';
  const paneId = `${tabId}:pane-${paneIndex}`;
  container.dataset.paneId = paneId;

  // Click to make active pane
  container.addEventListener('mousedown', () => {
    const tab = tabs.get(tabId);
    if (tab && tab.activePaneId !== paneId) {
      setActivePane(tabId, paneId);
    }
  });

  // Right-click context menu on terminal pane
  container.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    showTerminalContextMenu(e.clientX, e.clientY, tabId, paneId);
  });

  // Ctrl+C: copy if selection exists, else send SIGINT
  // Ctrl+V: paste from clipboard
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;

    if (e.ctrlKey && e.key === 'c' && !e.shiftKey && !e.altKey) {
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection);
        terminal.clearSelection();
        return false;
      }
      return true;
    }

    if (e.ctrlKey && e.key === 'v' && !e.shiftKey && !e.altKey) {
      navigator.clipboard.readText().then(text => {
        if (text) api.pty.write(paneId, text);
      });
      return false;
    }

    return true;
  });

  return {
    type: 'leaf',
    id: paneId,
    terminal,
    fitAddon,
    searchAddon,
    container,
    pid: null,
    status: 'idle',
    dataDisposable: null,
    resizeDisposable: null,
  };
}

function findPaneById(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findPaneById(node.children[0], id) || findPaneById(node.children[1], id);
}

function findAllLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node];
  return [...findAllLeaves(node.children[0]), ...findAllLeaves(node.children[1])];
}

function getActivePane(tabState: TabState): PaneLeaf | null {
  return findPaneById(tabState.paneRoot, tabState.activePaneId);
}

function setActivePane(tabId: string, paneId: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;

  // Remove active-pane from all leaves
  findAllLeaves(tab.paneRoot).forEach(leaf => {
    leaf.container.classList.remove('active-pane');
  });

  tab.activePaneId = paneId;
  const pane = findPaneById(tab.paneRoot, paneId);
  if (pane && pane.type === 'leaf') {
    pane.container.classList.add('active-pane');
    pane.terminal.focus();
  }
}

function renderPaneTree(node: PaneNode, parentEl: HTMLElement, workspaceId?: string): void {
  if (node.type === 'leaf') {
    parentEl.appendChild(node.container);
    return;
  }

  node.container = document.createElement('div');
  node.container.className = `pane-split ${node.direction}`;

  // Find tabId from the first leaf if not passed
  const wsId = workspaceId || findAllLeaves(node)[0]?.id.split(':pane-')[0];

  const child0Wrapper = document.createElement('div');
  child0Wrapper.className = 'pane-child-wrapper';
  child0Wrapper.style.flex = `${node.ratio}`;
  renderPaneTree(node.children[0], child0Wrapper, wsId);
  addPaneCloseButton(child0Wrapper, node.children[0], wsId);
  node.container.appendChild(child0Wrapper);

  // Resize handle
  const handle = document.createElement('div');
  handle.className = `pane-resize-handle ${node.direction}`;
  setupResizeHandle(handle, node, child0Wrapper);
  node.container.appendChild(handle);

  const child1Wrapper = document.createElement('div');
  child1Wrapper.className = 'pane-child-wrapper';
  child1Wrapper.style.flex = `${1 - node.ratio}`;
  renderPaneTree(node.children[1], child1Wrapper, wsId);
  addPaneCloseButton(child1Wrapper, node.children[1], wsId);
  node.container.appendChild(child1Wrapper);

  parentEl.appendChild(node.container);
}

function addPaneCloseButton(wrapper: HTMLElement, childNode: PaneNode, workspaceId: string): void {
  // Only add close button to leaf panes (not nested splits)
  if (childNode.type !== 'leaf') return;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close-btn';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close pane';
  closeBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    closePaneById(workspaceId, childNode.id);
  });
  wrapper.appendChild(closeBtn);
}

function setupResizeHandle(handle: HTMLElement, split: PaneSplit, firstChildWrapper: HTMLElement): void {
  let startPos = 0;
  let startRatio = 0;

  const onMouseMove = (e: MouseEvent) => {
    const parentRect = split.container.getBoundingClientRect();
    const isHorizontal = split.direction === 'horizontal';
    const totalSize = isHorizontal ? parentRect.width : parentRect.height;
    const delta = isHorizontal ? (e.clientX - startPos) : (e.clientY - startPos);
    const newRatio = Math.max(0.1, Math.min(0.9, startRatio + delta / totalSize));

    split.ratio = newRatio;
    firstChildWrapper.style.flex = `${newRatio}`;
    const secondWrapper = handle.nextElementSibling as HTMLElement;
    if (secondWrapper) secondWrapper.style.flex = `${1 - newRatio}`;

    // Refit all terminals in this tab
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab) {
        requestAnimationFrame(() => {
          findAllLeaves(tab.paneRoot).forEach(leaf => {
            try { leaf.fitAddon.fit(); } catch {}
          });
        });
      }
    }
  };

  const onMouseUp = () => {
    handle.classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Save layout after resize
    if (activeTabId) savePaneLayout(activeTabId);
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('resizing');
    startPos = split.direction === 'horizontal' ? e.clientX : e.clientY;
    startRatio = split.ratio;
    document.body.style.cursor = split.direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function rebuildPaneDOM(tabId: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const wrapper = terminalContainer.querySelector(`.terminal-wrapper[data-id="${tabId}"]`);
  if (!wrapper) return;

  wrapper.innerHTML = '';
  renderPaneTree(tab.paneRoot, wrapper as HTMLElement);

  // Open and fit all terminals, then add close buttons
  requestAnimationFrame(() => {
    findAllLeaves(tab.paneRoot).forEach(leaf => {
      if (!leaf.terminal.element) {
        leaf.terminal.open(leaf.container);
      }
      try { leaf.fitAddon.fit(); } catch {}
    });
  });
}

async function splitPane(tabId: string, direction: 'horizontal' | 'vertical'): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const activePane = getActivePane(tab);
  if (!activePane) return;

  tab.paneCounter++;
  const newLeaf = createPaneLeaf(tabId, tab.paneCounter);

  const splitNode: PaneSplit = {
    type: 'split',
    direction,
    children: [activePane, newLeaf],
    ratio: 0.5,
    container: document.createElement('div'),
  };

  // Replace the leaf in the tree with the split
  replacePaneInTree(tab, activePane, splitNode);

  rebuildPaneDOM(tabId);

  // Spawn PTY for new pane
  await spawnPaneTerminal(tabId, newLeaf);
  setActivePane(tabId, newLeaf.id);

  // Save layout after split
  savePaneLayout(tabId);
}

// ============================================
// Pane Layout Persistence
// ============================================

function serializePaneTree(node: PaneNode): SerializedPaneNode {
  if (node.type === 'leaf') {
    return { type: 'leaf', id: node.id };
  }
  return {
    type: 'split',
    direction: node.direction,
    children: [serializePaneTree(node.children[0]), serializePaneTree(node.children[1])],
    ratio: node.ratio,
  };
}

function deserializePaneTree(node: SerializedPaneNode, tabId: string, tab: TabState): PaneNode {
  if (node.type === 'leaf') {
    // Extract pane index from id like "wsid:pane-3" or "wsid~1:pane-3"
    const match = node.id.match(/:pane-(\d+)$/);
    const paneIndex = match ? parseInt(match[1], 10) : tab.paneCounter++;
    if (paneIndex >= tab.paneCounter) tab.paneCounter = paneIndex + 1;
    return createPaneLeaf(tabId, paneIndex);
  }
  const splitNode = node as SerializedPaneSplit;
  const child0 = deserializePaneTree(splitNode.children[0], tabId, tab);
  const child1 = deserializePaneTree(splitNode.children[1], tabId, tab);
  return {
    type: 'split',
    direction: splitNode.direction,
    children: [child0, child1],
    ratio: splitNode.ratio,
    container: document.createElement('div'),
  };
}

function savePaneLayout(tabId: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const serialized = serializePaneTree(tab.paneRoot);
  // Save layout keyed by workspace ID (shared across tab instances)
  api.app.savePaneLayout(tab.workspace.id, serialized);
}

function replacePaneInTree(tab: TabState, target: PaneNode, replacement: PaneNode): void {
  if (tab.paneRoot === target) {
    tab.paneRoot = replacement;
    return;
  }
  replaceInNode(tab.paneRoot, target, replacement);
}

function replaceInNode(node: PaneNode, target: PaneNode, replacement: PaneNode): boolean {
  if (node.type !== 'split') return false;
  for (let i = 0; i < 2; i++) {
    if (node.children[i] === target) {
      node.children[i] = replacement;
      return true;
    }
    if (replaceInNode(node.children[i], target, replacement)) return true;
  }
  return false;
}

function closePaneById(tabId: string, paneId: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const pane = findPaneById(tab.paneRoot, paneId);
  if (!pane || pane.type !== 'leaf') return;

  // If this is the only pane, close the tab instead
  if (tab.paneRoot === pane) {
    closeTab(tabId);
    return;
  }

  // Kill PTY for this pane
  api.pty.kill(pane.id);
  pane.terminal.dispose();

  // Find parent split and replace it with sibling
  const sibling = findSiblingAndRemove(tab, pane);
  if (sibling) {
    rebuildPaneDOM(tabId);
    // Set active to first leaf of sibling
    const leaves = findAllLeaves(sibling);
    if (leaves.length > 0) {
      setActivePane(tabId, leaves[0].id);
    }
    savePaneLayout(tabId);
  }
}

function findSiblingAndRemove(tab: TabState, target: PaneLeaf): PaneNode | null {
  return findSiblingInNode(tab, tab.paneRoot, target);
}

// Close the split in a given direction relative to the active pane.
// 'vertical' closes a down split, 'horizontal' closes a right split.
// Keeps the active pane, removes the sibling.
function closeSplitDirection(tabId: string, direction: 'horizontal' | 'vertical'): void {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const activePane = getActivePane(tab);
  if (!activePane) return;

  // Find the parent split of the active pane that matches the direction
  const parentSplit = findParentSplit(tab.paneRoot, activePane, direction);
  if (!parentSplit) return;

  // Determine which child is the active pane (or contains it) and which is the sibling to remove
  const activeIndex = containsPane(parentSplit.children[0], activePane) ? 0 : 1;
  const siblingNode = parentSplit.children[1 - activeIndex];

  // Kill all PTYs in the sibling subtree
  const siblingLeaves = findAllLeaves(siblingNode);
  for (const leaf of siblingLeaves) {
    api.pty.kill(leaf.id);
    leaf.terminal.dispose();
  }

  // Replace the parent split with the child that contains the active pane
  const survivor = parentSplit.children[activeIndex];
  replacePaneInTree(tab, parentSplit, survivor);

  rebuildPaneDOM(tabId);

  // Ensure active pane is still set
  const survivorLeaves = findAllLeaves(survivor);
  if (survivorLeaves.length > 0 && !survivorLeaves.find(l => l.id === tab.activePaneId)) {
    setActivePane(tabId, survivorLeaves[0].id);
  }

  savePaneLayout(tabId);
}

function findParentSplit(node: PaneNode, target: PaneLeaf, direction: 'horizontal' | 'vertical'): PaneSplit | null {
  if (node.type !== 'split') return null;

  // Check if either child is (or contains) the target
  for (let i = 0; i < 2; i++) {
    if (containsPane(node.children[i], target)) {
      // If this split matches the direction and the child directly is or contains the target, this is a match
      if (node.direction === direction) {
        // But first check deeper — a nested split of the same direction closer to the target takes priority
        if (node.children[i].type === 'split') {
          const deeper = findParentSplit(node.children[i], target, direction);
          if (deeper) return deeper;
        }
        return node;
      }
      // Direction doesn't match, recurse deeper
      return findParentSplit(node.children[i], target, direction);
    }
  }
  return null;
}

function containsPane(node: PaneNode, target: PaneLeaf): boolean {
  if (node === target) return true;
  if (node.type !== 'split') return false;
  return containsPane(node.children[0], target) || containsPane(node.children[1], target);
}

function findSiblingInNode(tab: TabState, node: PaneNode, target: PaneLeaf): PaneNode | null {
  if (node.type !== 'split') return null;
  for (let i = 0; i < 2; i++) {
    if (node.children[i] === target) {
      const sibling = node.children[1 - i];
      replacePaneInTree(tab, node, sibling);
      return sibling;
    }
    const result = findSiblingInNode(tab, node.children[i], target);
    if (result) return result;
  }
  return null;
}

function getEffectiveStartupCommand(workspace: Workspace): string {
  const cmd = workspace.startupCommand || '';
  const mode = workspace.sessionResumeMode ?? 'continue';

  // Only modify commands where "claude" is the executable (first token)
  if (!/^claude(\s|$)/.test(cmd.trim())) return cmd;
  if (mode === 'off') return cmd;
  if (cmd.includes('--resume') || cmd.includes('--continue')) return cmd;

  if (mode === 'continue') {
    return cmd.trim().replace(/^claude/, 'claude --continue');
  }

  // mode === 'resume': use stored session ID if available
  if (!workspace.lastClaudeSessionId) return cmd;
  return cmd.trim().replace(/^claude/, `claude --resume ${workspace.lastClaudeSessionId}`);
}

async function spawnPaneTerminal(tabId: string, pane: PaneLeaf, startupDelayMs = 600): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const baseWsId = tab.workspace.id;

  pane.status = 'starting';

  // Dispose previous data listener to prevent duplicates on restart
  if (pane.dataDisposable) pane.dataDisposable.dispose();

  // Wire up input
  pane.dataDisposable = pane.terminal.onData((data) => {
    api.pty.write(pane.id, data);
  });

  const result = await api.pty.spawn({
    workspaceId: pane.id,
    cwd: tab.workspace.cwd,
    shell: tab.workspace.shell,
    env: tab.workspace.env,
    cols: pane.terminal.cols,
    rows: pane.terminal.rows,
  });

  if ('scanRequired' in result && (result as any).scanRequired) {
    pane.status = 'idle';
    pane.terminal.writeln('\r\n\x1b[33m[Shield] Repo scan required before launch...\x1b[0m\r\n');
    pendingScanSpawns.add(tabId);
    showScanOverlay(tabId);
    triggerScan(baseWsId);
    return;
  }

  if ('error' in result) {
    pane.terminal.writeln(`\r\n\x1b[31mFailed to start terminal: ${result.error}\x1b[0m`);
    pane.status = 'dead';
    return;
  }

  pane.pid = result.pid;
  pane.status = 'running';

  // Send startup command for main pane only (pane-0)
  if (pane.id.endsWith(':pane-0') && tab.workspace.startupCommand) {
    const command = getEffectiveStartupCommand(tab.workspace);
    const isResuming = command !== tab.workspace.startupCommand;
    if (isResuming) {
      tab._resumeAttemptTime = Date.now();
      showToast('\u21BB Resuming Session', `${tab.workspace.name}: picking up where you left off`, 'var(--cyan, #39D2C0)', 5000);

      // Watch PTY output for resume failure — only for 'resume' mode (stale ID).
      // 'continue' mode gracefully starts a new session if none exists, so no watcher needed.
      let resumeOutputBuffer = '';
      const resumeCheckCleanup = api.pty.onData(({ workspaceId: paneId, data }) => {
        if (paneId !== pane.id || !tab._resumeAttemptTime) return;
        if ((tab.workspace.sessionResumeMode ?? 'continue') !== 'resume') return;
        resumeOutputBuffer += data;
        if (resumeOutputBuffer.includes('No conversation found') || resumeOutputBuffer.includes('No session found')) {
          tab._resumeAttemptTime = null;
          tab.workspace.lastClaudeSessionId = undefined;
          api.workspace.update(baseWsId, { lastClaudeSessionId: undefined });
          showToast('\u26A0 Resume Failed', `${tab.workspace.name}: starting fresh session`, 'var(--orange, #D29922)', 5000);
          // Send fresh claude command after a short delay
          setTimeout(() => {
            if (tab.workspace.startupCommand) {
              api.pty.writeCommand(pane.id, tab.workspace.startupCommand, 500);
            }
          }, 1500);
          resumeCheckCleanup();
        }
      });

      // Stop watching after 15s regardless (session started successfully)
      setTimeout(() => {
        if (tab._resumeAttemptTime) tab._resumeAttemptTime = null;
        resumeCheckCleanup();
      }, 15000);
    }
    api.pty.writeCommand(pane.id, command, startupDelayMs);
  }

  if (pane.resizeDisposable) pane.resizeDisposable.dispose();
  pane.resizeDisposable = pane.terminal.onResize(({ cols, rows }) => {
    api.pty.resize(pane.id, cols, rows);
  });
}

// ============================================
// Repo Scan Overlay & Results
// ============================================

function showScanOverlay(tabOrWsId: string, incremental: boolean = false): void {
  // tabOrWsId can be either a tabId or workspaceId
  const wrapper = terminalContainer.querySelector(`.terminal-wrapper[data-id="${tabOrWsId}"]`);
  if (!wrapper) return;

  // Remove existing overlay if any
  hideScanOverlay(tabOrWsId);

  const overlay = document.createElement('div');
  overlay.className = 'scan-overlay';
  overlay.innerHTML = `
    <div class="scan-overlay-title">${incremental ? 'Scanning changes...' : 'Scanning repository...'}</div>
    <div class="scan-progress-bar"><div class="scan-progress-fill" style="width: 0%"></div></div>
    <div class="scan-overlay-stats">
      <span>Files: <strong class="scan-files-count">0</strong></span>
      <span>Findings: <strong class="scan-findings-count">0</strong></span>
    </div>
    <div class="scan-overlay-file"></div>
    <button class="btn-secondary scan-cancel-btn">Cancel</button>
  `;

  const cancelBtn = overlay.querySelector('.scan-cancel-btn')!;
  const wsId = tabOrWsId.includes('~') ? getWorkspaceIdFromTabId(tabOrWsId) : tabOrWsId;
  cancelBtn.addEventListener('click', () => {
    const state = scanStates.get(wsId);
    if (state?.jobId) {
      api.shield.cancelScan(state.jobId);
    }
    hideScanOverlay(tabOrWsId);
    pendingScanSpawns.delete(tabOrWsId);
  });

  wrapper.appendChild(overlay);
  scanOverlays.set(tabOrWsId, overlay);

  // Update tab scan indicator
  updateTabScanBadge(tabOrWsId, 'scanning');
}

function updateScanOverlay(workspaceId: string, progress: ScanProgress): void {
  const overlay = scanOverlays.get(workspaceId);
  if (!overlay) return;

  const fill = overlay.querySelector('.scan-progress-fill') as HTMLElement;
  const filesCount = overlay.querySelector('.scan-files-count')!;
  const findingsCount = overlay.querySelector('.scan-findings-count')!;
  const fileLabel = overlay.querySelector('.scan-overlay-file')!;
  const title = overlay.querySelector('.scan-overlay-title')!;

  if (fill) fill.style.width = `${Math.min(progress.percent, 100)}%`;
  filesCount.textContent = `${progress.filesScanned}/${progress.filesFound}`;
  findingsCount.textContent = String(progress.findingsCount);
  if (progress.currentFile) {
    fileLabel.textContent = progress.currentFile;
  }
  if (progress.phase === 'walking') {
    title.textContent = 'Discovering files...';
  } else if (progress.phase === 'scanning') {
    title.textContent = 'Scanning repository...';
  }
}

function hideScanOverlay(workspaceId: string): void {
  const overlay = scanOverlays.get(workspaceId);
  if (overlay) {
    overlay.remove();
    scanOverlays.delete(workspaceId);
  }
}

async function triggerScan(workspaceId: string, options?: { incremental?: boolean }): Promise<void> {
  const result = await api.shield.startScan(workspaceId, options);
  if ('error' in result) {
    hideScanOverlay(workspaceId);
    showToast('Scan Failed', (result as any).error, 'var(--red)', 5000);
    pendingScanSpawns.delete(workspaceId);
    return;
  }
  scanStates.set(workspaceId, { jobId: (result as any).jobId });
}

function handleScanProgress(progress: ScanProgress): void {
  const state = scanStates.get(progress.workspaceId) || {};
  state.progress = progress;
  scanStates.set(progress.workspaceId, state);
  updateScanOverlay(progress.workspaceId, progress);
}

function handleScanResult(result: ScanResult): void {
  const state = scanStates.get(result.workspaceId) || {};
  state.result = result;
  scanStates.set(result.workspaceId, state);

  // Hide scan overlay on all tabs for this workspace
  for (const tab of getTabsForWorkspace(result.workspaceId)) {
    hideScanOverlay(tab.tabId);
  }

  if (result.passed) {
    updateTabScanBadge(result.workspaceId, 'passed');
    const incrementalLabel = result.incremental ? ` (incremental, ${result.changedFiles ?? result.filesScanned} changed)` : '';
    showToast('Scan Passed', `${result.filesScanned} files scanned${incrementalLabel}, no issues found`, 'var(--green)', 3000);

    // Auto-retry spawn for any tab instances waiting on scan
    for (const pendingTabId of Array.from(pendingScanSpawns)) {
      const pendingTab = tabs.get(pendingTabId);
      if (pendingTab && pendingTab.workspace.id === result.workspaceId) {
        pendingScanSpawns.delete(pendingTabId);
        const pane = getActivePane(pendingTab);
        if (pane) {
          setTimeout(() => spawnPaneTerminal(pendingTabId, pane), 200);
        }
      }
    }
  } else {
    updateTabScanBadge(result.workspaceId, 'failed');
    showScanResultsModal(result);
  }
}

function showScanResultsModal(result: ScanResult): void {
  const firstTab = getFirstTabForWorkspace(result.workspaceId);
  const wsName = firstTab?.workspace.name || result.workspaceId;

  // Hide Force Launch button if bypass is disabled by policy
  const allowBypass = firstTab?.workspace.scanConfig?.allowScanBypass !== false; // default true
  scanResultsForce.style.display = allowBypass ? '' : 'none';

  scanResultsTitle.textContent = `Scan Results: ${wsName}`;

  // Summary
  const critCount = result.findings.filter(f => f.severity === 'critical').length;
  const highCount = result.findings.filter(f => f.severity === 'high').length;
  const medCount = result.findings.filter(f => f.severity === 'medium').length;
  const lowCount = result.findings.filter(f => f.severity === 'low').length;
  const incrementalNote = result.incremental ? ` <span style="color: var(--text-muted);">(incremental — ${result.changedFiles ?? result.filesScanned} changed)</span>` : '';
  scanResultsSummary.innerHTML = `
    <span>${result.filesScanned} files scanned${incrementalNote}</span>
    <span>${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''}</span>
    ${critCount > 0 ? `<span style="color: var(--red);">${critCount} critical</span>` : ''}
    ${highCount > 0 ? `<span style="color: var(--orange);">${highCount} high</span>` : ''}
    ${medCount > 0 ? `<span style="color: var(--accent);">${medCount} medium</span>` : ''}
    ${lowCount > 0 ? `<span style="color: var(--text-muted);">${lowCount} low</span>` : ''}
  `;

  // Findings list sorted by severity
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...result.findings].sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  const validSeverities = ['low', 'medium', 'high', 'critical'];
  scanResultsList.innerHTML = sorted.map(f => {
    const safeSeverity = validSeverities.includes(f.severity) ? f.severity : 'low';
    return `
    <div class="scan-finding-row">
      <div class="scan-finding-header">
        <span class="scan-finding-file">${escapeHtml(f.file)}${f.line ? `:${f.line}` : ''}</span>
        <span class="scan-finding-severity ${safeSeverity}">${escapeHtml(f.severity)}</span>
      </div>
      <div class="scan-finding-desc">${escapeHtml(f.description)}</div>
      <div class="scan-finding-category">${escapeHtml(f.category)}</div>
      ${f.snippet ? `<div class="scan-finding-snippet">${escapeHtml(f.snippet)}</div>` : ''}
    </div>
  `;
  }).join('');

  // Store current workspaceId on the overlay for button handlers
  scanResultsOverlay.dataset.workspaceId = result.workspaceId;

  scanResultsOverlay.classList.remove('hidden');
}

function closeScanResultsModal(): void {
  scanResultsOverlay.classList.add('hidden');
  const wsId = scanResultsOverlay.dataset.workspaceId;
  if (wsId) pendingScanSpawns.delete(wsId);
}

function updateTabScanBadge(tabOrWsId: string, status: 'scanning' | 'passed' | 'failed' | 'none'): void {
  // Update scan badge on all tab instances for the workspace
  const wsId = tabOrWsId.includes('~') ? getWorkspaceIdFromTabId(tabOrWsId) : tabOrWsId;
  const wsTabs = getTabsForWorkspace(wsId);
  // If no tabs matched by workspace, try as direct tab ID
  const tabIds = wsTabs.length > 0 ? wsTabs.map(t => t.tabId) : [tabOrWsId];

  for (const tid of tabIds) {
    const tabEl = tabList.querySelector(`.tab[data-id="${tid}"]`);
    if (!tabEl) continue;

    let badge = tabEl.querySelector('.tab-scan-indicator') as HTMLElement;
    if (status === 'none') {
      if (badge) badge.remove();
      continue;
    }

    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tab-scan-indicator';
      const closeBtn = tabEl.querySelector('.tab-close');
      if (closeBtn) {
        tabEl.insertBefore(badge, closeBtn);
      } else {
        tabEl.appendChild(badge);
      }
    }

    badge.className = `tab-scan-indicator ${status}`;
    if (status === 'scanning') {
      badge.innerHTML = '&#x21BB;'; // ↻
      badge.title = 'Scanning...';
    } else if (status === 'passed') {
      badge.innerHTML = '&#x2713;'; // ✓
      badge.title = 'Scan passed';
    } else if (status === 'failed') {
      badge.innerHTML = '&#x2717;'; // ✗
      badge.title = 'Scan failed — click for details';
      badge.style.cursor = 'pointer';
      badge.onclick = () => {
        const state = scanStates.get(wsId);
        if (state?.result) showScanResultsModal(state.result);
      };
    }
  }
}

// Scan results modal event handlers
scanResultsClose.addEventListener('click', closeScanResultsModal);
scanResultsOverlay.addEventListener('click', (e) => {
  if (e.target === scanResultsOverlay) closeScanResultsModal();
});
scanResultsOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeScanResultsModal();
});

scanResultsRescan.addEventListener('click', () => {
  const wsId = scanResultsOverlay.dataset.workspaceId;
  if (wsId) {
    closeScanResultsModal();
    // Show overlay on the active tab if it belongs to this workspace, or first tab
    const activeTab = activeTabId ? tabs.get(activeTabId) : null;
    const overlayTabId = (activeTab && activeTab.workspace.id === wsId) ? activeTab.tabId : getFirstTabForWorkspace(wsId)?.tabId;
    if (overlayTabId) showScanOverlay(overlayTabId);
    triggerScan(wsId);
  }
});

scanResultsForce.addEventListener('click', async () => {
  const wsId = scanResultsOverlay.dataset.workspaceId;
  if (!wsId) return;
  // Guard: respect allowScanBypass policy
  const wsTab = getFirstTabForWorkspace(wsId);
  if (wsTab?.workspace.scanConfig?.allowScanBypass === false) return;
  {
    closeScanResultsModal();
    // Force-spawn the terminal bypassing scan gate — spawn for all pending tabs
    const tab = getFirstTabForWorkspace(wsId);
    if (tab) {
      const pane = getActivePane(tab);
      if (pane) {
        pane.terminal.writeln('\r\n\x1b[33m[Shield] Force-launching despite scan findings...\x1b[0m\r\n');
        // Spawn with bypassScanGate flag to skip enforce-before-spawn check
        pane.status = 'starting';
        if (pane.dataDisposable) pane.dataDisposable.dispose();
        pane.dataDisposable = pane.terminal.onData((data) => {
          api.pty.write(pane.id, data);
        });
        const result = await api.pty.spawn({
          workspaceId: pane.id,
          cwd: tab.workspace.cwd,
          shell: tab.workspace.shell,
          env: tab.workspace.env,
          cols: pane.terminal.cols,
          rows: pane.terminal.rows,
          bypassScanGate: true,
        });
        if ('error' in result) {
          pane.terminal.writeln(`\r\n\x1b[31mFailed to start terminal: ${(result as any).error}\x1b[0m`);
          pane.status = 'dead';
        } else {
          pane.pid = (result as any).pid;
          pane.status = 'running';
          if (pane.id.endsWith(':pane-0') && tab.workspace.startupCommand) {
            const command = getEffectiveStartupCommand(tab.workspace);
            api.pty.writeCommand(pane.id, command, 600);
          }
          if (pane.resizeDisposable) pane.resizeDisposable.dispose();
          pane.resizeDisposable = pane.terminal.onResize(({ cols, rows }) => {
            api.pty.resize(pane.id, cols, rows);
          });
        }
      }
    }
  }
});

// ============================================
// Sidebar
// ============================================

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible;
  sidebar.classList.toggle('hidden', !sidebarVisible);
  sidebarToggleBtn.classList.toggle('active', sidebarVisible);

  // Refit terminals after sidebar transition
  setTimeout(() => {
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab) {
        findAllLeaves(tab.paneRoot).forEach(leaf => {
          try { leaf.fitAddon.fit(); } catch {}
        });
      }
    }
  }, 250);
}

function renderSidebar(): void {
  const filterText = sidebarFilter.value.trim().toLowerCase();
  sidebarList.innerHTML = '';

  // Group workspaces
  const grouped = new Map<string, Workspace[]>();
  const ungrouped: Workspace[] = [];

  for (const ws of allWorkspaces) {
    // Apply filter
    if (filterText && !ws.name.toLowerCase().includes(filterText) && !ws.cwd.toLowerCase().includes(filterText)) {
      continue;
    }
    if (ws.group) {
      if (!grouped.has(ws.group)) grouped.set(ws.group, []);
      grouped.get(ws.group)!.push(ws);
    } else {
      ungrouped.push(ws);
    }
  }

  // Render grouped
  for (const [groupName, workspaces] of grouped) {
    const isCollapsed = groupStates.get(groupName) || false;

    const header = document.createElement('div');
    header.className = 'sidebar-group-header';

    const chevron = document.createElement('span');
    chevron.className = `group-chevron${isCollapsed ? ' collapsed' : ''}`;
    chevron.textContent = '\u25BC';

    const label = document.createElement('span');
    label.textContent = groupName;

    header.appendChild(chevron);
    header.appendChild(label);
    header.addEventListener('click', () => {
      api.workspace.toggleGroup(groupName).then((g: WorkspaceGroup) => {
        groupStates.set(groupName, g.collapsed);
        renderSidebar();
        renderTabBar();
      });
    });

    sidebarList.appendChild(header);

    if (!isCollapsed) {
      for (const ws of workspaces) {
        sidebarList.appendChild(createSidebarItem(ws));
      }
    }
  }

  // Render ungrouped
  for (const ws of ungrouped) {
    sidebarList.appendChild(createSidebarItem(ws));
  }

  // Empty message
  if (sidebarList.children.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 20px 12px; text-align: center; color: var(--text-muted); font-size: 12px;';
    empty.textContent = filterText ? 'No matching workspaces' : 'No workspaces yet';
    sidebarList.appendChild(empty);
  }
}

function createSidebarItem(ws: Workspace): HTMLDivElement {
  const isOpen = hasOpenTabsForWorkspace(ws.id);
  const openCount = getTabsForWorkspace(ws.id).length;
  const activeTab = activeTabId ? tabs.get(activeTabId) : null;
  const isActive = activeTab?.workspace.id === ws.id;

  const item = document.createElement('div');
  item.className = `sidebar-item${isActive ? ' active' : ''}${!isOpen ? ' closed' : ''}`;
  item.dataset.id = ws.id;
  item.setAttribute('role', 'listitem');
  item.setAttribute('tabindex', '0');
  item.setAttribute('aria-label', `${ws.name}${isOpen ? ' (open)' : ''}`);

  const dot = document.createElement('span');
  dot.className = `sidebar-item-dot${isOpen ? ' open' : ''}`;
  dot.style.color = ws.color;
  dot.style.background = ws.color;

  const name = document.createElement('span');
  name.className = 'sidebar-item-name';
  name.textContent = ws.name;

  const actions = document.createElement('span');
  actions.className = 'sidebar-item-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'sidebar-item-action';
  editBtn.title = 'Edit';
  editBtn.setAttribute('aria-label', `Edit ${ws.name}`);
  editBtn.innerHTML = '&#9998;'; // ✎ pencil
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModalForWorkspace(ws);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'sidebar-item-action danger';
  deleteBtn.title = 'Delete';
  deleteBtn.setAttribute('aria-label', `Delete ${ws.name}`);
  deleteBtn.innerHTML = '&#128465;'; // 🗑 trash
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSidebarWorkspace(ws);
  });

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  item.appendChild(dot);
  item.appendChild(name);

  // Show count badge when multiple tabs open for same workspace
  if (openCount > 1) {
    const countBadge = document.createElement('span');
    countBadge.className = 'sidebar-item-count';
    countBadge.textContent = String(openCount);
    item.appendChild(countBadge);
  }

  item.appendChild(actions);

  // Click to open or switch to workspace
  item.addEventListener('click', () => {
    openWorkspaceFromSidebar(ws);
  });

  // Right-click context menu on sidebar item
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const items = [
      { label: 'New Tab', action: async () => {
        const newTabId = await addWorkspaceTab(ws);
        activateTab(newTabId);
        renderSidebar();
      }},
      { label: 'Edit Workspace', action: () => openEditModalForWorkspace(ws) },
      { label: 'Discover Skills & Agents', action: async () => {
        await openLibraryPanel();
        showDiscoverResults();
        libDiscoverList.innerHTML = '<div class="library-discover-empty">Scanning workspace...</div>';
        libDiscoverCount.textContent = '';
        try {
          // Reuse discoverAll but filter to this workspace after
          const all = await api.library.discoverAll();
          discoveredItems = all.filter(item => item.workspaceId === ws.id);
        } catch {
          discoveredItems = [];
        }
        renderDiscoverResults();
      }},
      { separator: true },
      { label: 'Delete Workspace', action: () => deleteSidebarWorkspace(ws), danger: true },
    ];

    for (const mi of items) {
      if ('separator' in mi) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        menu.appendChild(sep);
      } else {
        const el = document.createElement('div');
        el.className = `context-menu-item${(mi as any).danger ? ' danger' : ''}`;
        el.setAttribute('role', 'menuitem');
        const lbl = document.createElement('span');
        lbl.textContent = mi.label!;
        el.appendChild(lbl);
        el.addEventListener('click', () => { closeContextMenu(); (mi as any).action(); });
        menu.appendChild(el);
      }
    }

    document.body.appendChild(menu);
    activeContextMenu = menu;
    setTimeout(() => { document.addEventListener('click', closeContextMenu, { once: true }); }, 0);
  });

  return item;
}

function openWorkspaceFromSidebar(ws: Workspace): void {
  const wsTabs = getTabsForWorkspace(ws.id);
  if (wsTabs.length === 1) {
    // Single tab — activate it
    activateTab(wsTabs[0].tabId);
  } else if (wsTabs.length > 1) {
    // Multiple tabs — activate the first one
    activateTab(wsTabs[0].tabId);
  } else {
    // No tabs open — create new
    addWorkspaceTab(ws).then((newTabId) => {
      activateTab(newTabId);
      renderSidebar();
    });
  }
}

function openEditModalForWorkspace(ws: Workspace): void {
  editingWorkspaceId = ws.id;
  modalTitle.textContent = 'Edit Workspace';
  wsNameInput.value = ws.name;
  wsCwdInput.value = ws.cwd;
  wsCommandInput.value = ws.startupCommand || '';
  wsAutostartInput.checked = ws.autoStart;
  wsAutorestartInput.checked = ws.autoRestart || false;
  wsMaxRestartsInput.value = String(ws.maxRestarts || 3);
  maxRestartsGroup.style.display = ws.autoRestart ? '' : 'none';
  wsGroupInput.value = ws.group || '';
  wsResumeModeSelect.value = ws.sessionResumeMode || 'continue';
  const isClaudeCmdEdit = /^claude(\s|$)/i.test(ws.startupCommand?.trim() || '');
  resumeModeGroup.style.display = isClaudeCmdEdit ? '' : 'none';
  templateGroup.style.display = 'none';
  selectedColor = ws.color;
  initColorPicker();
  // Hide scaffold mode toggle in edit mode
  scaffoldModeToggle.style.display = 'none';
  scaffoldMode = false;
  toggleScaffoldMode(false);
  // Hide library checklist in edit mode (push via library panel instead)
  wsLibraryGroup.style.display = 'none';
  // Scan config fields
  if (shieldSupportsScanning) {
    scanPolicyGroup.style.display = '';
    scanBackgroundGroup.style.display = '';
    scanBypassGroup.style.display = '';
    scanThresholdGroup.style.display = '';
    scanExcludeGroup.style.display = '';
    wsScanPolicySelect.value = ws.scanConfig?.enforcementMode || 'off';
    wsScanBackgroundInput.checked = ws.scanConfig?.backgroundScanEnabled || false;
    wsScanBypassInput.checked = ws.scanConfig?.allowScanBypass !== false;
    wsScanThresholdSelect.value = ws.scanConfig?.scanFailThreshold || 'high';
    wsScanExcludeTextarea.value = ws.scanConfig?.excludePatterns?.join('\n') || '';
  } else {
    scanPolicyGroup.style.display = 'none';
    scanBackgroundGroup.style.display = 'none';
    scanBypassGroup.style.display = 'none';
    scanThresholdGroup.style.display = 'none';
    scanExcludeGroup.style.display = 'none';
  }
  // Auto-expand advanced section if any advanced fields are set
  const hasAdvancedFields = !!(ws.group || !ws.autoStart || ws.autoRestart || ws.sessionResumeMode === 'off' || ws.sessionResumeMode === 'resume' || ws.scanConfig);
  wsAdvancedSection.classList.toggle('expanded', hasAdvancedFields);
  wsAdvancedChevron.classList.toggle('expanded', hasAdvancedFields);
  wsAdvancedToggle.setAttribute('aria-expanded', String(hasAdvancedFields));
  modalOverlay.classList.remove('hidden');
  wsNameInput.focus();
}

async function deleteSidebarWorkspace(ws: Workspace): Promise<void> {
  const confirmed = confirm(`Delete workspace "${ws.name}"? This removes it permanently.`);
  if (!confirmed) return;

  // Close ALL tab instances for this workspace
  const wsTabs = getTabsForWorkspace(ws.id);
  for (const tab of wsTabs) {
    closeTab(tab.tabId);
  }

  await api.workspace.delete(ws.id);

  // Remove from allWorkspaces
  allWorkspaces = allWorkspaces.filter(w => w.id !== ws.id);
  renderSidebar();
  updateEmptyState();
}

// ============================================
// Tab Management
// ============================================

function createTabElement(tabState: TabState): HTMLDivElement {
  const workspace = tabState.workspace;
  const tabId = tabState.tabId;
  const displayName = getTabDisplayName(tabState);

  const tab = document.createElement('div');
  tab.className = `tab${workspace.pinned ? ' pinned' : ''}`;
  tab.dataset.id = tabId;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('tabindex', '0');
  tab.setAttribute('aria-label', displayName);

  // #6: Drag-and-drop (disabled for pinned tabs)
  tab.draggable = !workspace.pinned;

  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  dot.style.color = workspace.color;
  dot.style.background = workspace.color;

  // Pin icon (visible only when pinned)
  const pinIcon = document.createElement('span');
  pinIcon.className = 'tab-pin-icon';
  pinIcon.textContent = '\uD83D\uDCCC'; // 📌
  pinIcon.style.display = workspace.pinned ? '' : 'none';

  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = displayName;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close tab';
  closeBtn.setAttribute('aria-label', `Close ${displayName}`);

  tab.appendChild(dot);
  tab.appendChild(pinIcon);
  tab.appendChild(name);
  tab.appendChild(closeBtn);

  // Click to activate
  tab.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('tab-close')) return;
    activateTab(tabId);
  });

  // Close button (confirm for pinned tabs)
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (workspace.pinned) {
      if (!confirm(`"${workspace.name}" is pinned. Close anyway?`)) return;
    }
    closeTab(tabId);
  });

  // Right-click context menu
  tab.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, tabId);
  });

  // #6: Drag events
  tab.addEventListener('dragstart', (e) => {
    tab.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', tabId);
  });

  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
    tabList.querySelectorAll('.tab.drag-over').forEach(t => t.classList.remove('drag-over'));
  });

  tab.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    tab.classList.add('drag-over');
  });

  tab.addEventListener('dragleave', () => {
    tab.classList.remove('drag-over');
  });

  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    tab.classList.remove('drag-over');
    const draggedId = e.dataTransfer!.getData('text/plain');
    if (draggedId === tabId) return;

    const draggedEl = tabList.querySelector(`.tab[data-id="${draggedId}"]`);
    if (draggedEl) {
      tab.parentElement!.insertBefore(draggedEl, tab);
      persistTabOrder();
    }
  });

  return tab;
}

function persistTabOrder(): void {
  // Extract workspace IDs from tab order, deduplicating (multiple tabs per workspace)
  const seen = new Set<string>();
  const wsIds: string[] = [];
  tabList.querySelectorAll('.tab[data-id]').forEach(el => {
    const tabId = (el as HTMLElement).dataset.id;
    if (tabId) {
      const wsId = getWorkspaceIdFromTabId(tabId);
      if (!seen.has(wsId)) {
        seen.add(wsId);
        wsIds.push(wsId);
      }
    }
  });
  api.workspace.reorder(wsIds);
}

async function addWorkspaceTab(workspace: Workspace, autoSpawn = true, startupDelayMs = 600): Promise<string> {
  const tabId = generateTabInstanceId(workspace.id);

  // Create wrapper container for this tab's panes
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = tabId;
  terminalContainer.appendChild(wrapper);

  const tabState: TabState = {
    tabId,
    workspace,
    paneRoot: null as any, // will be set below
    activePaneId: '',
    paneCounter: 0,
    hasUnread: false,
    unreadCount: 0,
    restartCount: 0,
    restartStabilityTimer: null,
    _resumeAttemptTime: null,
    shieldDetectionCount: 0,
    shieldHasBlock: false,
  };

  tabs.set(tabId, tabState);

  // Try to restore saved pane layout (only for first tab of workspace)
  let restoredLayout: SerializedPaneNode | null = null;
  const isFirstTab = getTabsForWorkspace(workspace.id).length <= 1;
  if (isFirstTab) {
    try {
      restoredLayout = await api.app.loadPaneLayout(workspace.id);
    } catch {}
  }

  let rootNode: PaneNode;
  if (restoredLayout && restoredLayout.type === 'split') {
    rootNode = deserializePaneTree(restoredLayout, tabId, tabState);
  } else {
    rootNode = createPaneLeaf(tabId, 0);
    tabState.paneCounter = 1;
  }

  tabState.paneRoot = rootNode;
  const allLeaves = findAllLeaves(rootNode);
  tabState.activePaneId = allLeaves[0]?.id || '';

  // Render pane tree
  renderPaneTree(rootNode, wrapper);

  // Open terminals and restore scrollback per-pane (only for first tab)
  for (const leaf of allLeaves) {
    leaf.terminal.open(leaf.container);

    if (isFirstTab) {
      // Load per-pane scrollback
      try {
        const scrollback = await api.app.loadScrollback(leaf.id);
        if (scrollback) {
          leaf.terminal.write(scrollback);
          leaf.terminal.writeln('\r\n\x1b[90m--- Previous session restored ---\x1b[0m\r\n');
        } else if (leaf.id.endsWith(':pane-0')) {
          // Backward compat: try legacy key (workspaceId without pane suffix)
          const legacyScrollback = await api.app.loadScrollback(workspace.id);
          if (legacyScrollback) {
            leaf.terminal.write(legacyScrollback);
            leaf.terminal.writeln('\r\n\x1b[90m--- Previous session restored ---\x1b[0m\r\n');
          }
        }
      } catch {}
    }
  }

  allLeaves[0]?.container.classList.add('active-pane');

  // Fit all terminals
  requestAnimationFrame(() => {
    allLeaves.forEach(leaf => {
      try { leaf.fitAddon.fit(); } catch {}
    });
  });

  // Spawn PTYs for all panes
  if (autoSpawn) {
    for (const leaf of allLeaves) {
      await spawnPaneTerminal(tabId, leaf, startupDelayMs);
    }
  }

  // Render tab bar (with groups)
  renderTabBar();
  updateEmptyState();
  return tabId;
}

async function spawnTerminal(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const pane = getActivePane(tab);
  if (!pane) return;

  await spawnPaneTerminal(tabId, pane);
  updateTabStatus(tabId);
}

function activateTab(tabId: string): void {
  // Deactivate current
  if (activeTabId) {
    const prev = tabs.get(activeTabId);
    if (prev) {
      const prevWrapper = terminalContainer.querySelector(`.terminal-wrapper[data-id="${activeTabId}"]`);
      prevWrapper?.classList.remove('active');
    }
    const prevTab = tabList.querySelector(`.tab[data-id="${activeTabId}"]`);
    prevTab?.classList.remove('active');
  }

  // Activate new
  activeTabId = tabId;
  const tab = tabs.get(tabId);
  if (tab) {
    const wrapper = terminalContainer.querySelector(`.terminal-wrapper[data-id="${tabId}"]`);
    wrapper?.classList.add('active');

    // #4: Clear unread badge
    tab.hasUnread = false;
    tab.unreadCount = 0;
    updateTabBadge(tabId);

    requestAnimationFrame(() => {
      findAllLeaves(tab.paneRoot).forEach(leaf => {
        try { leaf.fitAddon.fit(); } catch {}
      });
      const activePane = getActivePane(tab);
      if (activePane) activePane.terminal.focus();
    });
    updateStatusBar(tab);
  }

  const tabEl = tabList.querySelector(`.tab[data-id="${tabId}"]`);
  tabEl?.classList.add('active');

  api.app.setActiveTab(tabId);
  renderSidebar();
}

function closeTab(tabId: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;

  // #1: Save scrollback before closing
  saveScrollbackForTab(tab);

  // Kill all PTYs for this tab's panes and clean up notification timers
  findAllLeaves(tab.paneRoot).forEach(leaf => {
    api.pty.kill(leaf.id);
    leaf.terminal.dispose();
    const timer = paneIdleTimers.get(leaf.id);
    if (timer) {
      clearTimeout(timer);
      paneIdleTimers.delete(leaf.id);
    }
  });

  // Remove DOM
  const wrapper = terminalContainer.querySelector(`.terminal-wrapper[data-id="${tabId}"]`);
  wrapper?.remove();

  if (tab.restartStabilityTimer) clearTimeout(tab.restartStabilityTimer);
  tabs.delete(tabId);

  // If this was the active tab, switch to another
  if (activeTabId === tabId) {
    const remaining = Array.from(tabs.keys());
    if (remaining.length > 0) {
      activateTab(remaining[remaining.length - 1]);
    } else {
      activeTabId = null;
      updateStatusBar(null);
    }
  }

  renderTabBar();
  updateEmptyState();
  renderSidebar();
}

async function deleteWorkspaceWithConfirm(workspaceId: string): Promise<void> {
  const ws = allWorkspaces.find(w => w.id === workspaceId);
  const firstTab = getFirstTabForWorkspace(workspaceId);
  const name = firstTab?.workspace.name || ws?.name || workspaceId;

  const confirmed = confirm(`Delete workspace "${name}"? This removes it permanently.`);
  if (!confirmed) return;

  // Close ALL open tab instances for this workspace
  const wsTabs = getTabsForWorkspace(workspaceId);
  for (const tab of wsTabs) {
    closeTab(tab.tabId);
  }

  await api.workspace.delete(workspaceId);
  allWorkspaces = allWorkspaces.filter(w => w.id !== workspaceId);
  renderSidebar();
  updateEmptyState();
}

function updateTabStatus(tabId: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;

  // Determine overall tab status from panes
  const leaves = findAllLeaves(tab.paneRoot);
  const anyRunning = leaves.some(l => l.status === 'running');
  const anyStarting = leaves.some(l => l.status === 'starting');
  const allDead = leaves.every(l => l.status === 'dead');

  const overallStatus: TerminalStatus = anyRunning ? 'running' : anyStarting ? 'starting' : allDead ? 'dead' : 'idle';

  const dot = tabList.querySelector(`.tab[data-id="${tabId}"] .tab-dot`) as HTMLElement;
  if (dot) {
    dot.classList.toggle('alive', overallStatus === 'running');
  }

  if (activeTabId === tabId) {
    updateStatusBar(tab);
  }
}

function updateStatusBar(tab: TabState | null): void {
  if (!tab) {
    statusDot.className = '';
    statusText.textContent = 'Ready';
    statusCwd.textContent = '';
    statusShell.textContent = '';
    updateClaudeMetricsDisplay(null);
    return;
  }

  const activePane = getActivePane(tab);
  const status = activePane?.status || 'idle';

  statusDot.className = status === 'running' ? 'alive' : status === 'dead' ? 'dead' : status === 'starting' ? 'starting' : '';

  const statusLabels: Record<TerminalStatus, string> = {
    idle: 'Idle',
    running: 'Running',
    dead: 'Exited',
    starting: 'Starting...',
  };
  statusText.textContent = statusLabels[status];
  statusCwd.textContent = tab.workspace.cwd;
  statusShell.textContent = tab.workspace.shell || 'powershell.exe';

  // Update Claude metrics display for this tab
  const metrics = claudeMetrics.get(tab.workspace.id) || null;
  updateClaudeMetricsDisplay(metrics);
}

function updateEmptyState(): void {
  const hasOpenTabs = tabs.size > 0;
  const hasAnyWorkspaces = allWorkspaces.length > 0;

  emptyState.classList.toggle('hidden', hasOpenTabs);
  terminalContainer.style.display = hasOpenTabs ? '' : 'none';

  // Update empty state message based on context
  const emptyContent = emptyState.querySelector('.empty-content');
  if (emptyContent) {
    const h2 = emptyContent.querySelector('h2');
    const p = emptyContent.querySelector('p');
    if (h2 && p) {
      if (!hasAnyWorkspaces) {
        h2.textContent = 'No workspaces yet';
        p.textContent = 'Create a workspace to get started with Claude Code';
      } else {
        h2.textContent = 'No open workspaces';
        p.textContent = 'Click a workspace in the sidebar or create a new one';
      }
    }
  }
}

// #4: Unread Badge
function updateTabBadge(tabId: string): void {
  const tab = tabs.get(tabId);
  const tabEl = tabList.querySelector(`.tab[data-id="${tabId}"]`);
  if (!tab || !tabEl) return;

  let badge = tabEl.querySelector('.tab-badge') as HTMLElement;
  if (tab.hasUnread) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tab-badge';
      tabEl.appendChild(badge);
    }
    badge.style.display = '';
  } else {
    if (badge) badge.style.display = 'none';
  }
}

// Shield detection badge on tabs
function updateTabShieldBadge(tabId: string): void {
  const tab = tabs.get(tabId);
  const tabEl = tabList.querySelector(`.tab[data-id="${tabId}"]`);
  if (!tab || !tabEl) return;

  if (tab.shieldDetectionCount > 0) {
    if (tab.shieldHasBlock) {
      tabEl.classList.remove('shield-warn');
      tabEl.classList.add('shield-block');
    } else {
      tabEl.classList.remove('shield-block');
      tabEl.classList.add('shield-warn');
    }
  } else {
    tabEl.classList.remove('shield-warn', 'shield-block');
  }
}

// #3: Render tab bar with groups
function renderTabBar(): void {
  // Collect all open tab states
  const allTabStates = Array.from(tabs.values());

  // Clear tab list
  tabList.innerHTML = '';

  // Group tab states by workspace group
  const grouped = new Map<string, TabState[]>();
  const ungrouped: TabState[] = [];

  for (const ts of allTabStates) {
    const group = ts.workspace.group;
    if (group) {
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group)!.push(ts);
    } else {
      ungrouped.push(ts);
    }
  }

  // Sort pinned first within each group
  const sortPinnedFirst = (a: TabState, b: TabState) => {
    if (a.workspace.pinned && !b.workspace.pinned) return -1;
    if (!a.workspace.pinned && b.workspace.pinned) return 1;
    return 0;
  };

  // Render grouped tabs
  for (const [groupName, tabStates] of grouped) {
    tabStates.sort(sortPinnedFirst);
    const isCollapsed = groupStates.get(groupName) || false;

    const header = document.createElement('div');
    header.className = 'group-header';

    const chevron = document.createElement('span');
    chevron.className = `group-chevron${isCollapsed ? ' collapsed' : ''}`;
    chevron.textContent = '\u25BC';

    const label = document.createElement('span');
    label.textContent = groupName;

    header.appendChild(chevron);
    header.appendChild(label);
    header.addEventListener('click', () => {
      api.workspace.toggleGroup(groupName).then((g: WorkspaceGroup) => {
        groupStates.set(groupName, g.collapsed);
        renderTabBar();
      });
    });

    tabList.appendChild(header);

    const tabContainer = document.createElement('div');
    tabContainer.className = `group-tabs${isCollapsed ? ' collapsed' : ''}`;

    for (const ts of tabStates) {
      const tabEl = createTabElement(ts);
      if (ts.tabId === activeTabId) tabEl.classList.add('active');
      tabContainer.appendChild(tabEl);
    }

    tabList.appendChild(tabContainer);
  }

  // Render ungrouped tabs (pinned first)
  ungrouped.sort(sortPinnedFirst);
  for (const ts of ungrouped) {
    const tabEl = createTabElement(ts);
    if (ts.tabId === activeTabId) tabEl.classList.add('active');
    tabList.appendChild(tabEl);
  }

  // Re-add badges
  for (const [id, tab] of tabs) {
    if (tab.hasUnread) updateTabBadge(id);
    if (tab.shieldDetectionCount > 0) updateTabShieldBadge(id);
  }
}

// ============================================
// #1: Scrollback Persistence
// ============================================

function serializeTerminalBuffer(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.join('\r\n');
}

function saveScrollbackForTab(tab: TabState): void {
  const leaves = findAllLeaves(tab.paneRoot);
  for (const leaf of leaves) {
    const content = serializeTerminalBuffer(leaf.terminal);
    if (content.length > 0) {
      api.app.saveScrollback(leaf.id, content);
    }
  }
}

// ============================================
// Context Menu
// ============================================

let activeContextMenu: HTMLElement | null = null;

function showContextMenu(x: number, y: number, tabId: string): void {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const tabState = tabs.get(tabId);
  const isPinned = tabState?.workspace.pinned;
  const wsId = tabState ? tabState.workspace.id : getWorkspaceIdFromTabId(tabId);

  const items = [
    { label: 'New Tab for Workspace', action: () => openNewTabForWorkspace(tabId) },
    { label: 'Edit Workspace', action: () => openEditModal(tabId) },
    { label: isPinned ? 'Unpin Tab' : 'Pin Tab', action: () => togglePin(tabId) },
    { label: 'Restart Terminal', shortcut: 'Ctrl+Shift+R', action: () => restartTerminal(tabId) },
    // #8: Save as template
    { label: 'Save as Template', action: () => saveAsTemplate(tabId) },
    { label: 'Duplicate Tab', action: () => duplicateTab(tabId) },
    ...(shieldSupportsScanning ? [
      { label: 'Scan Repository', action: () => { showScanOverlay(tabId); triggerScan(wsId); } },
      { label: 'Quick Scan (changes only)', action: () => { showScanOverlay(tabId, true); triggerScan(wsId, { incremental: true }); } },
    ] : []),
    { separator: true },
    // #2: Split pane options
    { label: 'Split Down', shortcut: 'Ctrl+Shift+D', action: () => splitPane(tabId, 'vertical') },
    { label: 'Split Right', shortcut: 'Ctrl+Shift+E', action: () => splitPane(tabId, 'horizontal') },
    { label: 'Close Split Down', action: () => closeSplitDirection(tabId, 'vertical') },
    { label: 'Close Split Right', action: () => closeSplitDirection(tabId, 'horizontal') },
    { separator: true },
    { label: 'Close Tab', shortcut: 'Ctrl+W', action: () => closeTab(tabId) },
    { label: 'Delete Workspace', action: () => deleteWorkspaceWithConfirm(wsId), danger: true },
  ];

  for (const item of items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
    } else {
      const el = document.createElement('div');
      el.className = `context-menu-item${(item as any).danger ? ' danger' : ''}`;
      el.setAttribute('role', 'menuitem');

      const label = document.createElement('span');
      label.textContent = item.label;
      el.appendChild(label);

      if ((item as any).shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'context-menu-shortcut';
        shortcut.textContent = (item as any).shortcut;
        el.appendChild(shortcut);
      }

      el.addEventListener('click', () => {
        closeContextMenu();
        (item as any).action();
      });

      menu.appendChild(el);
    }
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Adjust position if menu overflows viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  });

  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu(): void {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

function showTerminalContextMenu(x: number, y: number, tabId: string, paneId: string): void {
  closeContextMenu();

  const tab = tabs.get(tabId);
  if (!tab) return;

  const pane = findPaneById(tab.paneRoot, paneId);
  if (!pane) return;

  const hasSelection = pane.terminal.getSelection().length > 0;
  const hasMultiplePanes = findAllLeaves(tab.paneRoot).length > 1;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  interface TermContextMenuItem {
    label?: string;
    shortcut?: string;
    action?: () => void;
    disabled?: boolean;
    separator?: boolean;
    danger?: boolean;
    hidden?: boolean;
  }

  const items: TermContextMenuItem[] = [
    { label: 'Copy', shortcut: 'Ctrl+Shift+C', disabled: !hasSelection, action: () => {
      const text = pane.terminal.getSelection();
      if (text) navigator.clipboard.writeText(text);
    }},
    { label: 'Paste', shortcut: 'Ctrl+Shift+V', action: async () => {
      const text = await navigator.clipboard.readText();
      if (text && pane.pid) api.pty.write(pane.id, text);
    }},
    { label: 'Select All', shortcut: 'Ctrl+Shift+A', action: () => {
      pane.terminal.selectAll();
      pane.terminal.focus();
    }},
    { separator: true },
    { label: 'Clear Terminal', action: () => {
      pane.terminal.clear();
    }},
    { separator: true },
    { label: 'Find', shortcut: 'Ctrl+F', action: () => openSearch() },
    { separator: true },
    { label: 'Split Down', shortcut: 'Ctrl+Shift+D', action: () => splitPane(tabId, 'vertical') },
    { label: 'Split Right', shortcut: 'Ctrl+Shift+E', action: () => splitPane(tabId, 'horizontal') },
    { label: 'Close Pane', shortcut: 'Ctrl+Shift+W', danger: true, hidden: !hasMultiplePanes, action: () => closePaneById(tabId, paneId) },
  ];

  for (const item of items) {
    if (item.hidden) continue;
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
    } else {
      const el = document.createElement('div');
      el.className = 'context-menu-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
      el.setAttribute('role', 'menuitem');

      const label = document.createElement('span');
      label.textContent = item.label!;
      el.appendChild(label);

      if (item.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'context-menu-shortcut';
        shortcut.textContent = item.shortcut;
        el.appendChild(shortcut);
      }

      if (!item.disabled) {
        el.addEventListener('click', () => {
          closeContextMenu();
          item.action!();
        });
      }

      menu.appendChild(el);
    }
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Adjust position if menu overflows viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  });

  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

// ============================================
// #8: Workspace Templates
// ============================================

async function loadTemplates(): Promise<void> {
  templates = await api.template.list();
  populateTemplateDropdown();
}

function populateTemplateDropdown(): void {
  wsTemplateSelect.innerHTML = '<option value="">None (blank)</option>';
  for (const t of templates) {
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = t.name;
    wsTemplateSelect.appendChild(opt);
  }
}

function saveAsTemplate(tabId: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const name = prompt('Template name:', `${tab.workspace.name} Template`);
  if (!name) return;

  const template: WorkspaceTemplate = {
    name,
    startupCommand: tab.workspace.startupCommand,
    autoStart: tab.workspace.autoStart,
    color: tab.workspace.color,
    env: tab.workspace.env,
    shell: tab.workspace.shell,
    autoRestart: tab.workspace.autoRestart,
    maxRestarts: tab.workspace.maxRestarts,
    group: tab.workspace.group,
  };

  api.template.create(template).then(() => {
    templates.push(template);
    populateTemplateDropdown();
  });
}

// ============================================
// Scaffold Functions
// ============================================

function toggleScaffoldMode(scaffold: boolean): void {
  scaffoldMode = scaffold;
  if (scaffold) {
    existingModeBtn.classList.remove('active');
    scaffoldModeBtn.classList.add('active');
    existingForm.style.display = 'none';
    scaffoldForm.style.display = '';
    modalSave.textContent = 'Create Project';
  } else {
    scaffoldModeBtn.classList.remove('active');
    existingModeBtn.classList.add('active');
    scaffoldForm.style.display = 'none';
    existingForm.style.display = '';
    modalSave.textContent = 'Save';
  }
}

async function loadScaffoldTemplates(): Promise<void> {
  try {
    scaffoldTemplates = await api.scaffold.list();
  } catch {
    scaffoldTemplates = [];
  }
  renderScaffoldTemplateGrid();
}

function renderScaffoldTemplateGrid(): void {
  scaffoldTemplateGrid.innerHTML = '';
  for (const info of scaffoldTemplates) {
    const card = document.createElement('div');
    card.className = 'scaffold-template-card';
    if (selectedScaffold && selectedScaffold.path === info.path) {
      card.classList.add('selected');
    }

    const icon = document.createElement('div');
    icon.className = 'scaffold-template-icon';
    icon.textContent = info.manifest.icon || '📄';

    const name = document.createElement('div');
    name.className = 'scaffold-template-name';
    name.textContent = info.manifest.name;

    const desc = document.createElement('div');
    desc.className = 'scaffold-template-desc';
    desc.textContent = info.manifest.description;

    card.appendChild(icon);
    card.appendChild(name);
    card.appendChild(desc);

    if (info.source === 'local') {
      const badge = document.createElement('div');
      badge.className = 'scaffold-template-source';
      badge.textContent = 'local';
      card.appendChild(badge);
    }

    card.addEventListener('click', () => {
      selectedScaffold = info;
      scaffoldTemplateGrid.querySelectorAll('.scaffold-template-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      renderScaffoldVariables(info);
      updateScaffoldAutoCommands(info);
    });

    scaffoldTemplateGrid.appendChild(card);
  }
}

function renderScaffoldVariables(info: ScaffoldTemplateInfo): void {
  scaffoldVariablesDiv.innerHTML = '';
  const vars = info.manifest.variables;
  if (!vars || vars.length === 0) return;

  for (const v of vars) {
    // Skip PROJECT_NAME variable — it's handled by the project name field
    if (v.key === 'PROJECT_NAME') continue;

    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.setAttribute('for', `scaffold-var-${v.key}`);
    label.textContent = v.prompt;

    group.appendChild(label);

    if (v.options && v.options.length > 0) {
      const select = document.createElement('select');
      select.id = `scaffold-var-${v.key}`;
      select.dataset.varKey = v.key;
      for (const opt of v.options) {
        const option = document.createElement('option');
        option.value = opt;
        option.textContent = opt;
        if (opt === v.default) option.selected = true;
        select.appendChild(option);
      }
      group.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = `scaffold-var-${v.key}`;
      input.dataset.varKey = v.key;
      input.placeholder = v.default || '';
      input.value = v.default || '';
      input.autocomplete = 'off';
      group.appendChild(input);
    }

    scaffoldVariablesDiv.appendChild(group);
  }
}

function updateScaffoldAutoCommands(info: ScaffoldTemplateInfo): void {
  const cmds = info.manifest.auto_commands || [];
  scaffoldGitInitInput.checked = cmds.includes('git init');
  scaffoldRunClaudeInput.checked = cmds.includes('claude');
}

function gatherScaffoldVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  const inputs = scaffoldVariablesDiv.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-var-key]');
  inputs.forEach(el => {
    vars[el.dataset.varKey!] = el.value;
  });
  return vars;
}

function initScaffoldColorPicker(): void {
  scaffoldColorsDiv.innerHTML = '';
  for (const color of WORKSPACE_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    swatch.dataset.color = color;
    if (color === scaffoldSelectedColor) swatch.classList.add('selected');

    swatch.addEventListener('click', () => {
      scaffoldColorsDiv.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
      scaffoldSelectedColor = color;
    });

    scaffoldColorsDiv.appendChild(swatch);
  }
}

// ============================================
// Workspace Modal
// ============================================

function initColorPicker(): void {
  wsColorsDiv.innerHTML = '';
  for (const color of WORKSPACE_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    swatch.dataset.color = color;
    if (color === selectedColor) swatch.classList.add('selected');

    swatch.addEventListener('click', () => {
      wsColorsDiv.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
      selectedColor = color;
    });

    wsColorsDiv.appendChild(swatch);
  }
}

function openNewModal(): void {
  editingWorkspaceId = null;
  modalTitle.textContent = 'New Workspace';
  wsNameInput.value = '';
  wsCwdInput.value = '';
  wsCommandInput.value = 'claude';
  wsAutostartInput.checked = true;
  wsAutorestartInput.checked = false;
  wsMaxRestartsInput.value = '3';
  maxRestartsGroup.style.display = 'none';
  wsGroupInput.value = '';
  wsResumeModeSelect.value = 'continue';
  resumeModeGroup.style.display = ''; // Visible since default command is 'claude'
  wsTemplateSelect.value = '';
  templateGroup.style.display = '';
  selectedColor = WORKSPACE_COLORS[Math.floor(Math.random() * WORKSPACE_COLORS.length)];
  initColorPicker();
  loadTemplates();

  // Scan config fields
  if (shieldSupportsScanning) {
    scanPolicyGroup.style.display = '';
    scanBackgroundGroup.style.display = '';
    scanBypassGroup.style.display = '';
    scanThresholdGroup.style.display = '';
    scanExcludeGroup.style.display = '';
    wsScanPolicySelect.value = 'off';
    wsScanBackgroundInput.checked = false;
    wsScanBypassInput.checked = true;
    wsScanThresholdSelect.value = 'high';
    wsScanExcludeTextarea.value = '';
  } else {
    scanPolicyGroup.style.display = 'none';
    scanBackgroundGroup.style.display = 'none';
    scanBypassGroup.style.display = 'none';
    scanThresholdGroup.style.display = 'none';
    scanExcludeGroup.style.display = 'none';
  }

  // Reset scaffold state
  scaffoldMode = false;
  selectedScaffold = null;
  scaffoldProjectNameInput.value = '';
  scaffoldParentDirInput.value = '';
  scaffoldVariablesDiv.innerHTML = '';
  scaffoldGitInitInput.checked = true;
  scaffoldRunClaudeInput.checked = true;
  scaffoldGroupInput.value = '';
  scaffoldSelectedColor = WORKSPACE_COLORS[Math.floor(Math.random() * WORKSPACE_COLORS.length)];
  initScaffoldColorPicker();
  toggleScaffoldMode(false);
  scaffoldModeToggle.style.display = '';
  loadScaffoldTemplates();

  // Collapse advanced section for new workspace
  wsAdvancedSection.classList.remove('expanded');
  wsAdvancedChevron.classList.remove('expanded');
  wsAdvancedToggle.setAttribute('aria-expanded', 'false');

  // Populate library checklist
  populateLibraryChecklist();

  modalOverlay.classList.remove('hidden');
  wsNameInput.focus();
}

function openEditModal(tabId: string): void {
  const tab = tabs.get(tabId);
  const wsId = tab ? tab.workspace.id : tabId;
  const ws = tab?.workspace || allWorkspaces.find(w => w.id === wsId);
  if (!ws) return;
  openEditModalForWorkspace(ws);
}

function closeModal(): void {
  modalOverlay.classList.add('hidden');
  editingWorkspaceId = null;
}

async function saveModal(): Promise<void> {
  // Scaffold mode: create new project flow
  if (scaffoldMode && !editingWorkspaceId) {
    await saveScaffoldModal();
    return;
  }

  const name = wsNameInput.value.trim();
  const cwd = wsCwdInput.value.trim();
  const startupCommand = wsCommandInput.value.trim();
  const autoStart = wsAutostartInput.checked;
  const autoRestart = wsAutorestartInput.checked;
  const maxRestarts = parseInt(wsMaxRestartsInput.value) || 3;
  const group = wsGroupInput.value.trim();
  const sessionResumeMode = wsResumeModeSelect.value as 'off' | 'resume' | 'continue';

  if (!name || !cwd) {
    if (!name) wsNameInput.style.borderColor = '#F85149';
    if (!cwd) wsCwdInput.style.borderColor = '#F85149';
    return;
  }

  // Build scan config if Shield scanning is supported, preserving existing interval
  const existingWs = editingWorkspaceId ? allWorkspaces.find(w => w.id === editingWorkspaceId) : null;
  const excludeLines = wsScanExcludeTextarea.value.split('\n').map(l => l.trim()).filter(Boolean);
  const scanConfig = shieldSupportsScanning ? {
    ...existingWs?.scanConfig,
    enforcementMode: wsScanPolicySelect.value as 'off' | 'manual' | 'enforce-before-spawn',
    backgroundScanEnabled: wsScanBackgroundInput.checked,
    allowScanBypass: wsScanBypassInput.checked,
    scanFailThreshold: wsScanThresholdSelect.value as 'critical' | 'high' | 'medium' | 'low',
    excludePatterns: excludeLines.length > 0 ? excludeLines : undefined,
  } : undefined;

  if (editingWorkspaceId) {
    const updated = await api.workspace.update(editingWorkspaceId, {
      name,
      cwd,
      startupCommand: startupCommand || undefined,
      autoStart,
      color: selectedColor,
      autoRestart,
      maxRestarts,
      group: group || undefined,
      sessionResumeMode,
      scanConfig,
    });

    if (updated) {
      // Update in ALL open tab instances for this workspace
      for (const tab of getTabsForWorkspace(editingWorkspaceId)) {
        tab.workspace = updated;
        if (activeTabId === tab.tabId) {
          updateStatusBar(tab);
        }
      }
      // Update in allWorkspaces
      const idx = allWorkspaces.findIndex(w => w.id === editingWorkspaceId);
      if (idx >= 0) {
        allWorkspaces[idx] = updated;
      }
    }
  } else {
    const workspace = await api.workspace.create({
      name,
      cwd,
      startupCommand: startupCommand || undefined,
      autoStart,
      color: selectedColor,
      autoRestart,
      maxRestarts,
      group: group || undefined,
      sessionResumeMode,
      scanConfig,
    });

    allWorkspaces.push(workspace);

    // Push selected library entries to the new workspace
    const selectedEntryIds = getCheckedLibraryEntries();
    if (selectedEntryIds.length > 0) {
      try {
        await api.library.push({ entryIds: selectedEntryIds, workspaceIds: [workspace.id] });
      } catch {}
    }

    const newTabId = await addWorkspaceTab(workspace);
    activateTab(newTabId);
  }

  closeModal();
  renderTabBar();
  renderSidebar();
}

async function saveScaffoldModal(): Promise<void> {
  const projectName = scaffoldProjectNameInput.value.trim();
  const parentDir = scaffoldParentDirInput.value.trim();

  if (!projectName) {
    scaffoldProjectNameInput.style.borderColor = '#F85149';
    return;
  }
  if (!parentDir) {
    scaffoldParentDirInput.style.borderColor = '#F85149';
    return;
  }
  if (!selectedScaffold) {
    return;
  }

  const variables = gatherScaffoldVariables();

  // Build auto-commands from checkboxes
  const autoCommands: string[] = [];
  if (scaffoldGitInitInput.checked) autoCommands.push('git init');
  // Gather any extra auto_commands from template (excluding git init and claude)
  const templateCmds = selectedScaffold.manifest.auto_commands || [];
  for (const cmd of templateCmds) {
    if (cmd === 'git init' || cmd === 'claude') continue;
    autoCommands.push(cmd);
  }
  if (scaffoldRunClaudeInput.checked) autoCommands.push('claude');

  // Scaffold the project
  const result = await api.scaffold.create({
    templatePath: selectedScaffold.path,
    projectName,
    parentDir,
    variables,
    autoCommands,
    workspaceColor: scaffoldSelectedColor,
    workspaceGroup: scaffoldGroupInput.value.trim() || undefined,
  });

  if (!result.success) {
    alert(`Scaffold failed: ${result.error}`);
    return;
  }

  // Create workspace pointing to the new project
  const startupCommand = autoCommands.length > 0 ? autoCommands.join(' && ') : undefined;
  const workspace = await api.workspace.create({
    name: projectName,
    cwd: result.projectDir,
    startupCommand,
    autoStart: true,
    color: scaffoldSelectedColor,
    group: scaffoldGroupInput.value.trim() || undefined,
  });

  allWorkspaces.push(workspace);
  const scaffoldTabId = await addWorkspaceTab(workspace);
  activateTab(scaffoldTabId);

  closeModal();
  renderTabBar();
  renderSidebar();
}

async function restartTerminal(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const pane = getActivePane(tab);
  if (!pane) return;

  // #9: Reset restart count on manual restart
  tab.restartCount = 0;
  tab._resumeAttemptTime = null;
  if (tab.restartStabilityTimer) {
    clearTimeout(tab.restartStabilityTimer);
    tab.restartStabilityTimer = null;
  }

  api.pty.kill(pane.id);
  pane.terminal.clear();
  pane.terminal.writeln('\x1b[33mRestarting terminal...\x1b[0m\r\n');
  await spawnPaneTerminal(tabId, pane);
  updateTabStatus(tabId);
}

// ============================================
// #7: Terminal Search
// ============================================

let searchVisible = false;

function toggleSearch(): void {
  if (searchVisible) {
    closeSearch();
  } else {
    openSearch();
  }
}

function openSearch(): void {
  searchVisible = true;
  searchBar.classList.remove('hidden');
  searchInput.value = '';
  searchMatchCount.textContent = '';
  searchInput.focus();
}

function closeSearch(): void {
  searchVisible = false;
  searchBar.classList.add('hidden');
  searchInput.value = '';
  searchMatchCount.textContent = '';

  // Refocus terminal
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab) {
      const pane = getActivePane(tab);
      if (pane) pane.terminal.focus();
    }
  }
}

function doSearch(direction: 'next' | 'prev'): void {
  if (!activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const pane = getActivePane(tab);
  if (!pane) return;

  const query = searchInput.value;
  if (!query) {
    searchMatchCount.textContent = '';
    return;
  }

  if (direction === 'next') {
    pane.searchAddon.findNext(query);
  } else {
    pane.searchAddon.findPrevious(query);
  }
}

// ============================================
// #5: Quick Switcher
// ============================================

function openQuickSwitcher(): void {
  qsOverlay.classList.remove('hidden');
  qsInput.value = '';
  qsSelectedIndex = 0;
  renderQuickSwitcherResults('');
  qsInput.focus();
}

function closeQuickSwitcher(): void {
  qsOverlay.classList.add('hidden');
  // Refocus terminal
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab) {
      const pane = getActivePane(tab);
      if (pane) pane.terminal.focus();
    }
  }
}

function fuzzyMatch(query: string, text: string): { match: boolean; score: number } {
  if (!query) return { match: true, score: 0 };
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  // Substring match first
  if (lowerText.includes(lowerQuery)) {
    return { match: true, score: 100 - lowerText.indexOf(lowerQuery) };
  }

  // Character-by-character fuzzy
  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < lowerText.length && qi < lowerQuery.length; ti++) {
    if (lowerText[ti] === lowerQuery[qi]) {
      score += 10;
      qi++;
    }
  }

  return { match: qi === lowerQuery.length, score };
}

function renderQuickSwitcherResults(query: string): void {
  // Show ALL workspaces (open and closed), not just open tabs
  const results = allWorkspaces
    .map(ws => {
      const nameMatch = fuzzyMatch(query, ws.name);
      const cwdMatch = fuzzyMatch(query, ws.cwd);
      const bestScore = Math.max(nameMatch.score, cwdMatch.score);
      const isMatch = nameMatch.match || cwdMatch.match;
      const isOpen = hasOpenTabsForWorkspace(ws.id);
      return { workspace: ws, score: bestScore, match: isMatch, isOpen };
    })
    .filter(r => r.match)
    .sort((a, b) => {
      // Open workspaces first, then by score
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      return b.score - a.score;
    });

  qsResults.innerHTML = '';

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'qs-empty';
    empty.textContent = 'No matching workspaces';
    qsResults.appendChild(empty);
    return;
  }

  qsSelectedIndex = Math.min(qsSelectedIndex, results.length - 1);

  results.forEach((result, index) => {
    const item = document.createElement('div');
    item.className = `qs-item${index === qsSelectedIndex ? ' selected' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === qsSelectedIndex));

    const dot = document.createElement('span');
    dot.className = 'qs-item-dot';
    dot.style.background = result.workspace.color;
    if (!result.isOpen) {
      dot.style.opacity = '0.4';
    }

    const name = document.createElement('span');
    name.className = 'qs-item-name';
    name.textContent = result.workspace.name;
    if (!result.isOpen) {
      name.style.color = 'var(--text-muted)';
    }

    const cwd = document.createElement('span');
    cwd.className = 'qs-item-cwd';
    cwd.textContent = result.workspace.cwd;

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(cwd);

    item.addEventListener('click', () => {
      if (result.isOpen) {
        const firstTab = getFirstTabForWorkspace(result.workspace.id);
        if (firstTab) activateTab(firstTab.tabId);
      } else {
        addWorkspaceTab(result.workspace).then((newTabId) => {
          activateTab(newTabId);
          renderSidebar();
        });
      }
      closeQuickSwitcher();
    });

    item.addEventListener('mouseenter', () => {
      qsResults.querySelectorAll('.qs-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      qsSelectedIndex = index;
    });

    qsResults.appendChild(item);
  });
}

function quickSwitcherSelectCurrent(): void {
  const items = qsResults.querySelectorAll('.qs-item');
  if (qsSelectedIndex >= 0 && qsSelectedIndex < items.length) {
    (items[qsSelectedIndex] as HTMLElement).click();
  }
}

// ============================================
// Tab Pinning
// ============================================

async function togglePin(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const newPinned = !tab.workspace.pinned;
  await api.workspace.update(tab.workspace.id, { pinned: newPinned });
  tab.workspace.pinned = newPinned;
  // Update all tabs for this workspace
  for (const t of getTabsForWorkspace(tab.workspace.id)) {
    t.workspace.pinned = newPinned;
  }
  renderTabBar();
}

// ============================================
// Duplicate Tab
// ============================================

async function duplicateTab(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const ws = tab.workspace;
  const newWs = await api.workspace.create({
    name: ws.name + ' (copy)',
    cwd: ws.cwd,
    startupCommand: ws.startupCommand,
    autoStart: ws.autoStart,
    color: ws.color,
    env: ws.env,
    shell: ws.shell,
    autoRestart: ws.autoRestart,
    maxRestarts: ws.maxRestarts,
    group: ws.group,
  });
  allWorkspaces.push(newWs);
  const newTabId = await addWorkspaceTab(newWs);
  activateTab(newTabId);
}

// Open a new tab instance for the same workspace
async function openNewTabForWorkspace(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const newTabId = await addWorkspaceTab(tab.workspace);
  activateTab(newTabId);
}

// ============================================
// Claude Code Metrics Display
// ============================================

function updateClaudeMetricsDisplay(entry: ClaudeMetricsEntry | null): void {
  if (!entry || !entry.metrics) {
    statusClaude.classList.add('hidden');
    return;
  }

  const m = entry.metrics;
  statusClaude.classList.remove('hidden');

  // Model name (shorten for display)
  const modelShort = m.model
    ? m.model.replace('claude-', '').replace(/-\d{8}$/, '')
    : '';
  statusModel.textContent = modelShort;

  // Context usage bar
  const pct = m.context_used_percent || 0;
  contextBarFill.style.width = `${Math.min(pct, 100)}%`;
  contextBarFill.className = 'context-bar-fill ' +
    (pct < 50 ? 'low' : pct < 80 ? 'medium' : 'high');
  statusContextPct.textContent = `${Math.round(pct)}%`;

  // Cost
  const cost = m.cost_usd || 0;
  statusCost.textContent = `$${cost.toFixed(2)}`;

  // Lines changed
  const added = m.lines_added || 0;
  const removed = m.lines_removed || 0;
  statusLines.textContent = `+${added} -${removed}`;
}

// ============================================
// Shield Status & Toasts
// ============================================

function updateShieldStatus(status: { enabled: boolean; detectionCount: number; licenseValid: boolean }): void {
  shieldActive = status.enabled;
  shieldDetectionCount = status.detectionCount;

  if (status.enabled) {
    statusShield.classList.remove('hidden');
    statusShield.classList.toggle('active', status.detectionCount === 0);
    statusShield.classList.toggle('warn', status.detectionCount > 0);
    shieldCountEl.textContent = String(status.detectionCount);

    // Check if Shield supports repo scanning (only enabled when provider is configured)
    api.shield.getScanProviderStatus().then((providerStatus) => {
      shieldSupportsScanning = providerStatus.configured;
    }).catch(() => {
      shieldSupportsScanning = false;
    });
  } else {
    statusShield.classList.add('hidden');
    shieldSupportsScanning = false;
  }

  updateSettingsShieldNav();
}

function showToast(header: string, body: string, color: string = 'var(--blue)', duration: number = 4000): void {
  const toast = document.createElement('div');
  toast.className = 'shield-toast';
  toast.style.borderColor = color;
  toast.innerHTML = `
    <div class="shield-toast-header" style="color: ${color}">${header}</div>
    <div class="shield-toast-body">${escapeHtml(body)}</div>
  `;
  shieldToastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.25s ease-in forwards';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

function showShieldToast(detection: { category: string; pattern: string; action: string; context: string }): void {
  const toast = document.createElement('div');
  const actionClass = detection.action === 'block' ? ' block' : detection.action === 'monitor' ? ' monitor' : '';
  toast.className = 'shield-toast' + actionClass;

  const actionLabel = detection.action === 'block' ? 'BLOCKED' : detection.action === 'warn' ? 'WARNING' : detection.action === 'monitor' ? 'MONITORED' : 'DETECTED';
  const icon = detection.action === 'block' ? '&#x1F6D1;' : detection.action === 'monitor' ? '&#x1F50D;' : '&#x1F6E1;';

  toast.innerHTML = `
    <div class="shield-toast-header">${icon} Shield: ${actionLabel}</div>
    <div class="shield-toast-body">${escapeHtml(detection.context)}</div>
    <span class="shield-toast-category">${escapeHtml(detection.category)} / ${escapeHtml(detection.pattern)}</span>
  `;

  shieldToastContainer.appendChild(toast);

  // Auto-dismiss: 8s for block, 3s for monitor, 5s default
  const duration = detection.action === 'block' ? 8000 : detection.action === 'monitor' ? 3000 : 5000;
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.25s ease-in forwards';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ============================================
// Shield Warn Prompt Modal
// ============================================

const shieldWarnOverlay = document.getElementById('shield-warn-overlay')!;
const shieldWarnTitle = document.getElementById('shield-warn-title')!;
const shieldWarnMessage = document.getElementById('shield-warn-message')!;
const shieldWarnDetails = document.getElementById('shield-warn-details')!;
const shieldWarnCancel = document.getElementById('shield-warn-cancel')!;
const shieldWarnContinue = document.getElementById('shield-warn-continue')!;

// Queue of pending warn prompts (handles concurrent warns for different workspaces)
interface WarnQueueEntry {
  workspaceId: string;
  detection: { category: string; pattern: string; action: string; context: string; userPrompt?: string };
}
const warnQueue: WarnQueueEntry[] = [];
let pendingWarnWorkspaceId: string | null = null;

function showWarnPrompt(workspaceId: string, detection: { category: string; pattern: string; action: string; context: string; userPrompt?: string }): void {
  // If a warn modal is already showing, queue this one
  if (pendingWarnWorkspaceId !== null) {
    warnQueue.push({ workspaceId, detection });
    return;
  }

  pendingWarnWorkspaceId = workspaceId;

  shieldWarnTitle.textContent = 'Shield Warning';
  shieldWarnMessage.textContent = detection.userPrompt || `Shield detected sensitive data (${detection.category}) in your input.`;
  shieldWarnDetails.innerHTML = `
    <div><strong>Category:</strong> ${escapeHtml(detection.category)}</div>
    <div><strong>Pattern:</strong> ${escapeHtml(detection.pattern)}</div>
    <div><strong>Details:</strong> ${escapeHtml(detection.context)}</div>
  `;

  shieldWarnOverlay.classList.remove('hidden');
  shieldWarnCancel.focus();
}

function respondToWarn(allow: boolean): void {
  if (pendingWarnWorkspaceId) {
    api.shield.respondToWarn(pendingWarnWorkspaceId, allow);
    pendingWarnWorkspaceId = null;
  }
  shieldWarnOverlay.classList.add('hidden');

  // Show next queued warn prompt if any
  if (warnQueue.length > 0) {
    const next = warnQueue.shift()!;
    showWarnPrompt(next.workspaceId, next.detection);
  }
}

shieldWarnCancel.addEventListener('click', () => respondToWarn(false));
shieldWarnContinue.addEventListener('click', () => respondToWarn(true));

// Close on Escape key
shieldWarnOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    respondToWarn(false);
  }
});

// ============================================
// Analytics Dashboard
// ============================================

async function openDashboard(): Promise<void> {
  dashboardOverlay.classList.remove('hidden');

  try {
    const analytics = await api.claude.getAnalytics();
    populateDashboard(analytics);
  } catch {
    dashTotalCost.textContent = '$0.00';
    dashTotalSessions.textContent = '0';
    dashTotalAdded.textContent = '0';
    dashTotalRemoved.textContent = '0';
    dashWorkspaceTbody.innerHTML = '';
    dashChart.innerHTML = '<div class="dash-empty">No metrics data</div>';
  }

  // Phase 4: If API is enabled, load org usage
  try {
    const apiConfig = await api.anthropic.getConfig();
    if (apiConfig.enabled && apiConfig.apiKey) {
      dashOrgSection.style.display = '';
      const usage = await api.anthropic.getUsage(apiConfig.apiKey);
      if ('error' in usage) {
        dashOrgContent.textContent = `Error: ${usage.error}`;
      } else {
        dashOrgContent.innerHTML = `
          <div class="dash-cards" style="grid-template-columns: repeat(3, 1fr);">
            <div class="dash-card">
              <div class="dash-card-label">Org Cost</div>
              <div class="dash-card-value">$${usage.total_cost_usd.toFixed(2)}</div>
            </div>
            <div class="dash-card">
              <div class="dash-card-label">Input Tokens</div>
              <div class="dash-card-value">${formatTokens(usage.total_input_tokens)}</div>
            </div>
            <div class="dash-card">
              <div class="dash-card-label">Output Tokens</div>
              <div class="dash-card-value">${formatTokens(usage.total_output_tokens)}</div>
            </div>
          </div>
          ${usage.models.length > 0 ? `
            <table id="dash-workspace-table" style="margin-top: 12px;">
              <thead><tr><th>Model</th><th>Cost</th><th>Input</th><th>Output</th></tr></thead>
              <tbody>${usage.models.map(m => `
                <tr><td>${m.model}</td><td>$${m.cost_usd.toFixed(2)}</td><td>${formatTokens(m.input_tokens)}</td><td>${formatTokens(m.output_tokens)}</td></tr>
              `).join('')}</tbody>
            </table>
          ` : ''}
        `;
      }
    } else {
      dashOrgSection.style.display = 'none';
    }
  } catch {
    dashOrgSection.style.display = 'none';
  }

  // Shield audit tab
  loadShieldAuditDashboard();
}

function closeDashboard(): void {
  dashboardOverlay.classList.add('hidden');
}

// ============================================
// Shield Audit Dashboard Tab
// ============================================

const dashShieldSection = document.getElementById('dash-shield-section')!;
const dashShieldTotal = document.getElementById('dash-shield-total')!;
const dashShieldBlocked = document.getElementById('dash-shield-blocked')!;
const dashShieldWarned = document.getElementById('dash-shield-warned')!;
const dashShieldIntegrity = document.getElementById('dash-shield-integrity')!;
const dashShieldTimeline = document.getElementById('dash-shield-timeline')!;
const dashShieldExportBtn = document.getElementById('dash-shield-export')!;
const dashShieldVerifyBtn = document.getElementById('dash-shield-verify')!;

// Shield filter controls
const dashShieldFilterAction = document.getElementById('dash-shield-filter-action') as HTMLSelectElement;
const dashShieldFilterCategory = document.getElementById('dash-shield-filter-category') as HTMLSelectElement;
const dashShieldFilterSearch = document.getElementById('dash-shield-filter-search') as HTMLInputElement;

// Cached detections for filtering
let cachedShieldDetections: any[] = [];

function renderShieldTimeline(detections: any[]): void {
  // Update summary cards with filtered counts
  const blocked = detections.filter((e: any) => e.action === 'blocked').length;
  const warned = detections.filter((e: any) => e.action === 'warned').length;
  dashShieldTotal.textContent = String(detections.length);
  dashShieldBlocked.textContent = String(blocked);
  dashShieldWarned.textContent = String(warned);

  if (detections.length === 0) {
    dashShieldTimeline.innerHTML = '<div style="color: var(--text-muted); padding: 12px; text-align: center;">No detections found</div>';
  } else {
    const recent = detections.slice().reverse();
    dashShieldTimeline.innerHTML = recent.map((e: any) => {
      const time = new Date(e.timestamp).toLocaleTimeString();
      const actionClass = e.action === 'blocked' ? 'blocked' : e.action === 'warned' ? 'warned' : 'monitored';
      return `<div class="shield-audit-entry">
        <span class="audit-time">${time}</span>
        <span class="audit-action ${actionClass}">${e.action || 'detected'}</span>
        <span>${escapeHtml(e.category || '')} / ${escapeHtml(e.pattern || '')}</span>
        ${e.workspace ? `<span style="color: var(--text-muted);"> in ${escapeHtml(e.workspace)}</span>` : ''}
        ${e.userResponse ? `<span style="color: var(--accent);"> [${e.userResponse}]</span>` : ''}
      </div>`;
    }).join('');
  }
}

function filterShieldDetections(): void {
  const actionFilter = dashShieldFilterAction.value;
  const categoryFilter = dashShieldFilterCategory.value.toLowerCase();
  const searchText = dashShieldFilterSearch.value.toLowerCase().trim();

  let filtered = cachedShieldDetections;

  if (actionFilter) {
    filtered = filtered.filter((e: any) => e.action === actionFilter);
  }

  if (categoryFilter) {
    filtered = filtered.filter((e: any) => {
      const cat = (e.category || '').toLowerCase().replace(/\s+/g, '_');
      return cat === categoryFilter || (e.category || '').toLowerCase() === categoryFilter;
    });
  }

  if (searchText) {
    filtered = filtered.filter((e: any) => {
      const haystack = [e.context || '', e.pattern || '', e.workspace || '', e.category || ''].join(' ').toLowerCase();
      return haystack.includes(searchText);
    });
  }

  renderShieldTimeline(filtered);
}

// Attach filter listeners
dashShieldFilterAction.addEventListener('change', filterShieldDetections);
dashShieldFilterCategory.addEventListener('change', filterShieldDetections);
dashShieldFilterSearch.addEventListener('input', filterShieldDetections);

async function loadShieldAuditDashboard(): Promise<void> {
  if (!shieldActive) {
    dashShieldSection.style.display = 'none';
    return;
  }
  dashShieldSection.style.display = '';

  // Reset filters on load
  dashShieldFilterAction.value = '';
  dashShieldFilterCategory.value = '';
  dashShieldFilterSearch.value = '';

  try {
    const result = await api.shield.queryAuditLogs();
    const entries = result.entries || [];

    // Cache all detections (no 50-item limit)
    cachedShieldDetections = entries.filter((e: any) => e.event === 'dlp_detection');
    renderShieldTimeline(cachedShieldDetections);
  } catch {
    cachedShieldDetections = [];
    dashShieldTimeline.innerHTML = '<div style="color: var(--text-muted); padding: 12px;">Failed to load audit logs</div>';
  }
}

dashShieldExportBtn.addEventListener('click', async () => {
  const result = await api.shield.exportAuditLogs();
  if (result?.error) {
    showToast('Export Failed', result.error, 'var(--red)', 5000);
  } else if (result?.success) {
    showToast('Exported', `${result.count} entries exported`, 'var(--green)', 3000);
  }
});

dashShieldVerifyBtn.addEventListener('click', async () => {
  const result = await api.shield.verifyAuditIntegrity();
  if (result.valid) {
    dashShieldIntegrity.innerHTML = `<span class="shield-integrity-badge valid">&#x2714; Valid (${result.entries} entries)</span>`;
  } else {
    dashShieldIntegrity.innerHTML = `<span class="shield-integrity-badge invalid">&#x2718; Broken at entry ${result.brokenAt ?? '?'}</span>`;
  }
});

function populateDashboard(analytics: ClaudeAnalytics): void {
  const { totals, perWorkspace, history } = analytics;

  // Summary cards
  dashTotalCost.textContent = `$${totals.cost_usd.toFixed(2)}`;
  dashTotalSessions.textContent = String(totals.sessions);
  dashTotalAdded.textContent = `+${totals.lines_added}`;
  dashTotalRemoved.textContent = `-${totals.lines_removed}`;

  // Per-workspace table
  if (perWorkspace.length === 0) {
    dashWorkspaceTbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No data</td></tr>';
  } else {
    dashWorkspaceTbody.innerHTML = perWorkspace.map(ws => {
      const lastActive = ws.lastActive
        ? new Date(ws.lastActive).toLocaleDateString()
        : '-';
      const modelShort = ws.model
        ? ws.model.replace('claude-', '').replace(/-\d{8}$/, '')
        : '-';
      return `<tr>
        <td>${escapeHtml(ws.name)}</td>
        <td>$${ws.cost_usd.toFixed(2)}</td>
        <td>${ws.sessions}</td>
        <td>${modelShort}</td>
        <td>${lastActive}</td>
      </tr>`;
    }).join('');
  }

  // Cost chart
  renderCostChart(history);
}

function renderCostChart(history: ClaudeAnalytics['history']): void {
  if (history.length === 0) {
    dashChart.innerHTML = '<div class="dash-empty">No cost history</div>';
    return;
  }

  const maxCost = Math.max(...history.map(h => h.cost_usd), 0.01);
  dashChart.innerHTML = '';

  for (const entry of history) {
    const bar = document.createElement('div');
    bar.className = 'dash-chart-bar';
    const heightPct = Math.max((entry.cost_usd / maxCost) * 100, 2);
    bar.style.height = `${heightPct}%`;
    bar.title = `${entry.date}: $${entry.cost_usd.toFixed(2)}`;
    dashChart.appendChild(bar);
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

dashCloseBtn.addEventListener('click', closeDashboard);
dashClearBtn.addEventListener('click', async () => {
  if (confirm('Clear all Claude metrics data? This cannot be undone.')) {
    await api.claude.clearAnalytics();
    claudeMetrics.clear();
    const tab = activeTabId ? tabs.get(activeTabId) : null;
    if (tab) updateClaudeMetricsDisplay(null);
    openDashboard(); // Refresh with empty data
  }
});
dashboardOverlay.addEventListener('click', (e) => {
  if (e.target === dashboardOverlay) closeDashboard();
});
dashboardOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDashboard();
});

// ============================================
// Skills & Agents Library Panel
// ============================================

const libraryOverlay = document.getElementById('library-overlay')!;
const libSkillsList = document.getElementById('lib-skills-list')!;
const libAgentsList = document.getElementById('lib-agents-list')!;
const libDetailEmpty = document.getElementById('lib-detail-empty')!;
const libDetailContent = document.getElementById('lib-detail-content')!;
const libDetailHeader = document.getElementById('lib-detail-header')!;
const libDetailDesc = document.getElementById('lib-detail-desc')!;
const libWorkspaceGrid = document.getElementById('lib-workspace-grid')!;
const libFilterInput = document.getElementById('lib-filter') as HTMLInputElement;
const libImportBtn = document.getElementById('lib-import-btn')!;
const libRefreshBtn = document.getElementById('lib-refresh-btn')!;
const libCloseBtn = document.getElementById('lib-close-btn')!;
const libPushAllBtn = document.getElementById('lib-push-all-btn')!;
const libRemoveBtn = document.getElementById('lib-remove-btn')!;

async function openLibraryPanel(): Promise<void> {
  libraryOverlay.classList.remove('hidden');
  selectedLibraryEntry = null;
  libDetailEmpty.style.display = '';
  libDetailContent.classList.add('hidden');
  libFilterInput.value = '';
  await refreshLibraryList();
  libFilterInput.focus();
}

function closeLibraryPanel(): void {
  libraryOverlay.classList.add('hidden');
  selectedLibraryEntry = null;
}

async function refreshLibraryList(): Promise<void> {
  try {
    libraryEntries = await api.library.list();
  } catch {
    libraryEntries = [];
  }
  renderLibraryList();
}

function renderLibraryList(): void {
  const filter = libFilterInput.value.toLowerCase().trim();
  const skills = libraryEntries.filter(e => e.type === 'skill' && (!filter || e.name.toLowerCase().includes(filter) || e.id.toLowerCase().includes(filter)));
  const agents = libraryEntries.filter(e => e.type === 'agent' && (!filter || e.name.toLowerCase().includes(filter) || e.id.toLowerCase().includes(filter)));

  libSkillsList.innerHTML = skills.length === 0
    ? '<div style="padding:8px 12px;color:var(--text-muted);font-size:12px;">No skills in library</div>'
    : skills.map(e => renderLibraryItem(e)).join('');

  libAgentsList.innerHTML = agents.length === 0
    ? '<div style="padding:8px 12px;color:var(--text-muted);font-size:12px;">No agents in library</div>'
    : agents.map(e => renderLibraryItem(e)).join('');

  // Wire click handlers
  libSkillsList.querySelectorAll('.library-item').forEach(el => {
    el.addEventListener('click', () => selectLibraryEntry(el.getAttribute('data-id')!));
  });
  libAgentsList.querySelectorAll('.library-item').forEach(el => {
    el.addEventListener('click', () => selectLibraryEntry(el.getAttribute('data-id')!));
  });
}

function renderLibraryItem(entry: LibraryEntry): string {
  const isActive = selectedLibraryEntry?.id === entry.id ? ' active' : '';
  return `<div class="library-item${isActive}" data-id="${entry.id}">
    <span class="library-item-type ${entry.type}"></span>
    <span class="library-item-name">${escapeHtml(entry.name || entry.id)}</span>
  </div>`;
}

async function selectLibraryEntry(entryId: string): Promise<void> {
  const entry = libraryEntries.find(e => e.id === entryId);
  if (!entry) return;

  selectedLibraryEntry = entry;
  libDetailEmpty.style.display = 'none';
  libDetailContent.classList.remove('hidden');

  // Update header
  const typeBadge = `<span class="library-type-badge ${entry.type}">${entry.type}</span>`;
  libDetailHeader.innerHTML = `${escapeHtml(entry.name || entry.id)} ${typeBadge}`;
  libDetailDesc.textContent = entry.description || 'No description available.';

  // Re-highlight active item in sidebar
  libraryOverlay.querySelectorAll('.library-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-id') === entryId);
  });

  // Build workspace grid
  await renderWorkspaceGrid(entry);
}

async function renderWorkspaceGrid(entry: LibraryEntry): Promise<void> {
  if (allWorkspaces.length === 0) {
    libWorkspaceGrid.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No workspaces configured</div>';
    return;
  }

  const rows: string[] = [];
  for (const ws of allWorkspaces) {
    let views: LibraryWorkspaceView[] = [];
    try {
      views = await api.library.workspaceView(ws.id);
    } catch {}

    const view = views.find(v => v.entry.id === entry.id);
    const status: LibrarySyncStatus = view?.status || 'not-installed';
    const statusLabel = status === 'installed' ? 'Installed' : status === 'update-available' ? 'Update Available' : 'Not Installed';
    const pushLabel = status === 'update-available' ? 'Update' : status === 'not-installed' ? 'Push' : 'Reinstall';

    rows.push(`<div class="library-ws-row">
      <span class="library-ws-row-name">${escapeHtml(ws.name)}</span>
      <div class="library-ws-row-actions">
        <span class="library-status-badge ${status}">${statusLabel}</span>
        <button class="library-ws-push-btn" data-ws-id="${ws.id}">${pushLabel}</button>
      </div>
    </div>`);
  }

  libWorkspaceGrid.innerHTML = rows.join('');

  // Wire push buttons
  libWorkspaceGrid.querySelectorAll('.library-ws-push-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!selectedLibraryEntry) return;
      const wsId = btn.getAttribute('data-ws-id')!;
      btn.textContent = 'Pushing...';
      (btn as HTMLButtonElement).disabled = true;
      try {
        await api.library.push({ entryIds: [selectedLibraryEntry.id], workspaceIds: [wsId] });
      } catch {}
      // Refresh grid
      await renderWorkspaceGrid(selectedLibraryEntry);
    });
  });
}

// Library event listeners
libImportBtn.addEventListener('click', async () => {
  const result = await api.library.importFolder();
  if (result && result.success) {
    await refreshLibraryList();
    if (result.entry) {
      selectLibraryEntry(result.entry.id);
    }
  }
});

libRefreshBtn.addEventListener('click', async () => {
  libRefreshBtn.textContent = 'Refreshing...';
  try {
    libraryEntries = await api.library.refresh();
    renderLibraryList();
    // Re-select if current entry still exists
    if (selectedLibraryEntry) {
      const still = libraryEntries.find(e => e.id === selectedLibraryEntry!.id);
      if (still) {
        selectLibraryEntry(still.id);
      } else {
        selectedLibraryEntry = null;
        libDetailEmpty.style.display = '';
        libDetailContent.classList.add('hidden');
      }
    }
  } catch {}
  libRefreshBtn.textContent = 'Refresh';
});

libCloseBtn.addEventListener('click', closeLibraryPanel);

libPushAllBtn.addEventListener('click', async () => {
  if (!selectedLibraryEntry) return;
  const wsIds = allWorkspaces.map(ws => ws.id);
  if (wsIds.length === 0) return;
  libPushAllBtn.textContent = 'Pushing...';
  (libPushAllBtn as HTMLButtonElement).disabled = true;
  try {
    await api.library.push({ entryIds: [selectedLibraryEntry.id], workspaceIds: wsIds });
  } catch {}
  libPushAllBtn.textContent = 'Push to All Workspaces';
  (libPushAllBtn as HTMLButtonElement).disabled = false;
  if (selectedLibraryEntry) {
    await renderWorkspaceGrid(selectedLibraryEntry);
  }
});

libRemoveBtn.addEventListener('click', async () => {
  if (!selectedLibraryEntry) return;
  if (!confirm(`Remove "${selectedLibraryEntry.name || selectedLibraryEntry.id}" from the library? Workspace copies will not be affected.`)) return;
  try {
    await api.library.remove(selectedLibraryEntry.id);
  } catch {}
  selectedLibraryEntry = null;
  libDetailEmpty.style.display = '';
  libDetailContent.classList.add('hidden');
  await refreshLibraryList();
});

libFilterInput.addEventListener('input', () => {
  renderLibraryList();
});

libraryOverlay.addEventListener('click', (e) => {
  if (e.target === libraryOverlay) closeLibraryPanel();
});

libraryOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLibraryPanel();
});

// ============================================
// Library: Discovery
// ============================================

const libDiscoverBtn = document.getElementById('lib-discover-btn')!;
const libDiscoverResults = document.getElementById('lib-discover-results')!;
const libDiscoverList = document.getElementById('lib-discover-list')!;
const libDiscoverCount = document.getElementById('lib-discover-count')!;
const libDiscoverImportBtn = document.getElementById('lib-discover-import-btn')!;
const libDiscoverBackBtn = document.getElementById('lib-discover-back-btn')!;

let discoveredItems: DiscoveredItem[] = [];

function showDiscoverResults(): void {
  libDetailEmpty.style.display = 'none';
  libDetailContent.classList.add('hidden');
  libDiscoverResults.classList.remove('hidden');
  selectedLibraryEntry = null;
  // Deselect sidebar items
  libraryOverlay.querySelectorAll('.library-item').forEach(el => el.classList.remove('active'));
}

function hideDiscoverResults(): void {
  libDiscoverResults.classList.add('hidden');
  discoveredItems = [];
  libDetailEmpty.style.display = '';
  libDetailContent.classList.add('hidden');
}

async function runDiscoverAll(): Promise<void> {
  showDiscoverResults();
  libDiscoverList.innerHTML = '<div class="library-discover-empty">Scanning workspaces...</div>';
  libDiscoverCount.textContent = '';
  libDiscoverImportBtn.textContent = 'Import Selected';
  (libDiscoverImportBtn as HTMLButtonElement).disabled = false;

  try {
    discoveredItems = await api.library.discoverAll();
  } catch {
    discoveredItems = [];
  }

  renderDiscoverResults();
}

function renderDiscoverResults(): void {
  if (discoveredItems.length === 0) {
    libDiscoverList.innerHTML = '<div class="library-discover-empty">No new skills or agents found in workspaces</div>';
    libDiscoverCount.textContent = '';
    (libDiscoverImportBtn as HTMLButtonElement).disabled = true;
    return;
  }

  libDiscoverCount.textContent = `(${discoveredItems.length} found)`;

  // Group by workspace
  const groups = new Map<string, DiscoveredItem[]>();
  for (const item of discoveredItems) {
    const key = item.workspaceId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  let html = '';
  for (const [wsId, items] of groups) {
    const wsName = items[0].workspaceName;
    html += `<div class="library-discover-ws-group">
      <div class="library-discover-ws-group-header">${escapeHtml(wsName)} (${items.length})</div>`;
    for (const item of items) {
      const typeBadge = `<span class="library-type-badge ${item.entry.type}">${item.entry.type}</span>`;
      const desc = item.entry.description ? escapeHtml(item.entry.description) : '';
      html += `<label class="library-discover-item">
        <input type="checkbox" checked data-id="${item.entry.id}" data-type="${item.entry.type}" data-source="${escapeHtml(item.sourcePath)}" />
        <span class="library-discover-item-name">${escapeHtml(item.entry.name || item.entry.id)}</span>
        ${typeBadge}
        ${desc ? `<span class="library-discover-item-desc" title="${desc}">${desc}</span>` : ''}
      </label>`;
    }
    html += '</div>';
  }

  libDiscoverList.innerHTML = html;
}

async function importDiscovered(): Promise<void> {
  const checkboxes = libDiscoverList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
  if (checkboxes.length === 0) return;

  libDiscoverImportBtn.textContent = 'Importing...';
  (libDiscoverImportBtn as HTMLButtonElement).disabled = true;

  let imported = 0;
  for (const cb of checkboxes) {
    const sourcePath = cb.getAttribute('data-source')!;
    const type = cb.getAttribute('data-type')! as 'skill' | 'agent';
    try {
      const result = await api.library.importFromPath(sourcePath, type);
      if (result && result.success) imported++;
    } catch {}
  }

  // Refresh library list
  await refreshLibraryList();

  // Remove imported items from discovered list
  const importedIds = new Set(
    Array.from(checkboxes).map(cb => `${cb.getAttribute('data-id')}:${cb.getAttribute('data-type')}`)
  );
  discoveredItems = discoveredItems.filter(
    item => !importedIds.has(`${item.entry.id}:${item.entry.type}`)
  );

  renderDiscoverResults();
  libDiscoverImportBtn.textContent = 'Import Selected';
  (libDiscoverImportBtn as HTMLButtonElement).disabled = false;

  if (discoveredItems.length === 0) {
    // All imported — go back to normal view
    hideDiscoverResults();
  }
}

libDiscoverBtn.addEventListener('click', () => {
  runDiscoverAll();
});

libDiscoverImportBtn.addEventListener('click', () => {
  importDiscovered();
});

libDiscoverBackBtn.addEventListener('click', () => {
  hideDiscoverResults();
});

// ============================================
// Workspace Modal: Library Checklist
// ============================================

const wsLibraryChecklist = document.getElementById('ws-library-checklist')!;
const wsLibraryGroup = document.getElementById('ws-library-group')!;

async function populateLibraryChecklist(): Promise<void> {
  try {
    libraryEntries = await api.library.list();
  } catch {
    libraryEntries = [];
  }

  if (libraryEntries.length === 0) {
    wsLibraryGroup.style.display = 'none';
    return;
  }

  wsLibraryGroup.style.display = '';
  wsLibraryChecklist.innerHTML = libraryEntries.map(entry => {
    const typeBadge = `<span class="library-type-badge ${entry.type}" style="margin-left:4px;">${entry.type}</span>`;
    return `<label class="library-checklist-item">
      <input type="checkbox" value="${entry.id}" checked />
      <span>${escapeHtml(entry.name || entry.id)}</span>
      ${typeBadge}
    </label>`;
  }).join('');
}

function getCheckedLibraryEntries(): string[] {
  const checkboxes = wsLibraryChecklist.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

// ============================================
// Settings Panel
// ============================================

const settingsOverlay = document.getElementById('settings-overlay')!;
const setFontSizeInput = document.getElementById('set-font-size') as HTMLInputElement;
const setFontFamilyInput = document.getElementById('set-font-family') as HTMLInputElement;
const setDefaultShellInput = document.getElementById('set-default-shell') as HTMLInputElement;
const setScrollbackInput = document.getElementById('set-scrollback') as HTMLInputElement;
const setThemeSelect = document.getElementById('set-theme') as HTMLSelectElement;
const setNotifyIdleInput = document.getElementById('set-notify-idle') as HTMLInputElement;
const setNotifyDelayInput = document.getElementById('set-notify-delay') as HTMLInputElement;
const settingsCancelBtn = document.getElementById('settings-cancel')!;
const settingsSaveBtn = document.getElementById('settings-save')!;

// Phase 4: API settings elements
const setApiKeyInput = document.getElementById('set-api-key') as HTMLInputElement;
const setApiTestBtn = document.getElementById('set-api-test')!;
const setApiStatus = document.getElementById('set-api-status')!;
const setApiOrgInput = document.getElementById('set-api-org') as HTMLInputElement;
const setApiEnabledInput = document.getElementById('set-api-enabled') as HTMLInputElement;

// Settings nav elements
const settingsNavItems = document.querySelectorAll<HTMLButtonElement>('.settings-nav-item');
const settingsSections = document.querySelectorAll<HTMLElement>('.settings-section');
const settingsNavShieldItems = document.querySelectorAll<HTMLButtonElement>('.settings-nav-shield');
let activeSettingsSection = 'general';

function switchSettingsSection(key: string): void {
  activeSettingsSection = key;
  settingsNavItems.forEach(item => {
    item.classList.toggle('active', item.dataset.settingsSection === key);
  });
  settingsSections.forEach(section => {
    const sectionKey = section.id.replace('settings-section-', '');
    section.classList.toggle('hidden', sectionKey !== key);
  });
}

settingsNavItems.forEach(item => {
  item.addEventListener('click', () => {
    const key = item.dataset.settingsSection;
    if (key) switchSettingsSection(key);
  });
});

function updateSettingsShieldNav(): void {
  settingsNavShieldItems.forEach(item => {
    item.classList.toggle('nav-hidden', !shieldActive);
  });
  // If viewing the hidden shield section, switch to general
  if (!shieldActive && activeSettingsSection === 'shield') {
    switchSettingsSection('general');
  }
}

async function openSettings(): Promise<void> {
  switchSettingsSection('general');
  updateSettingsShieldNav();
  setFontSizeInput.value = String(currentSettings.fontSize);
  setFontFamilyInput.value = currentSettings.fontFamily;
  setDefaultShellInput.value = currentSettings.defaultShell;
  setScrollbackInput.value = String(currentSettings.scrollbackLimit);
  setThemeSelect.value = currentSettings.theme;
  setNotifyIdleInput.checked = currentSettings.notifyOnIdle;
  setNotifyDelayInput.value = String(currentSettings.notifyDelaySeconds);

  // Phase 4: Load API config
  try {
    const apiConfig = await api.anthropic.getConfig();
    setApiKeyInput.value = apiConfig.apiKey || '';
    setApiOrgInput.value = apiConfig.orgId || '';
    setApiEnabledInput.checked = apiConfig.enabled || false;
    setApiStatus.textContent = '';
    setApiStatus.className = 'settings-api-status';
  } catch {}

  // Load Shield policy and custom patterns
  loadShieldPolicy();
  loadShieldPatterns();

  // Load scan provider settings
  loadScanProviderSettings();

  settingsOverlay.classList.remove('hidden');
  setFontSizeInput.focus();
}

function closeSettings(): void {
  settingsOverlay.classList.add('hidden');
}

async function saveSettings(): Promise<void> {
  const updates: Partial<AppSettings> = {
    fontSize: parseInt(setFontSizeInput.value) || 14,
    fontFamily: setFontFamilyInput.value.trim() || currentSettings.fontFamily,
    defaultShell: setDefaultShellInput.value.trim() || currentSettings.defaultShell,
    scrollbackLimit: parseInt(setScrollbackInput.value) || 10000,
    theme: setThemeSelect.value as 'dark' | 'light',
    notifyOnIdle: setNotifyIdleInput.checked,
    notifyDelaySeconds: parseInt(setNotifyDelayInput.value) || 5,
  };
  currentSettings = await api.app.updateSettings(updates);

  // Phase 4: Save API config
  try {
    const apiKey = setApiKeyInput.value.trim();
    await api.anthropic.setConfig({
      apiKey,
      orgId: setApiOrgInput.value.trim(),
      enabled: setApiEnabledInput.checked,
    });
  } catch {}

  applySettings();
  closeSettings();
}

function applySettings(): void {
  // Apply theme
  applyTheme(currentSettings.theme);

  // Update all terminal instances
  for (const tab of tabs.values()) {
    const leaves = findAllLeaves(tab.paneRoot);
    for (const leaf of leaves) {
      leaf.terminal.options.fontSize = currentSettings.fontSize;
      leaf.terminal.options.fontFamily = currentSettings.fontFamily;
      leaf.terminal.options.scrollback = currentSettings.scrollbackLimit;
      leaf.terminal.options.theme = getTerminalTheme();
      try { leaf.fitAddon.fit(); } catch {}
    }
  }
}

function applyTheme(theme: 'dark' | 'light'): void {
  document.body.setAttribute('data-theme', theme);
}

settingsCancelBtn.addEventListener('click', closeSettings);
settingsSaveBtn.addEventListener('click', saveSettings);
settingsOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
  if (e.key === 'Enter' && !e.shiftKey) saveSettings();
});

// Phase 4: API test button
setApiTestBtn.addEventListener('click', async () => {
  const apiKey = setApiKeyInput.value.trim();
  if (!apiKey) {
    setApiStatus.textContent = 'Enter an API key first';
    setApiStatus.className = 'settings-api-status error';
    return;
  }
  setApiStatus.textContent = 'Testing...';
  setApiStatus.className = 'settings-api-status';
  const result = await api.anthropic.testConnection(apiKey);
  if (result.success) {
    setApiStatus.textContent = 'Connection successful';
    setApiStatus.className = 'settings-api-status success';
  } else {
    setApiStatus.textContent = result.error || 'Connection failed';
    setApiStatus.className = 'settings-api-status error';
  }
});

// ============================================
// Notification on Command Completion
// ============================================

window.addEventListener('focus', () => { windowIsFocused = true; });
window.addEventListener('blur', () => { windowIsFocused = false; });

function trackPaneActivity(paneId: string, workspaceName: string, tabId: string): void {
  // Clear existing timer for this pane
  const existing = paneIdleTimers.get(paneId);
  if (existing) clearTimeout(existing);

  // Only track if notifications are enabled and window is blurred
  if (!currentSettings.notifyOnIdle || windowIsFocused) return;

  // Set a new idle timer
  const timer = setTimeout(() => {
    paneIdleTimers.delete(paneId);
    showIdleNotification(workspaceName, tabId);
  }, currentSettings.notifyDelaySeconds * 1000);
  paneIdleTimers.set(paneId, timer);
}

function showIdleNotification(workspaceName: string, tabId: string): void {
  if (windowIsFocused) return;
  const snippet = lastOutputSnippet.get(tabId) || '';
  const lines = snippet.split(/[\r\n]+/).filter(l => l.trim());
  const preview = lines.length > 0 ? lines[lines.length - 1].slice(0, 80) : '';
  try {
    const n = new Notification('Tarca Terminal', {
      body: preview
        ? `${workspaceName}: ${preview}`
        : `Command completed in "${workspaceName}"`,
    });
    n.onclick = () => {
      window.focus();
      if (tabs.has(tabId)) activateTab(tabId);
    };
  } catch {}
}

// ============================================
// #10: Export/Import
// ============================================

async function exportConfig(): Promise<void> {
  const result = await api.app.exportConfig();
  if (result?.error) {
    alert('Export failed: ' + result.error);
  }
}

async function importConfig(): Promise<void> {
  const result = await api.app.importConfig();
  if (result?.error) {
    alert('Import failed: ' + result.error);
  } else if (result?.success) {
    // Kill all running PTYs before reloading to prevent orphan processes
    for (const tab of tabs.values()) {
      findAllLeaves(tab.paneRoot).forEach(leaf => {
        api.pty.kill(leaf.id);
      });
    }
    location.reload();
  }
}

// ============================================
// IPC Listeners
// ============================================

function setupIpcListeners(): void {
  // PTY data → terminal
  api.pty.onData(({ workspaceId, data }) => {
    // Find the pane by workspaceId (which is actually paneId for split panes)
    for (const [tabId, tab] of tabs) {
      const pane = findPaneById(tab.paneRoot, workspaceId);
      if (pane && pane.type === 'leaf') {
        pane.terminal.write(data);

        // Track last output snippet for notification preview
        const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (cleaned) lastOutputSnippet.set(tabId, cleaned.slice(-200));

        // #4: Unread badge — if this tab is not active
        if (tabId !== activeTabId) {
          tab.hasUnread = true;
          tab.unreadCount++;
          updateTabBadge(tabId);
        }

        // Notification on command completion: track activity
        trackPaneActivity(workspaceId, tab.workspace.name, tabId);
        return;
      }
    }
  });

  // PTY exit
  api.pty.onExit(({ workspaceId: paneId, exitCode }) => {
    for (const [tabId, tab] of tabs) {
      const pane = findPaneById(tab.paneRoot, paneId);
      if (pane && pane.type === 'leaf') {
        pane.status = 'dead';
        updateTabStatus(tabId);

        // Session resume failure detection: if pane-0 exits within 10s of a resume attempt,
        // clear the stale session ID and auto-restart with a fresh session
        if (pane.id.endsWith(':pane-0') && tab._resumeAttemptTime && (Date.now() - tab._resumeAttemptTime) < 10000) {
          tab._resumeAttemptTime = null;
          tab.workspace.lastClaudeSessionId = undefined;
          api.workspace.update(tab.workspace.id, { lastClaudeSessionId: undefined });
          showToast('\u26A0 Resume Failed', `${tab.workspace.name}: starting fresh session`, 'var(--orange, #D29922)', 5000);
          setTimeout(async () => {
            if (!tabs.has(tabId)) return;
            await spawnPaneTerminal(tabId, pane);
            updateTabStatus(tabId);
          }, 1000);
          return;
        }

        // #9: Auto-restart logic
        if (tab.workspace.autoRestart && tab.restartCount < (tab.workspace.maxRestarts || 3)) {
          tab.restartCount++;
          pane.terminal.writeln(`\r\n\x1b[33mProcess exited (${exitCode}). Auto-restarting in 2s... (${tab.restartCount}/${tab.workspace.maxRestarts || 3})\x1b[0m`);

          setTimeout(async () => {
            if (!tabs.has(tabId)) return;
            pane.terminal.writeln('\x1b[33mRestarting...\x1b[0m\r\n');
            await spawnPaneTerminal(tabId, pane);
            updateTabStatus(tabId);

            // Start stability timer: if runs for 30s, reset count
            if (tab.restartStabilityTimer) clearTimeout(tab.restartStabilityTimer);
            tab.restartStabilityTimer = setTimeout(() => {
              tab.restartCount = 0;
            }, 30000);
          }, 2000);
        } else {
          const restartMsg = tab.workspace.autoRestart
            ? `\r\n\x1b[31mMax restarts reached. Press Enter to manually restart.\x1b[0m`
            : `\r\n\x1b[33mProcess exited with code ${exitCode}. Press Enter to restart.\x1b[0m`;
          pane.terminal.writeln(restartMsg);

          // Allow pressing Enter to restart
          const disposable = pane.terminal.onKey(({ key }) => {
            if (key === '\r') {
              disposable.dispose();
              tab.restartCount = 0;
              if (tab.restartStabilityTimer) {
                clearTimeout(tab.restartStabilityTimer);
                tab.restartStabilityTimer = null;
              }
              pane.terminal.writeln('\x1b[33mRestarting...\x1b[0m\r\n');
              spawnPaneTerminal(tabId, pane).then(() => updateTabStatus(tabId));
            }
          });
        }
        return;
      }
    }
  });

  // Shortcuts from main process
  api.shortcuts.onNewWorkspace(() => openNewModal());
  api.shortcuts.onCloseTab(() => {
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab?.workspace.pinned) return; // Skip pinned tabs on Ctrl+W
      closeTab(activeTabId);
    }
  });
  api.shortcuts.onNextTab(() => cycleTab(1));
  api.shortcuts.onPrevTab(() => cycleTab(-1));
  api.shortcuts.onGoToTab((index) => goToTabByIndex(index));
  api.shortcuts.onRestartTerminal(() => { if (activeTabId) restartTerminal(activeTabId); });

  // #7: Search
  api.shortcuts.onSearch(() => toggleSearch());

  // #5: Quick switcher
  api.shortcuts.onQuickSwitcher(() => {
    if (qsOverlay.classList.contains('hidden')) {
      openQuickSwitcher();
    } else {
      closeQuickSwitcher();
    }
  });

  // #2: Split panes
  api.shortcuts.onSplitDown(() => { if (activeTabId) splitPane(activeTabId, 'vertical'); });
  api.shortcuts.onSplitRight(() => { if (activeTabId) splitPane(activeTabId, 'horizontal'); });
  api.shortcuts.onClosePane(() => {
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab) closePaneById(activeTabId, tab.activePaneId);
    }
  });

  // #10: Export/Import
  api.shortcuts.onExportConfig(() => exportConfig());
  api.shortcuts.onImportConfig(() => importConfig());

  // Sidebar toggle
  api.shortcuts.onToggleSidebar(() => toggleSidebar());

  // New Tab for Workspace (from menu bar)
  api.shortcuts.onNewTabForWorkspace(() => {
    if (activeTabId) openNewTabForWorkspace(activeTabId);
  });

  // Settings
  api.shortcuts.onSettings(() => {
    if (settingsOverlay.classList.contains('hidden')) {
      openSettings();
    } else {
      closeSettings();
    }
  });

  // Tray workspace activation
  api.tray.onActivateWorkspace((workspaceId) => {
    // workspaceId from tray is the base workspace ID
    const firstTab = getFirstTabForWorkspace(workspaceId);
    if (firstTab) {
      activateTab(firstTab.tabId);
    } else {
      // Workspace not open — find it in allWorkspaces and open it
      const ws = allWorkspaces.find(w => w.id === workspaceId);
      if (ws) {
        addWorkspaceTab(ws).then((newTabId) => {
          activateTab(newTabId);
          renderSidebar();
        });
      }
    }
  });

  // Claude Code metrics updates
  api.claude.onMetricsUpdate((entry) => {
    claudeMetrics.set(entry.workspaceId, entry);
    // If the active tab belongs to this workspace, update display immediately
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab && tab.workspace.id === entry.workspaceId) {
        updateClaudeMetricsDisplay(entry);
      }
    }
  });

  // Claude Code session ID updates (for resume-on-reboot)
  api.claude.onSessionUpdate(({ workspaceId, sessionId }) => {
    // Update all tab instances for this workspace
    for (const tab of getTabsForWorkspace(workspaceId)) {
      tab.workspace.lastClaudeSessionId = sessionId;
    }
    const idx = allWorkspaces.findIndex(w => w.id === workspaceId);
    if (idx !== -1) allWorkspaces[idx].lastClaudeSessionId = sessionId;
  });

  // Shield status + detection events
  api.shield.onStatus((status) => {
    updateShieldStatus(status);
  });

  api.shield.onDetection(({ workspaceId, detection }) => {
    // Update count
    shieldDetectionCount++;
    shieldCountEl.textContent = String(shieldDetectionCount);
    statusShield.classList.remove('active');
    statusShield.classList.add('warn');

    // Show toast for block and monitor actions (warn is handled by the warn prompt modal)
    if (detection.action === 'block' || detection.action === 'monitor') {
      showShieldToast(detection);
    }

    // Update tab shield badge — workspaceId from shield can be a paneId like "wsId~1:pane-0"
    if (workspaceId) {
      const baseWsId = workspaceId.split(':')[0].split('~')[0];
      // Update ALL tab instances for this workspace
      for (const tab of getTabsForWorkspace(baseWsId)) {
        tab.shieldDetectionCount++;
        if (detection.action === 'block') tab.shieldHasBlock = true;
        updateTabShieldBadge(tab.tabId);
      }
    }
  });

  // Shield warn prompt flow
  api.shield.onWarnPrompt(({ workspaceId, detection }) => {
    showWarnPrompt(workspaceId, detection);
  });

  // Shield scan progress/result listeners
  api.shield.onScanProgress((progress) => {
    handleScanProgress(progress);
  });

  api.shield.onScanResult((result) => {
    handleScanResult(result);
  });

  // Shield scan invalidation (branch switch)
  api.shield.onScanInvalidate((workspaceId) => {
    scanStates.delete(workspaceId);
    updateTabScanBadge(workspaceId, 'none');
    showToast('Scan Invalidated', 'Branch changed — scan results invalidated', 'var(--orange)', 3000);
  });

  // Analytics dashboard shortcut
  api.claude.onAnalyticsDashboard(() => {
    if (dashboardOverlay.classList.contains('hidden')) {
      openDashboard();
    } else {
      closeDashboard();
    }
  });

  // Skills & Agents Library shortcut
  api.library.onOpenLibrary(() => {
    if (libraryOverlay.classList.contains('hidden')) {
      openLibraryPanel();
    } else {
      closeLibraryPanel();
    }
  });
}

function cycleTab(direction: number): void {
  const ids = Array.from(tabs.keys());
  if (ids.length === 0) return;
  const currentIndex = activeTabId ? ids.indexOf(activeTabId) : -1;
  const newIndex = (currentIndex + direction + ids.length) % ids.length;
  activateTab(ids[newIndex]);
}

function goToTabByIndex(index: number): void {
  const ids = Array.from(tabs.keys());
  if (index < ids.length) {
    activateTab(ids[index]);
  }
}

// ============================================
// Window Resize Handler
// ============================================

function handleResize(): void {
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab) {
      findAllLeaves(tab.paneRoot).forEach(leaf => {
        try { leaf.fitAddon.fit(); } catch {}
      });
    }
  }
}

let resizeTimeout: number;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = window.setTimeout(handleResize, 100) as unknown as number;
});

// #1: Save scrollback on window unload (best-effort, async may not complete)
window.addEventListener('beforeunload', () => {
  for (const tab of tabs.values()) {
    saveScrollbackForTab(tab);
  }
});

// #1: Periodically save scrollback as a safety net (every 30s)
setInterval(() => {
  for (const tab of tabs.values()) {
    saveScrollbackForTab(tab);
  }
}, 30000);

// ============================================
// Shield Policy Management
// ============================================

const shieldPolicySection = document.getElementById('shield-policy-section')!;
const shieldDefaultActionSelect = document.getElementById('shield-default-action') as HTMLSelectElement;
const shieldRulesTbody = document.getElementById('shield-rules-tbody')!;
const shieldRulesSaveBtn = document.getElementById('shield-rules-save')!;
const shieldWsOverridesDiv = document.getElementById('shield-ws-overrides')!;
const shieldWsOverrideSelect = document.getElementById('shield-ws-override-select') as HTMLSelectElement;
const shieldWsOverrideAddBtn = document.getElementById('shield-ws-override-add')!;
const shieldLicenseInfo = document.getElementById('shield-license-info')!;
const shieldLicenseToken = document.getElementById('shield-license-token') as HTMLInputElement;
const shieldLicenseInstallBtn = document.getElementById('shield-license-install-btn')!;

const DETECTION_CATEGORIES = ['pii', 'credential', 'classification', 'code_secret', 'data_pattern', 'custom'];

async function loadShieldPolicy(): Promise<void> {
  if (!shieldActive) {
    return;
  }

  try {
    const policy = await api.shield.getPolicy();
    if (policy && !policy.error) {
      renderPolicyUI(policy);
    }
  } catch {
    shieldPolicySection.style.display = 'none';
  }

  // Load license status
  try {
    const license = await api.shield.getLicenseStatus();
    renderLicenseStatus(license);
  } catch {}
}

function renderPolicyUI(policy: any): void {
  // Default action
  shieldDefaultActionSelect.value = policy.defaultAction || 'monitor';

  // Global rules table
  shieldRulesTbody.innerHTML = DETECTION_CATEGORIES.map(cat => {
    const rule = (policy.globalRules || []).find((r: any) => r.category === cat);
    const action = rule?.action || policy.defaultAction || 'monitor';
    return `<tr data-category="${cat}">
      <td>${cat.replace('_', ' ')}</td>
      <td>
        <select class="shield-rule-action" data-category="${cat}">
          <option value="monitor"${action === 'monitor' ? ' selected' : ''}>Monitor</option>
          <option value="warn"${action === 'warn' ? ' selected' : ''}>Warn</option>
          <option value="block"${action === 'block' ? ' selected' : ''}>Block</option>
        </select>
      </td>
    </tr>`;
  }).join('');

  // Workspace overrides
  renderWorkspaceOverrides(policy);

  // Populate workspace override selector
  shieldWsOverrideSelect.innerHTML = '<option value="">Select workspace...</option>';
  for (const ws of allWorkspaces) {
    if (!policy.workspaceOverrides || !policy.workspaceOverrides[ws.id]) {
      shieldWsOverrideSelect.innerHTML += `<option value="${ws.id}">${escapeHtml(ws.name)}</option>`;
    }
  }
}

function renderWorkspaceOverrides(policy: any): void {
  const overrides = policy.workspaceOverrides || {};
  const entries = Object.entries(overrides);

  if (entries.length === 0) {
    shieldWsOverridesDiv.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">No workspace overrides</div>';
    return;
  }

  shieldWsOverridesDiv.innerHTML = entries.map(([wsId, override]: [string, any]) => {
    const wsName = override.name || allWorkspaces.find(w => w.id === wsId)?.name || wsId;
    const rulesHtml = (override.rules || []).map((r: any) => `
      <span style="font-size: 11px; padding: 1px 6px; background: var(--bg-hover); border-radius: 3px;">
        ${r.category}: <strong>${r.action}</strong>
      </span>
    `).join(' ');

    return `<div class="shield-ws-override" data-ws-id="${wsId}" style="padding: 8px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="font-size: 13px;">${escapeHtml(wsName)}</strong>
        <button class="shield-ws-remove-btn btn-secondary" data-ws-id="${wsId}" style="font-size: 11px; padding: 2px 8px;">Remove</button>
      </div>
      <div style="margin-top: 4px;">${rulesHtml || '<span style="color: var(--text-muted); font-size: 11px;">No rules</span>'}</div>
    </div>`;
  }).join('');

  // Bind remove buttons
  shieldWsOverridesDiv.querySelectorAll('.shield-ws-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const wsId = (btn as HTMLElement).dataset.wsId!;
      await api.shield.deleteWorkspaceOverride(wsId);
      await loadShieldPolicy();
    });
  });
}

function renderLicenseStatus(license: any): void {
  if (license.valid) {
    shieldLicenseInfo.innerHTML = `
      <div class="license-valid">&#x2714; License Valid</div>
      ${license.org ? `<div>Organization: ${escapeHtml(license.org)}</div>` : ''}
      ${license.seats ? `<div>Seats: ${license.seats}</div>` : ''}
      ${license.expiresAt ? `<div>Expires: ${new Date(license.expiresAt).toLocaleDateString()}</div>` : ''}
      ${license.error ? `<div style="color: var(--orange);">${escapeHtml(license.error)}</div>` : ''}
    `;
  } else {
    shieldLicenseInfo.innerHTML = `
      <div class="license-invalid">&#x2718; ${escapeHtml(license.error || 'No valid license')}</div>
      <div style="margin-top: 4px; color: var(--text-muted);">Shield runs in monitor-only mode without a valid license.</div>
    `;
  }
}

// Save global rules
shieldRulesSaveBtn.addEventListener('click', async () => {
  const rules = Array.from(shieldRulesTbody.querySelectorAll('.shield-rule-action')).map(select => ({
    category: (select as HTMLSelectElement).dataset.category,
    action: (select as HTMLSelectElement).value,
  }));

  // Save default action
  await api.shield.updateDefaultAction(shieldDefaultActionSelect.value);
  await api.shield.updateRules(rules);
  showToast('Policy Saved', 'Global rules updated successfully.', 'var(--green)', 3000);
});

// Add workspace override
shieldWsOverrideAddBtn.addEventListener('click', async () => {
  const wsId = shieldWsOverrideSelect.value;
  if (!wsId) return;

  const ws = allWorkspaces.find(w => w.id === wsId);
  // Create a default override with all categories set to the same as global
  const policy = await api.shield.getPolicy();
  const globalRules = policy.globalRules || [];

  await api.shield.updateWorkspaceOverride(wsId, {
    name: ws?.name || wsId,
    rules: globalRules.map((r: any) => ({ category: r.category, action: r.action })),
  });

  await loadShieldPolicy();
});

// Install license
shieldLicenseInstallBtn.addEventListener('click', async () => {
  const token = shieldLicenseToken.value.trim();
  if (!token) return;

  try {
    const result = await api.shield.installLicense(token);
    renderLicenseStatus(result);
    shieldLicenseToken.value = '';
    if (result.valid) {
      showToast('License Installed', 'Shield license is now active.', 'var(--green)', 3000);
    } else {
      showToast('License Invalid', result.error || 'License validation failed.', 'var(--red)', 5000);
    }
  } catch (err: any) {
    showToast('Error', 'Failed to install license.', 'var(--red)', 5000);
  }
});

// ============================================
// Shield Custom Patterns
// ============================================

const shieldPatternsSection = document.getElementById('shield-patterns-section')!;
const shieldPatternsTbody = document.getElementById('shield-patterns-tbody')!;
const shieldPatternEmpty = document.getElementById('shield-pattern-empty')!;
const shieldPatternForm = document.getElementById('shield-pattern-form')!;
const spNameInput = document.getElementById('sp-name') as HTMLInputElement;
const spPatternInput = document.getElementById('sp-pattern') as HTMLInputElement;
const spTypeSelect = document.getElementById('sp-type') as HTMLSelectElement;
const spActionSelect = document.getElementById('sp-action') as HTMLSelectElement;
const spDescInput = document.getElementById('sp-description') as HTMLInputElement;
const spCancelBtn = document.getElementById('sp-cancel')!;
const spSaveBtn = document.getElementById('sp-save')!;
const spAddBtn = document.getElementById('sp-add-btn')!;
const spTestToggle = document.getElementById('sp-test-toggle')!;
const spImportBtn = document.getElementById('sp-import-btn')!;
const spExportBtn = document.getElementById('sp-export-btn')!;
const shieldTestPanel = document.getElementById('shield-test-panel')!;
const spTestText = document.getElementById('sp-test-text') as HTMLTextAreaElement;
const spTestRunBtn = document.getElementById('sp-test-run')!;
const spTestResults = document.getElementById('sp-test-results')!;

let editingPatternId: string | null = null;
let cachedCustomPatterns: any[] = [];

async function loadShieldPatterns(): Promise<void> {
  if (!shieldActive) {
    return;
  }

  try {
    const policy = await api.shield.getPolicy();
    if (policy && !policy.error) {
      cachedCustomPatterns = policy.customPatterns || [];
      renderPatternsTable();
    }
  } catch {
    shieldPatternsSection.style.display = 'none';
  }
}

function renderPatternsTable(): void {
  if (cachedCustomPatterns.length === 0) {
    shieldPatternsTbody.innerHTML = '';
    shieldPatternEmpty.style.display = '';
    (document.getElementById('shield-patterns-table-wrap')! as HTMLElement).style.display = 'none';
    return;
  }

  shieldPatternEmpty.style.display = 'none';
  (document.getElementById('shield-patterns-table-wrap')! as HTMLElement).style.display = '';

  shieldPatternsTbody.innerHTML = cachedCustomPatterns.map(p => `
    <tr data-pattern-id="${escapeHtml(p.id)}">
      <td>${escapeHtml(p.name)}</td>
      <td title="${escapeHtml(p.pattern)}">${escapeHtml(p.pattern)}</td>
      <td><span class="shield-pattern-type-badge${p.isRegex ? ' regex' : ''}">${p.isRegex ? 'Regex' : 'Keyword'}</span></td>
      <td><span class="shield-action-badge ${p.action}">${p.action}</span></td>
      <td>
        <div class="shield-pattern-row-actions">
          <button class="sp-edit-btn" title="Edit">&#9998;</button>
          <button class="sp-delete-btn danger" title="Delete">&#10005;</button>
        </div>
      </td>
    </tr>
  `).join('');

  // Bind edit/delete handlers
  shieldPatternsTbody.querySelectorAll('.sp-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = (btn as HTMLElement).closest('tr')!;
      startEditPattern(row.dataset.patternId!);
    });
  });

  shieldPatternsTbody.querySelectorAll('.sp-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = (btn as HTMLElement).closest('tr')!;
      const id = row.dataset.patternId!;
      if (!confirm('Delete this pattern?')) return;
      const result = await api.shield.deletePattern(id);
      if (result && !result.error) {
        cachedCustomPatterns = result.customPatterns || [];
        renderPatternsTable();
      }
    });
  });
}

function startAddPattern(): void {
  editingPatternId = null;
  spNameInput.value = '';
  spPatternInput.value = '';
  spTypeSelect.value = 'keyword';
  spActionSelect.value = 'monitor';
  spDescInput.value = '';
  shieldPatternForm.classList.remove('hidden');
  spNameInput.focus();
}

function startEditPattern(id: string): void {
  const pattern = cachedCustomPatterns.find(p => p.id === id);
  if (!pattern) return;
  editingPatternId = id;
  spNameInput.value = pattern.name;
  spPatternInput.value = pattern.pattern;
  spTypeSelect.value = pattern.isRegex ? 'regex' : 'keyword';
  spActionSelect.value = pattern.action;
  spDescInput.value = pattern.description || '';
  shieldPatternForm.classList.remove('hidden');
  spNameInput.focus();
}

function cancelPatternEdit(): void {
  editingPatternId = null;
  shieldPatternForm.classList.add('hidden');
}

async function savePattern(): Promise<void> {
  const name = spNameInput.value.trim();
  const pattern = spPatternInput.value.trim();
  if (!name || !pattern) {
    if (!name) spNameInput.style.borderColor = '#F85149';
    if (!pattern) spPatternInput.style.borderColor = '#F85149';
    return;
  }

  const now = new Date().toISOString();
  const patternObj = {
    id: editingPatternId || `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    pattern,
    isRegex: spTypeSelect.value === 'regex',
    category: 'custom' as const,
    action: spActionSelect.value as 'monitor' | 'warn' | 'block',
    description: spDescInput.value.trim(),
    createdAt: editingPatternId
      ? (cachedCustomPatterns.find(p => p.id === editingPatternId)?.createdAt || now)
      : now,
    updatedAt: now,
  };

  const result = await api.shield.upsertPattern(patternObj);
  if (result && !result.error) {
    cachedCustomPatterns = result.customPatterns || [];
    renderPatternsTable();
    cancelPatternEdit();
  }
}

function toggleTestPanel(): void {
  shieldTestPanel.classList.toggle('hidden');
  if (!shieldTestPanel.classList.contains('hidden')) {
    spTestText.focus();
  }
}

async function runPatternTest(): Promise<void> {
  const sampleText = spTestText.value;
  if (!sampleText.trim()) {
    spTestResults.innerHTML = '<div class="test-no-match">Enter sample text above</div>';
    return;
  }

  // If form is open, test the current form pattern
  if (!shieldPatternForm.classList.contains('hidden') && spPatternInput.value.trim()) {
    const pattern = spPatternInput.value.trim();
    const isRegex = spTypeSelect.value === 'regex';
    const result = await api.shield.testPattern(pattern, isRegex, sampleText);
    if (Array.isArray(result)) {
      renderTestResults([{ name: spNameInput.value || 'Current Pattern', matches: result }]);
    } else {
      spTestResults.innerHTML = `<div class="test-no-match">Error: ${escapeHtml((result as any).error)}</div>`;
    }
    return;
  }

  // Otherwise test all custom patterns
  if (cachedCustomPatterns.length === 0) {
    spTestResults.innerHTML = '<div class="test-no-match">No custom patterns to test</div>';
    return;
  }

  const allResults: Array<{ name: string; matches: Array<{ match: string; index: number }> }> = [];
  for (const cp of cachedCustomPatterns) {
    const result = await api.shield.testPattern(cp.pattern, cp.isRegex, sampleText);
    if (Array.isArray(result) && result.length > 0) {
      allResults.push({ name: cp.name, matches: result });
    }
  }

  if (allResults.length === 0) {
    spTestResults.innerHTML = '<div class="test-no-match">No matches found</div>';
  } else {
    renderTestResults(allResults);
  }
}

function renderTestResults(results: Array<{ name: string; matches: Array<{ match: string; index: number }> }>): void {
  let html = '';
  let totalMatches = 0;
  for (const r of results) {
    totalMatches += r.matches.length;
    html += `<div class="test-summary">${escapeHtml(r.name)}: ${r.matches.length} match${r.matches.length !== 1 ? 'es' : ''}</div>`;
    for (const m of r.matches.slice(0, 20)) {
      html += `<div class="test-match">
        <span class="test-match-text">${escapeHtml(m.match)}</span>
        <span class="test-match-pos">at position ${m.index}</span>
      </div>`;
    }
    if (r.matches.length > 20) {
      html += `<div class="test-match"><span class="test-match-pos">...and ${r.matches.length - 20} more</span></div>`;
    }
  }
  spTestResults.innerHTML = html;
}

// Shield pattern form event handlers
spNameInput.addEventListener('input', () => { spNameInput.style.borderColor = ''; });
spPatternInput.addEventListener('input', () => { spPatternInput.style.borderColor = ''; });
spCancelBtn.addEventListener('click', cancelPatternEdit);
spSaveBtn.addEventListener('click', savePattern);
spAddBtn.addEventListener('click', startAddPattern);
spTestToggle.addEventListener('click', toggleTestPanel);
spTestRunBtn.addEventListener('click', runPatternTest);

spExportBtn.addEventListener('click', async () => {
  const result = await api.shield.exportPolicy();
  if (result?.error) {
    alert('Export failed: ' + result.error);
  }
});

spImportBtn.addEventListener('click', async () => {
  const result = await api.shield.importPolicy();
  if (result?.error) {
    alert('Import failed: ' + result.error);
  } else if (result?.success) {
    // Reload patterns from the imported policy
    await loadShieldPatterns();
  }
});

// ============================================
// Scan Provider Settings
// ============================================

async function loadScanProviderSettings(): Promise<void> {
  if (!shieldActive) {
    scanProviderSection.style.display = 'none';
    return;
  }

  try {
    const status = await api.shield.getScanProviderStatus();
    scanProviderName.textContent = status.providerName || 'Not configured';
    scanProviderIndicator.className = `scan-provider-indicator ${status.configured ? 'configured' : 'unconfigured'}`;
    shieldSupportsScanning = true;

    // Show/hide scan fields in workspace modal if already open
    scanPolicyGroup.style.display = '';
    scanBackgroundGroup.style.display = '';
    scanBypassGroup.style.display = '';
    scanThresholdGroup.style.display = '';
    scanExcludeGroup.style.display = '';

    // Load schema and render fields
    const schema = await api.shield.getScanProviderSchema();
    renderScanProviderFields(schema);
  } catch {
    scanProviderSection.style.display = 'none';
    shieldSupportsScanning = false;
  }
}

function renderScanProviderFields(schema: ScanProviderConfigField[]): void {
  scanProviderFields.innerHTML = '';
  for (const field of schema) {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.setAttribute('for', `scan-field-${field.key}`);
    label.textContent = field.label;

    const input = document.createElement('input');
    input.type = field.type === 'password' ? 'password' : 'text';
    input.id = `scan-field-${field.key}`;
    input.dataset.fieldKey = field.key;
    input.placeholder = field.placeholder || '';
    input.autocomplete = 'off';

    group.appendChild(label);
    group.appendChild(input);
    scanProviderFields.appendChild(group);
  }
}

function gatherScanProviderConfig(): Record<string, string> {
  const config: Record<string, string> = {};
  scanProviderFields.querySelectorAll<HTMLInputElement>('[data-field-key]').forEach(input => {
    config[input.dataset.fieldKey!] = input.value.trim();
  });
  return config;
}

scanProviderSaveBtn.addEventListener('click', async () => {
  const config = gatherScanProviderConfig();
  scanProviderResult.textContent = 'Saving & testing...';
  scanProviderResult.className = 'settings-api-status';

  const result = await api.shield.configureScanProvider(config);
  if (result.success) {
    scanProviderResult.textContent = 'Saved — connection successful';
    scanProviderResult.className = 'settings-api-status success';
    scanProviderIndicator.className = 'scan-provider-indicator configured';
    shieldSupportsScanning = true;
  } else {
    scanProviderResult.textContent = result.error || 'Failed to save / connect';
    scanProviderResult.className = 'settings-api-status error';
  }
});

// ============================================
// Event Bindings
// ============================================

addTabBtn.addEventListener('click', openNewModal);
emptyAddBtn.addEventListener('click', openNewModal);
sidebarToggleBtn.addEventListener('click', toggleSidebar);
sidebarAddBtn.addEventListener('click', openNewModal);
sidebarFilter.addEventListener('input', () => renderSidebar());
modalCancel.addEventListener('click', closeModal);
modalSave.addEventListener('click', saveModal);

// Advanced section toggle
wsAdvancedToggle.addEventListener('click', () => {
  const expanded = wsAdvancedSection.classList.toggle('expanded');
  wsAdvancedChevron.classList.toggle('expanded', expanded);
  wsAdvancedToggle.setAttribute('aria-expanded', String(expanded));
});

wsBrowseBtn.addEventListener('click', async () => {
  const folder = await api.workspace.pickFolder();
  if (folder) {
    wsCwdInput.value = folder;
    wsCwdInput.style.borderColor = '';
  }
});

wsCwdInput.addEventListener('click', async () => {
  const folder = await api.workspace.pickFolder();
  if (folder) {
    wsCwdInput.value = folder;
    wsCwdInput.style.borderColor = '';
  }
});

// Reset field highlight on input
wsNameInput.addEventListener('input', () => { wsNameInput.style.borderColor = ''; });

// #9: Toggle max restarts visibility
wsAutorestartInput.addEventListener('change', () => {
  maxRestartsGroup.style.display = wsAutorestartInput.checked ? '' : 'none';
});

// Toggle resume mode dropdown visibility based on startup command
wsCommandInput.addEventListener('input', () => {
  const isClaudeCmd = /^claude(\s|$)/i.test(wsCommandInput.value.trim());
  resumeModeGroup.style.display = isClaudeCmd ? '' : 'none';
});

// Scaffold mode toggle
existingModeBtn.addEventListener('click', () => toggleScaffoldMode(false));
scaffoldModeBtn.addEventListener('click', () => toggleScaffoldMode(true));

// Scaffold browse button
scaffoldBrowseBtn.addEventListener('click', async () => {
  const folder = await api.workspace.pickFolder();
  if (folder) {
    scaffoldParentDirInput.value = folder;
    scaffoldParentDirInput.style.borderColor = '';
  }
});

scaffoldParentDirInput.addEventListener('click', async () => {
  const folder = await api.workspace.pickFolder();
  if (folder) {
    scaffoldParentDirInput.value = folder;
    scaffoldParentDirInput.style.borderColor = '';
  }
});

// Reset scaffold field highlights on input
scaffoldProjectNameInput.addEventListener('input', () => { scaffoldProjectNameInput.style.borderColor = ''; });

// #8: Template selection
wsTemplateSelect.addEventListener('change', () => {
  const tmpl = templates.find(t => t.name === wsTemplateSelect.value);
  if (tmpl) {
    wsCommandInput.value = tmpl.startupCommand || '';
    wsAutostartInput.checked = tmpl.autoStart;
    wsAutorestartInput.checked = tmpl.autoRestart || false;
    wsMaxRestartsInput.value = String(tmpl.maxRestarts || 3);
    maxRestartsGroup.style.display = tmpl.autoRestart ? '' : 'none';
    wsGroupInput.value = tmpl.group || '';
    selectedColor = tmpl.color;
    initColorPicker();
  }
});

// Modal keyboard handling
modalOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && !e.shiftKey) saveModal();
});

// #7: Search bar events
searchInput.addEventListener('input', () => doSearch('next'));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doSearch(e.shiftKey ? 'prev' : 'next');
  }
  if (e.key === 'Escape') {
    closeSearch();
  }
});
searchNextBtn.addEventListener('click', () => doSearch('next'));
searchPrevBtn.addEventListener('click', () => doSearch('prev'));
searchCloseBtn.addEventListener('click', closeSearch);

// #5: Quick switcher events
qsInput.addEventListener('input', () => {
  qsSelectedIndex = 0;
  renderQuickSwitcherResults(qsInput.value);
});

qsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeQuickSwitcher();
    return;
  }
  if (e.key === 'Enter') {
    quickSwitcherSelectCurrent();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const items = qsResults.querySelectorAll('.qs-item');
    qsSelectedIndex = Math.min(qsSelectedIndex + 1, items.length - 1);
    renderQuickSwitcherResults(qsInput.value);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    qsSelectedIndex = Math.max(qsSelectedIndex - 1, 0);
    renderQuickSwitcherResults(qsInput.value);
    return;
  }
});

qsOverlay.addEventListener('click', (e) => {
  if (e.target === qsOverlay) closeQuickSwitcher();
});

// ============================================
// Initialization
// ============================================

async function init(): Promise<void> {
  if (!window.api) {
    console.error('Preload API not available. Ensure the app is running in Electron.');
    return;
  }

  // Add platform class so CSS can target macOS-specific styles
  if (window.api.app.platform === 'darwin') {
    document.body.classList.add('platform-darwin');
  }

  setupIpcListeners();

  // Load settings first so terminal creation uses correct font/theme
  try {
    currentSettings = await api.app.getSettings();
  } catch {}
  applyTheme(currentSettings.theme);

  // Load saved workspaces
  const config = await api.app.getConfig();
  allWorkspaces = config.workspaces || [];

  // #3: Load group states
  const groups: WorkspaceGroup[] = config.groups || [];
  for (const g of groups) {
    groupStates.set(g.name, g.collapsed);
  }

  // #8: Load templates
  templates = config.templates || [];

  // Install Claude Code statusline hook (idempotent)
  try {
    await api.claude.setupHook();
  } catch {}

  // Render sidebar (shows all workspaces regardless of open state)
  renderSidebar();

  if (allWorkspaces.length === 0) {
    updateEmptyState();
    return;
  }

  // Phase 2: Auth pre-check for Claude workspaces
  let claudeAuthenticated = true;
  try {
    const authStatus = await api.claude.checkAuth();
    claudeAuthenticated = authStatus.authenticated;
  } catch {
    // If check fails, assume authenticated to avoid blocking
  }

  // Only auto-open workspaces with autoStart: true
  // Stagger startup commands so the first claude process authenticates
  // before subsequent ones start (prevents multiple sign-in prompts)
  const STARTUP_STAGGER_MS = 3000;
  const autoStartWorkspaces = allWorkspaces.filter(ws => ws.autoStart);
  let claudeIdx = 0;
  let firstTabId: string | null = null;
  for (let i = 0; i < autoStartWorkspaces.length; i++) {
    const ws = autoStartWorkspaces[i];
    const isClaudeWorkspace = ws.startupCommand?.includes('claude');

    if (!claudeAuthenticated && isClaudeWorkspace) {
      // Spawn terminal but clear startupCommand so shell opens without running claude
      const wsWithoutCmd = { ...ws, startupCommand: undefined };
      const newTabId = await addWorkspaceTab(wsWithoutCmd, true);
      if (!firstTabId) firstTabId = newTabId;
      const tab = tabs.get(newTabId);
      if (tab) {
        // Restore the original workspace reference (with startupCommand)
        tab.workspace = ws;
        const leaves = findAllLeaves(tab.paneRoot);
        for (const leaf of leaves) {
          leaf.terminal.writeln('\x1b[33m[Tarca Terminal] Claude CLI is not authenticated. Run "claude auth login" to sign in.\x1b[0m\r\n');
        }
      }
    } else {
      const startupDelay = 600 + (isClaudeWorkspace ? (claudeIdx++ * STARTUP_STAGGER_MS) : 0);
      const newTabId = await addWorkspaceTab(ws, true, startupDelay);
      if (!firstTabId) firstTabId = newTabId;
    }
  }

  // Activate the last active tab or the first open one
  // Backward compat: old config may store a workspace.id (no tilde) — find matching tab
  let targetTab: string | null = null;
  if (config.activeTabId) {
    if (tabs.has(config.activeTabId)) {
      // Config stored a tabId (new format)
      targetTab = config.activeTabId;
    } else {
      // Config stored a workspace.id (old format) — find the first tab for that workspace
      const match = getFirstTabForWorkspace(config.activeTabId);
      if (match) targetTab = match.tabId;
    }
  }
  if (!targetTab) targetTab = firstTabId;

  if (targetTab && tabs.has(targetTab)) {
    activateTab(targetTab);
  }

  updateEmptyState();
  renderSidebar();
}

// Start the app
init().catch(console.error);
