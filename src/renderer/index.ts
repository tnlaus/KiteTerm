import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Workspace, WORKSPACE_COLORS, TerminalStatus, WorkspaceTemplate, WorkspaceGroup } from '../shared/types';

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

// ============================================
// Terminal Factory
// ============================================

const TERMINAL_THEME = {
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

function createTerminal(): { terminal: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
  const terminal = new Terminal({
    fontFamily: "'Cascadia Code', 'Consolas', 'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 14,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    theme: TERMINAL_THEME,
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

function renderPaneTree(node: PaneNode, parentEl: HTMLElement): void {
  if (node.type === 'leaf') {
    parentEl.appendChild(node.container);
    return;
  }

  node.container = document.createElement('div');
  node.container.className = `pane-split ${node.direction}`;

  const child0Wrapper = document.createElement('div');
  child0Wrapper.style.flex = `${node.ratio}`;
  child0Wrapper.style.minWidth = '0';
  child0Wrapper.style.minHeight = '0';
  child0Wrapper.style.display = 'flex';
  renderPaneTree(node.children[0], child0Wrapper);
  node.container.appendChild(child0Wrapper);

  // Resize handle
  const handle = document.createElement('div');
  handle.className = `pane-resize-handle ${node.direction}`;
  setupResizeHandle(handle, node, child0Wrapper);
  node.container.appendChild(handle);

  const child1Wrapper = document.createElement('div');
  child1Wrapper.style.flex = `${1 - node.ratio}`;
  child1Wrapper.style.minWidth = '0';
  child1Wrapper.style.minHeight = '0';
  child1Wrapper.style.display = 'flex';
  renderPaneTree(node.children[1], child1Wrapper);
  node.container.appendChild(child1Wrapper);

  parentEl.appendChild(node.container);
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

  // Open and fit all terminals
  requestAnimationFrame(() => {
    findAllLeaves(tab.paneRoot).forEach(leaf => {
      if (!leaf.terminal.element) {
        leaf.terminal.open(leaf.container);
      }
      try { leaf.fitAddon.fit(); } catch {}
    });
  });
}

const MAX_PANES_PER_TAB = 4;
const splitInProgress = new Set<string>();

async function splitPane(workspaceId: string, direction: 'horizontal' | 'vertical'): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  // Prevent concurrent splits from bypassing the limit
  if (splitInProgress.has(workspaceId)) return;

  // Limit splits to prevent runaway pane creation
  if (findAllLeaves(tab.paneRoot).length >= MAX_PANES_PER_TAB) return;

  splitInProgress.add(workspaceId);

  try {
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
  } finally {
    splitInProgress.delete(workspaceId);
  }
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

async function spawnPaneTerminal(workspaceId: string, pane: PaneLeaf): Promise<void> {
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
    api.pty.writeCommand(pane.id, tab.workspace.startupCommand, 600);
  }

  if (pane.resizeDisposable) pane.resizeDisposable.dispose();
  pane.resizeDisposable = pane.terminal.onResize(({ cols, rows }) => {
    api.pty.resize(pane.id, cols, rows);
  });
}

// ============================================
// Tab Management
// ============================================

function createTabElement(workspace: Workspace): HTMLDivElement {
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = workspace.id;

  // #6: Drag-and-drop
  tab.draggable = true;

  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  dot.style.color = workspace.color;
  dot.style.background = workspace.color;

  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = workspace.name;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close workspace';

  tab.appendChild(dot);
  tab.appendChild(name);
  tab.appendChild(closeBtn);

  // Click to activate
  tab.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('tab-close')) return;
    activateTab(workspace.id);
  });

  // Close button
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
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

async function addWorkspaceTab(workspace: Workspace, autoSpawn = true): Promise<void> {
  const paneLeaf = createPaneLeaf(workspace.id, 0);

  // Create wrapper container for this tab's panes
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = workspace.id;
  terminalContainer.appendChild(wrapper);

  const tabState: TabState = {
    workspace,
    paneRoot: paneLeaf,
    activePaneId: paneLeaf.id,
    paneCounter: 0,
    hasUnread: false,
    unreadCount: 0,
    restartCount: 0,
    restartStabilityTimer: null,
  };

  tabs.set(workspace.id, tabState);

  // Render pane tree (just the single leaf initially)
  renderPaneTree(paneLeaf, wrapper);

  // Open terminal in pane container
  paneLeaf.terminal.open(paneLeaf.container);
  paneLeaf.container.classList.add('active-pane');

  // Fit terminal
  requestAnimationFrame(() => {
    paneLeaf.fitAddon.fit();
  });

  // #1: Restore scrollback
  try {
    const scrollback = await api.app.loadScrollback(workspace.id);
    if (scrollback) {
      paneLeaf.terminal.write(scrollback);
      paneLeaf.terminal.writeln('\r\n\x1b[90m--- Previous session restored ---\x1b[0m\r\n');
    }
  } catch {}

  // Spawn PTY
  if (autoSpawn) {
    await spawnPaneTerminal(workspace.id, paneLeaf);
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
}

function closeTab(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  // #1: Save scrollback before closing
  saveScrollbackForTab(tab);

  // Kill all PTYs for this tab's panes
  findAllLeaves(tab.paneRoot).forEach(leaf => {
    api.pty.kill(leaf.id);
    leaf.terminal.dispose();
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
}

async function deleteWorkspaceWithConfirm(workspaceId: string): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  const confirmed = confirm(`Delete workspace "${tab.workspace.name}"? This removes it permanently.`);
  if (!confirmed) return;

  closeTab(workspaceId);
  await api.workspace.delete(workspaceId);
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
}

function updateEmptyState(): void {
  emptyState.classList.toggle('hidden', tabs.size > 0);
  terminalContainer.style.display = tabs.size > 0 ? '' : 'none';
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

  // Render grouped tabs
  for (const [groupName, workspaces] of grouped) {
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

  // Render ungrouped tabs
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
  const mainPane = findPaneById(tab.paneRoot, `${tab.workspace.id}:pane-0`);
  if (mainPane && mainPane.type === 'leaf') {
    const content = serializeTerminalBuffer(mainPane.terminal);
    if (content.length > 0) {
      api.app.saveScrollback(tab.workspace.id, content);
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

  const items = [
    { label: 'Edit Workspace', action: () => openEditModal(workspaceId) },
    { label: 'Restart Terminal', shortcut: 'Ctrl+Shift+R', action: () => restartTerminal(workspaceId) },
    // #8: Save as template
    { label: 'Save as Template', action: () => saveAsTemplate(workspaceId) },
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
  if (!tab) return;

  editingWorkspaceId = workspaceId;
  modalTitle.textContent = 'Edit Workspace';
  wsNameInput.value = tab.workspace.name;
  wsCwdInput.value = tab.workspace.cwd;
  wsCommandInput.value = tab.workspace.startupCommand || '';
  wsAutostartInput.checked = tab.workspace.autoStart;
  wsAutorestartInput.checked = tab.workspace.autoRestart || false;
  wsMaxRestartsInput.value = String(tab.workspace.maxRestarts || 3);
  maxRestartsGroup.style.display = tab.workspace.autoRestart ? '' : 'none';
  wsGroupInput.value = tab.workspace.group || '';
  templateGroup.style.display = 'none'; // Hide template picker when editing
  selectedColor = tab.workspace.color;
  initColorPicker();
  modalOverlay.classList.remove('hidden');
  wsNameInput.focus();
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
      const tab = tabs.get(editingWorkspaceId);
      if (tab) {
        tab.workspace = updated;
        if (activeTabId === editingWorkspaceId) {
          updateStatusBar(tab);
        }
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

    await addWorkspaceTab(workspace);
    activateTab(workspace.id);
  }

  closeModal();
  renderTabBar();
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
  const allTabs = Array.from(tabs.values());
  const results = allTabs
    .map(tab => {
      const nameMatch = fuzzyMatch(query, tab.workspace.name);
      const cwdMatch = fuzzyMatch(query, tab.workspace.cwd);
      const bestScore = Math.max(nameMatch.score, cwdMatch.score);
      const isMatch = nameMatch.match || cwdMatch.match;
      return { tab, score: bestScore, match: isMatch };
    })
    .filter(r => r.match)
    .sort((a, b) => b.score - a.score);

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
    dot.style.background = result.tab.workspace.color;

    const name = document.createElement('span');
    name.className = 'qs-item-name';
    name.textContent = result.tab.workspace.name;

    const cwd = document.createElement('span');
    cwd.className = 'qs-item-cwd';
    cwd.textContent = result.tab.workspace.cwd;

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(cwd);

    item.addEventListener('click', () => {
      activateTab(result.tab.workspace.id);
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
  api.shortcuts.onCloseTab(() => { if (activeTabId) closeTab(activeTabId); });
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

  // Tray workspace activation
  api.tray.onActivateWorkspace((workspaceId) => {
    if (tabs.has(workspaceId)) {
      activateTab(workspaceId);
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

  // Load saved workspaces
  const config = await api.app.getConfig();
  const workspaces: Workspace[] = config.workspaces || [];

  // #3: Load group states
  const groups: WorkspaceGroup[] = config.groups || [];
  for (const g of groups) {
    groupStates.set(g.name, g.collapsed);
  }

  // #8: Load templates
  templates = config.templates || [];

  if (workspaces.length === 0) {
    updateEmptyState();
    return;
  }

  // Create tabs for all workspaces
  for (const ws of workspaces) {
    await addWorkspaceTab(ws, ws.autoStart);
  }

  // Activate the last active tab or the first one
  const targetTab = config.activeTabId && tabs.has(config.activeTabId)
    ? config.activeTabId
    : workspaces[0]?.id;

  if (targetTab) {
    activateTab(targetTab);
  }

  updateEmptyState();
}

// Start the app
init().catch(console.error);
