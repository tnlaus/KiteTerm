import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Workspace, WORKSPACE_COLORS, TerminalStatus, WorkspaceTemplate, WorkspaceGroup, SerializedPaneNode, SerializedPaneLeaf, SerializedPaneSplit, AppSettings, ClaudeMetricsEntry, ClaudeAnalytics, AnthropicApiConfig } from '../shared/types';

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
  defaultShell: 'powershell.exe',
  scrollbackLimit: 10000,
  theme: 'dark',
  notifyOnIdle: false,
  notifyDelaySeconds: 5,
};

// Notification on command completion state
const paneIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
let windowIsFocused = true;

// Claude Code metrics state
const claudeMetrics = new Map<string, ClaudeMetricsEntry>();

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

function createPaneLeaf(workspaceId: string, paneIndex: number): PaneLeaf {
  const { terminal, fitAddon, searchAddon } = createTerminal();
  const container = document.createElement('div');
  container.className = 'pane-leaf';
  const paneId = `${workspaceId}:pane-${paneIndex}`;
  container.dataset.paneId = paneId;

  // Click to make active pane
  container.addEventListener('mousedown', () => {
    const tab = tabs.get(workspaceId);
    if (tab && tab.activePaneId !== paneId) {
      setActivePane(workspaceId, paneId);
    }
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

function setActivePane(workspaceId: string, paneId: string): void {
  const tab = tabs.get(workspaceId);
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

  // Find workspaceId from the first leaf if not passed
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

function rebuildPaneDOM(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  const wrapper = terminalContainer.querySelector(`.terminal-wrapper[data-id="${workspaceId}"]`);
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

async function splitPane(workspaceId: string, direction: 'horizontal' | 'vertical'): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  const activePane = getActivePane(tab);
  if (!activePane) return;

  tab.paneCounter++;
  const newLeaf = createPaneLeaf(workspaceId, tab.paneCounter);

  const splitNode: PaneSplit = {
    type: 'split',
    direction,
    children: [activePane, newLeaf],
    ratio: 0.5,
    container: document.createElement('div'),
  };

  // Replace the leaf in the tree with the split
  replacePaneInTree(tab, activePane, splitNode);

  rebuildPaneDOM(workspaceId);

  // Spawn PTY for new pane
  await spawnPaneTerminal(workspaceId, newLeaf);
  setActivePane(workspaceId, newLeaf.id);

  // Save layout after split
  savePaneLayout(workspaceId);
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

function deserializePaneTree(node: SerializedPaneNode, workspaceId: string, tab: TabState): PaneNode {
  if (node.type === 'leaf') {
    // Extract pane index from id like "wsid:pane-3"
    const match = node.id.match(/:pane-(\d+)$/);
    const paneIndex = match ? parseInt(match[1], 10) : tab.paneCounter++;
    if (paneIndex >= tab.paneCounter) tab.paneCounter = paneIndex + 1;
    return createPaneLeaf(workspaceId, paneIndex);
  }
  const splitNode = node as SerializedPaneSplit;
  const child0 = deserializePaneTree(splitNode.children[0], workspaceId, tab);
  const child1 = deserializePaneTree(splitNode.children[1], workspaceId, tab);
  return {
    type: 'split',
    direction: splitNode.direction,
    children: [child0, child1],
    ratio: splitNode.ratio,
    container: document.createElement('div'),
  };
}

function savePaneLayout(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
  if (!tab) return;
  const serialized = serializePaneTree(tab.paneRoot);
  api.app.savePaneLayout(workspaceId, serialized);
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

function closePaneById(workspaceId: string, paneId: string): void {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  const pane = findPaneById(tab.paneRoot, paneId);
  if (!pane || pane.type !== 'leaf') return;

  // If this is the only pane, close the tab instead
  if (tab.paneRoot === pane) {
    closeTab(workspaceId);
    return;
  }

  // Kill PTY for this pane
  api.pty.kill(pane.id);
  pane.terminal.dispose();

  // Find parent split and replace it with sibling
  const sibling = findSiblingAndRemove(tab, pane);
  if (sibling) {
    rebuildPaneDOM(workspaceId);
    // Set active to first leaf of sibling
    const leaves = findAllLeaves(sibling);
    if (leaves.length > 0) {
      setActivePane(workspaceId, leaves[0].id);
    }
    savePaneLayout(workspaceId);
  }
}

function findSiblingAndRemove(tab: TabState, target: PaneLeaf): PaneNode | null {
  return findSiblingInNode(tab, tab.paneRoot, target);
}

// Close the split in a given direction relative to the active pane.
// 'vertical' closes a down split, 'horizontal' closes a right split.
// Keeps the active pane, removes the sibling.
function closeSplitDirection(workspaceId: string, direction: 'horizontal' | 'vertical'): void {
  const tab = tabs.get(workspaceId);
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

  rebuildPaneDOM(workspaceId);

  // Ensure active pane is still set
  const survivorLeaves = findAllLeaves(survivor);
  if (survivorLeaves.length > 0 && !survivorLeaves.find(l => l.id === tab.activePaneId)) {
    setActivePane(workspaceId, survivorLeaves[0].id);
  }

  savePaneLayout(workspaceId);
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

async function spawnPaneTerminal(workspaceId: string, pane: PaneLeaf, startupDelayMs = 600): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

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

  if ('error' in result) {
    pane.terminal.writeln(`\r\n\x1b[31mFailed to start terminal: ${result.error}\x1b[0m`);
    pane.status = 'dead';
    return;
  }

  pane.pid = result.pid;
  pane.status = 'running';

  // Send startup command for main pane only (pane-0)
  if (pane.id.endsWith(':pane-0') && tab.workspace.startupCommand) {
    api.pty.writeCommand(pane.id, tab.workspace.startupCommand, startupDelayMs);
  }

  if (pane.resizeDisposable) pane.resizeDisposable.dispose();
  pane.resizeDisposable = pane.terminal.onResize(({ cols, rows }) => {
    api.pty.resize(pane.id, cols, rows);
  });
}

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
  const isOpen = tabs.has(ws.id);
  const isActive = ws.id === activeTabId;

  const item = document.createElement('div');
  item.className = `sidebar-item${isActive ? ' active' : ''}${!isOpen ? ' closed' : ''}`;
  item.dataset.id = ws.id;

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
  editBtn.innerHTML = '&#9998;'; // ✎ pencil
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModalForWorkspace(ws);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'sidebar-item-action danger';
  deleteBtn.title = 'Delete';
  deleteBtn.innerHTML = '&#128465;'; // 🗑 trash
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSidebarWorkspace(ws);
  });

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  item.appendChild(dot);
  item.appendChild(name);
  item.appendChild(actions);

  // Click to open or switch to workspace
  item.addEventListener('click', () => {
    openWorkspaceFromSidebar(ws);
  });

  return item;
}

function openWorkspaceFromSidebar(ws: Workspace): void {
  if (tabs.has(ws.id)) {
    // Already open — switch to it
    activateTab(ws.id);
  } else {
    // Open as new tab
    addWorkspaceTab(ws).then(() => {
      activateTab(ws.id);
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
  templateGroup.style.display = 'none';
  selectedColor = ws.color;
  initColorPicker();
  modalOverlay.classList.remove('hidden');
  wsNameInput.focus();
}

async function deleteSidebarWorkspace(ws: Workspace): Promise<void> {
  const confirmed = confirm(`Delete workspace "${ws.name}"? This removes it permanently.`);
  if (!confirmed) return;

  // Close tab if open
  if (tabs.has(ws.id)) {
    closeTab(ws.id);
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

function createTabElement(workspace: Workspace): HTMLDivElement {
  const tab = document.createElement('div');
  tab.className = `tab${workspace.pinned ? ' pinned' : ''}`;
  tab.dataset.id = workspace.id;

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
  name.textContent = workspace.name;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close workspace';

  tab.appendChild(dot);
  tab.appendChild(pinIcon);
  tab.appendChild(name);
  tab.appendChild(closeBtn);

  // Click to activate
  tab.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('tab-close')) return;
    activateTab(workspace.id);
  });

  // Close button (confirm for pinned tabs)
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (workspace.pinned) {
      if (!confirm(`"${workspace.name}" is pinned. Close anyway?`)) return;
    }
    closeTab(workspace.id);
  });

  // Right-click context menu
  tab.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, workspace.id);
  });

  // #6: Drag events
  tab.addEventListener('dragstart', (e) => {
    tab.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', workspace.id);
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
    if (draggedId === workspace.id) return;

    const draggedEl = tabList.querySelector(`.tab[data-id="${draggedId}"]`);
    if (draggedEl) {
      tab.parentElement!.insertBefore(draggedEl, tab);
      persistTabOrder();
    }
  });

  return tab;
}

function persistTabOrder(): void {
  const ids: string[] = [];
  tabList.querySelectorAll('.tab[data-id]').forEach(el => {
    const id = (el as HTMLElement).dataset.id;
    if (id) ids.push(id);
  });
  api.workspace.reorder(ids);
}

async function addWorkspaceTab(workspace: Workspace, autoSpawn = true, startupDelayMs = 600): Promise<void> {
  // Create wrapper container for this tab's panes
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = workspace.id;
  terminalContainer.appendChild(wrapper);

  const tabState: TabState = {
    workspace,
    paneRoot: null as any, // will be set below
    activePaneId: '',
    paneCounter: 0,
    hasUnread: false,
    unreadCount: 0,
    restartCount: 0,
    restartStabilityTimer: null,
  };

  tabs.set(workspace.id, tabState);

  // Try to restore saved pane layout
  let restoredLayout: SerializedPaneNode | null = null;
  try {
    restoredLayout = await api.app.loadPaneLayout(workspace.id);
  } catch {}

  let rootNode: PaneNode;
  if (restoredLayout && restoredLayout.type === 'split') {
    rootNode = deserializePaneTree(restoredLayout, workspace.id, tabState);
  } else {
    rootNode = createPaneLeaf(workspace.id, 0);
    tabState.paneCounter = 1;
  }

  tabState.paneRoot = rootNode;
  const allLeaves = findAllLeaves(rootNode);
  tabState.activePaneId = allLeaves[0]?.id || '';

  // Render pane tree
  renderPaneTree(rootNode, wrapper);

  // Open terminals and restore scrollback per-pane
  for (const leaf of allLeaves) {
    leaf.terminal.open(leaf.container);

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
      await spawnPaneTerminal(workspace.id, leaf, startupDelayMs);
    }
  }

  // Render tab bar (with groups)
  renderTabBar();
  updateEmptyState();
}

async function spawnTerminal(workspaceId: string): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  const pane = getActivePane(tab);
  if (!pane) return;

  await spawnPaneTerminal(workspaceId, pane);
  updateTabStatus(workspaceId);
}

function activateTab(workspaceId: string): void {
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
  activeTabId = workspaceId;
  const tab = tabs.get(workspaceId);
  if (tab) {
    const wrapper = terminalContainer.querySelector(`.terminal-wrapper[data-id="${workspaceId}"]`);
    wrapper?.classList.add('active');

    // #4: Clear unread badge
    tab.hasUnread = false;
    tab.unreadCount = 0;
    updateTabBadge(workspaceId);

    requestAnimationFrame(() => {
      findAllLeaves(tab.paneRoot).forEach(leaf => {
        try { leaf.fitAddon.fit(); } catch {}
      });
      const activePane = getActivePane(tab);
      if (activePane) activePane.terminal.focus();
    });
    updateStatusBar(tab);
  }

  const tabEl = tabList.querySelector(`.tab[data-id="${workspaceId}"]`);
  tabEl?.classList.add('active');

  api.app.setActiveTab(workspaceId);
  renderSidebar();
}

function closeTab(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
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
  const wrapper = terminalContainer.querySelector(`.terminal-wrapper[data-id="${workspaceId}"]`);
  wrapper?.remove();

  if (tab.restartStabilityTimer) clearTimeout(tab.restartStabilityTimer);
  tabs.delete(workspaceId);

  // If this was the active tab, switch to another
  if (activeTabId === workspaceId) {
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
  const tab = tabs.get(workspaceId);
  const ws = allWorkspaces.find(w => w.id === workspaceId);
  const name = tab?.workspace.name || ws?.name || workspaceId;

  const confirmed = confirm(`Delete workspace "${name}"? This removes it permanently.`);
  if (!confirmed) return;

  if (tabs.has(workspaceId)) {
    closeTab(workspaceId);
  }
  await api.workspace.delete(workspaceId);
  allWorkspaces = allWorkspaces.filter(w => w.id !== workspaceId);
  renderSidebar();
  updateEmptyState();
}

function updateTabStatus(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  // Determine overall tab status from panes
  const leaves = findAllLeaves(tab.paneRoot);
  const anyRunning = leaves.some(l => l.status === 'running');
  const anyStarting = leaves.some(l => l.status === 'starting');
  const allDead = leaves.every(l => l.status === 'dead');

  const overallStatus: TerminalStatus = anyRunning ? 'running' : anyStarting ? 'starting' : allDead ? 'dead' : 'idle';

  const dot = tabList.querySelector(`.tab[data-id="${workspaceId}"] .tab-dot`) as HTMLElement;
  if (dot) {
    dot.classList.toggle('alive', overallStatus === 'running');
  }

  if (activeTabId === workspaceId) {
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
function updateTabBadge(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
  const tabEl = tabList.querySelector(`.tab[data-id="${workspaceId}"]`);
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

// #3: Render tab bar with groups
function renderTabBar(): void {
  // Remember which tabs exist
  const allWorkspaces = Array.from(tabs.values()).map(t => t.workspace);

  // Clear tab list
  tabList.innerHTML = '';

  // Group workspaces
  const grouped = new Map<string, Workspace[]>();
  const ungrouped: Workspace[] = [];

  for (const ws of allWorkspaces) {
    if (ws.group) {
      if (!grouped.has(ws.group)) grouped.set(ws.group, []);
      grouped.get(ws.group)!.push(ws);
    } else {
      ungrouped.push(ws);
    }
  }

  // Sort pinned first within each group
  const sortPinnedFirst = (a: Workspace, b: Workspace) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  };

  // Render grouped tabs
  for (const [groupName, workspaces] of grouped) {
    workspaces.sort(sortPinnedFirst);
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

    for (const ws of workspaces) {
      const tabEl = createTabElement(ws);
      if (ws.id === activeTabId) tabEl.classList.add('active');
      tabContainer.appendChild(tabEl);
    }

    tabList.appendChild(tabContainer);
  }

  // Render ungrouped tabs (pinned first)
  ungrouped.sort(sortPinnedFirst);
  for (const ws of ungrouped) {
    const tabEl = createTabElement(ws);
    if (ws.id === activeTabId) tabEl.classList.add('active');
    tabList.appendChild(tabEl);
  }

  // Re-add badges
  for (const [id, tab] of tabs) {
    if (tab.hasUnread) updateTabBadge(id);
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

function showContextMenu(x: number, y: number, workspaceId: string): void {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const tabState = tabs.get(workspaceId);
  const isPinned = tabState?.workspace.pinned;

  const items = [
    { label: 'Edit Workspace', action: () => openEditModal(workspaceId) },
    { label: isPinned ? 'Unpin Tab' : 'Pin Tab', action: () => togglePin(workspaceId) },
    { label: 'Restart Terminal', shortcut: 'Ctrl+Shift+R', action: () => restartTerminal(workspaceId) },
    // #8: Save as template
    { label: 'Save as Template', action: () => saveAsTemplate(workspaceId) },
    { label: 'Duplicate Tab', action: () => duplicateTab(workspaceId) },
    { separator: true },
    // #2: Split pane options
    { label: 'Split Down', shortcut: 'Ctrl+Shift+D', action: () => splitPane(workspaceId, 'vertical') },
    { label: 'Split Right', shortcut: 'Ctrl+Shift+E', action: () => splitPane(workspaceId, 'horizontal') },
    { label: 'Close Split Down', action: () => closeSplitDirection(workspaceId, 'vertical') },
    { label: 'Close Split Right', action: () => closeSplitDirection(workspaceId, 'horizontal') },
    { separator: true },
    { label: 'Close Tab', shortcut: 'Ctrl+W', action: () => closeTab(workspaceId) },
    { label: 'Delete Workspace', action: () => deleteWorkspaceWithConfirm(workspaceId), danger: true },
  ];

  for (const item of items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
    } else {
      const el = document.createElement('div');
      el.className = `context-menu-item${(item as any).danger ? ' danger' : ''}`;

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

function saveAsTemplate(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
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
  wsTemplateSelect.value = '';
  templateGroup.style.display = '';
  selectedColor = WORKSPACE_COLORS[Math.floor(Math.random() * WORKSPACE_COLORS.length)];
  initColorPicker();
  loadTemplates();
  modalOverlay.classList.remove('hidden');
  wsNameInput.focus();
}

function openEditModal(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
  const ws = tab?.workspace || allWorkspaces.find(w => w.id === workspaceId);
  if (!ws) return;
  openEditModalForWorkspace(ws);
}

function closeModal(): void {
  modalOverlay.classList.add('hidden');
  editingWorkspaceId = null;
}

async function saveModal(): Promise<void> {
  const name = wsNameInput.value.trim();
  const cwd = wsCwdInput.value.trim();
  const startupCommand = wsCommandInput.value.trim();
  const autoStart = wsAutostartInput.checked;
  const autoRestart = wsAutorestartInput.checked;
  const maxRestarts = parseInt(wsMaxRestartsInput.value) || 3;
  const group = wsGroupInput.value.trim();

  if (!name || !cwd) {
    if (!name) wsNameInput.style.borderColor = '#F85149';
    if (!cwd) wsCwdInput.style.borderColor = '#F85149';
    return;
  }

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
    });

    if (updated) {
      // Update in open tab if present
      const tab = tabs.get(editingWorkspaceId);
      if (tab) {
        tab.workspace = updated;
        if (activeTabId === editingWorkspaceId) {
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
    });

    allWorkspaces.push(workspace);
    await addWorkspaceTab(workspace);
    activateTab(workspace.id);
  }

  closeModal();
  renderTabBar();
  renderSidebar();
}

async function restartTerminal(workspaceId: string): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  const pane = getActivePane(tab);
  if (!pane) return;

  // #9: Reset restart count on manual restart
  tab.restartCount = 0;
  if (tab.restartStabilityTimer) {
    clearTimeout(tab.restartStabilityTimer);
    tab.restartStabilityTimer = null;
  }

  api.pty.kill(pane.id);
  pane.terminal.clear();
  pane.terminal.writeln('\x1b[33mRestarting terminal...\x1b[0m\r\n');
  await spawnPaneTerminal(workspaceId, pane);
  updateTabStatus(workspaceId);
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
      const isOpen = tabs.has(ws.id);
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
        activateTab(result.workspace.id);
      } else {
        addWorkspaceTab(result.workspace).then(() => {
          activateTab(result.workspace.id);
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

async function togglePin(workspaceId: string): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;
  const newPinned = !tab.workspace.pinned;
  await api.workspace.update(workspaceId, { pinned: newPinned });
  tab.workspace.pinned = newPinned;
  renderTabBar();
}

// ============================================
// Duplicate Tab
// ============================================

async function duplicateTab(workspaceId: string): Promise<void> {
  const tab = tabs.get(workspaceId);
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
  await addWorkspaceTab(newWs);
  activateTab(newWs.id);
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
}

function closeDashboard(): void {
  dashboardOverlay.classList.add('hidden');
}

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

async function openSettings(): Promise<void> {
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

function trackPaneActivity(paneId: string, workspaceName: string): void {
  // Clear existing timer for this pane
  const existing = paneIdleTimers.get(paneId);
  if (existing) clearTimeout(existing);

  // Only track if notifications are enabled and window is blurred
  if (!currentSettings.notifyOnIdle || windowIsFocused) return;

  // Set a new idle timer
  const timer = setTimeout(() => {
    paneIdleTimers.delete(paneId);
    showIdleNotification(workspaceName);
  }, currentSettings.notifyDelaySeconds * 1000);
  paneIdleTimers.set(paneId, timer);
}

function showIdleNotification(workspaceName: string): void {
  if (windowIsFocused) return;
  try {
    new Notification('KiteTerm', {
      body: `Command completed in "${workspaceName}"`,
    });
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

        // #4: Unread badge — if this tab is not active
        if (tabId !== activeTabId) {
          tab.hasUnread = true;
          tab.unreadCount++;
          updateTabBadge(tabId);
        }

        // Notification on command completion: track activity
        trackPaneActivity(workspaceId, tab.workspace.name);
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
    if (tabs.has(workspaceId)) {
      activateTab(workspaceId);
    } else {
      // Workspace not open — find it in allWorkspaces and open it
      const ws = allWorkspaces.find(w => w.id === workspaceId);
      if (ws) {
        addWorkspaceTab(ws).then(() => {
          activateTab(workspaceId);
          renderSidebar();
        });
      }
    }
  });

  // Claude Code metrics updates
  api.claude.onMetricsUpdate((entry) => {
    claudeMetrics.set(entry.workspaceId, entry);
    // If this is the active tab, update display immediately
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab && tab.workspace.id === entry.workspaceId) {
        updateClaudeMetricsDisplay(entry);
      }
    }
  });

  // Analytics dashboard shortcut
  api.claude.onAnalyticsDashboard(() => {
    if (dashboardOverlay.classList.contains('hidden')) {
      openDashboard();
    } else {
      closeDashboard();
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
// Event Bindings
// ============================================

addTabBtn.addEventListener('click', openNewModal);
emptyAddBtn.addEventListener('click', openNewModal);
sidebarToggleBtn.addEventListener('click', toggleSidebar);
sidebarAddBtn.addEventListener('click', openNewModal);
sidebarFilter.addEventListener('input', () => renderSidebar());
modalCancel.addEventListener('click', closeModal);
modalSave.addEventListener('click', saveModal);

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
  for (let i = 0; i < autoStartWorkspaces.length; i++) {
    const ws = autoStartWorkspaces[i];
    const isClaudeWorkspace = ws.startupCommand?.includes('claude');

    if (!claudeAuthenticated && isClaudeWorkspace) {
      // Spawn terminal but clear startupCommand so shell opens without running claude
      const wsWithoutCmd = { ...ws, startupCommand: undefined };
      await addWorkspaceTab(wsWithoutCmd, true);
      const tab = tabs.get(ws.id);
      if (tab) {
        // Restore the original workspace reference (with startupCommand)
        tab.workspace = ws;
        const leaves = findAllLeaves(tab.paneRoot);
        for (const leaf of leaves) {
          leaf.terminal.writeln('\x1b[33m[KiteTerm] Claude CLI is not authenticated. Run "claude auth login" to sign in.\x1b[0m\r\n');
        }
      }
    } else {
      const startupDelay = 600 + (isClaudeWorkspace ? (claudeIdx++ * STARTUP_STAGGER_MS) : 0);
      await addWorkspaceTab(ws, true, startupDelay);
    }
  }

  // Activate the last active tab or the first open one
  const targetTab = config.activeTabId && tabs.has(config.activeTabId)
    ? config.activeTabId
    : autoStartWorkspaces[0]?.id;

  if (targetTab && tabs.has(targetTab)) {
    activateTab(targetTab);
  }

  updateEmptyState();
  renderSidebar();
}

// Start the app
init().catch(console.error);
