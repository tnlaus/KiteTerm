import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Workspace, WORKSPACE_COLORS, TerminalStatus } from '../shared/types';

// Type-safe access to the preload API
const api = window.api;

// ============================================
// State
// ============================================

interface TabState {
  workspace: Workspace;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  status: TerminalStatus;
  pid: number | null;
  resizeDisposable: { dispose: () => void } | null;
}

const tabs = new Map<string, TabState>();
let activeTabId: string | null = null;
let editingWorkspaceId: string | null = null; // null = creating new

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

let selectedColor = WORKSPACE_COLORS[0];

// ============================================
// Terminal Factory
// ============================================

function createTerminal(): { terminal: Terminal; fitAddon: FitAddon } {
  const terminal = new Terminal({
    fontFamily: "'Cascadia Code', 'Consolas', 'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 14,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    theme: {
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
    },
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  return { terminal, fitAddon };
}

// ============================================
// Tab Management
// ============================================

function createTabElement(workspace: Workspace): HTMLDivElement {
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = workspace.id;

  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  dot.style.color = workspace.color;
  dot.style.background = workspace.color;

  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = workspace.name;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
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

  return tab;
}

async function addWorkspaceTab(workspace: Workspace, autoSpawn = true): Promise<void> {
  const { terminal, fitAddon } = createTerminal();

  // Create container for this terminal
  const container = document.createElement('div');
  container.className = 'terminal-wrapper';
  container.dataset.id = workspace.id;
  terminalContainer.appendChild(container);

  const tabState: TabState = {
    workspace,
    terminal,
    fitAddon,
    container,
    status: 'idle',
    pid: null,
    resizeDisposable: null,
  };

  tabs.set(workspace.id, tabState);

  // Add tab to tab bar
  const tabEl = createTabElement(workspace);
  tabList.appendChild(tabEl);

  // Open terminal in container
  terminal.open(container);

  // Wire up input → PTY
  terminal.onData((data) => {
    api.pty.write(workspace.id, data);
  });

  // Fit terminal to container
  requestAnimationFrame(() => {
    fitAddon.fit();
  });

  // Spawn PTY
  if (autoSpawn) {
    await spawnTerminal(workspace.id);
  }

  updateEmptyState();
}

async function spawnTerminal(workspaceId: string): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  updateTabStatus(workspaceId, 'starting');

  const result = await api.pty.spawn({
    workspaceId,
    cwd: tab.workspace.cwd,
    shell: tab.workspace.shell,
    env: tab.workspace.env,
    cols: tab.terminal.cols,
    rows: tab.terminal.rows,
  });

  if ('error' in result) {
    tab.terminal.writeln(`\r\n\x1b[31mFailed to start terminal: ${result.error}\x1b[0m`);
    updateTabStatus(workspaceId, 'dead');
    return;
  }

  tab.pid = result.pid;
  updateTabStatus(workspaceId, 'running');

  // Send startup command if configured
  if (tab.workspace.startupCommand) {
    api.pty.writeCommand(workspaceId, tab.workspace.startupCommand, 600);
  }

  // Dispose previous resize listener if any (prevents leak on restart)
  if (tab.resizeDisposable) {
    tab.resizeDisposable.dispose();
  }

  // Wire up resize
  tab.resizeDisposable = tab.terminal.onResize(({ cols, rows }) => {
    api.pty.resize(workspaceId, cols, rows);
  });
}

function activateTab(workspaceId: string): void {
  // Deactivate current
  if (activeTabId) {
    const prev = tabs.get(activeTabId);
    if (prev) {
      prev.container.classList.remove('active');
    }
    const prevTab = tabList.querySelector(`.tab[data-id="${activeTabId}"]`);
    prevTab?.classList.remove('active');
  }

  // Activate new
  activeTabId = workspaceId;
  const tab = tabs.get(workspaceId);
  if (tab) {
    tab.container.classList.add('active');
    requestAnimationFrame(() => {
      tab.fitAddon.fit();
      tab.terminal.focus();
    });
    updateStatusBar(tab);
  }

  const tabEl = tabList.querySelector(`.tab[data-id="${workspaceId}"]`);
  tabEl?.classList.add('active');

  // Persist active tab
  api.app.setActiveTab(workspaceId);
}

function closeTab(workspaceId: string): void {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  // Kill PTY
  api.pty.kill(workspaceId);

  // Dispose terminal
  tab.terminal.dispose();

  // Remove DOM elements
  tab.container.remove();
  const tabEl = tabList.querySelector(`.tab[data-id="${workspaceId}"]`);
  tabEl?.remove();

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

  updateEmptyState();
}

function updateTabStatus(workspaceId: string, status: TerminalStatus): void {
  const tab = tabs.get(workspaceId);
  if (!tab) return;
  tab.status = status;

  const dot = tabList.querySelector(`.tab[data-id="${workspaceId}"] .tab-dot`) as HTMLElement;
  if (dot) {
    dot.classList.toggle('alive', status === 'running');
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

  statusDot.className = tab.status === 'running' ? 'alive' : tab.status === 'dead' ? 'dead' : tab.status === 'starting' ? 'starting' : '';

  const statusLabels: Record<TerminalStatus, string> = {
    idle: 'Idle',
    running: 'Running',
    dead: 'Exited',
    starting: 'Starting...',
  };
  statusText.textContent = statusLabels[tab.status];
  statusCwd.textContent = tab.workspace.cwd;
  statusShell.textContent = tab.workspace.shell || 'powershell.exe';
}

function updateEmptyState(): void {
  emptyState.classList.toggle('hidden', tabs.size > 0);
  terminalContainer.style.display = tabs.size > 0 ? '' : 'none';
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
    { separator: true },
    { label: 'Close', shortcut: 'Ctrl+W', action: () => closeTab(workspaceId), danger: true },
  ];

  for (const item of items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
    } else {
      const el = document.createElement('div');
      el.className = `context-menu-item${item.danger ? ' danger' : ''}`;

      const label = document.createElement('span');
      label.textContent = item.label;
      el.appendChild(label);

      if (item.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'context-menu-shortcut';
        shortcut.textContent = item.shortcut;
        el.appendChild(shortcut);
      }

      el.addEventListener('click', () => {
        closeContextMenu();
        item.action();
      });

      menu.appendChild(el);
    }
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Close on click outside
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
  selectedColor = WORKSPACE_COLORS[Math.floor(Math.random() * WORKSPACE_COLORS.length)];
  initColorPicker();
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

  if (!name || !cwd) {
    // Highlight empty fields
    if (!name) wsNameInput.style.borderColor = '#F85149';
    if (!cwd) wsCwdInput.style.borderColor = '#F85149';
    return;
  }

  if (editingWorkspaceId) {
    // Update existing
    const updated = await api.workspace.update(editingWorkspaceId, {
      name,
      cwd,
      startupCommand: startupCommand || undefined,
      autoStart,
      color: selectedColor,
    });

    if (updated) {
      const tab = tabs.get(editingWorkspaceId);
      if (tab) {
        tab.workspace = updated;
        const tabEl = tabList.querySelector(`.tab[data-id="${editingWorkspaceId}"]`);
        if (tabEl) {
          const nameEl = tabEl.querySelector('.tab-name') as HTMLElement;
          const dotEl = tabEl.querySelector('.tab-dot') as HTMLElement;
          if (nameEl) nameEl.textContent = name;
          if (dotEl) {
            dotEl.style.color = selectedColor;
            dotEl.style.background = selectedColor;
          }
        }
        if (activeTabId === editingWorkspaceId) {
          updateStatusBar(tab);
        }
      }
    }
  } else {
    // Create new workspace
    const workspace = await api.workspace.create({
      name,
      cwd,
      startupCommand: startupCommand || undefined,
      autoStart,
      color: selectedColor,
    });

    await addWorkspaceTab(workspace);
    activateTab(workspace.id);
  }

  closeModal();
}

async function restartTerminal(workspaceId: string): Promise<void> {
  const tab = tabs.get(workspaceId);
  if (!tab) return;

  api.pty.kill(workspaceId);
  tab.terminal.clear();
  tab.terminal.writeln('\x1b[33mRestarting terminal...\x1b[0m\r\n');
  await spawnTerminal(workspaceId);
}

// ============================================
// IPC Listeners
// ============================================

function setupIpcListeners(): void {
  // PTY data → terminal
  api.pty.onData(({ workspaceId, data }) => {
    const tab = tabs.get(workspaceId);
    if (tab) {
      tab.terminal.write(data);
    }
  });

  // PTY exit
  api.pty.onExit(({ workspaceId, exitCode }) => {
    const tab = tabs.get(workspaceId);
    if (tab) {
      updateTabStatus(workspaceId, 'dead');
      tab.terminal.writeln(`\r\n\x1b[33mProcess exited with code ${exitCode}. Press Enter to restart.\x1b[0m`);

      // Allow pressing Enter to restart
      const disposable = tab.terminal.onKey(({ key }) => {
        if (key === '\r') {
          disposable.dispose();
          restartTerminal(workspaceId);
        }
      });
    }
  });

  // Shortcuts from main process
  api.shortcuts.onNewWorkspace(() => openNewModal());
  api.shortcuts.onCloseTab(() => { if (activeTabId) closeTab(activeTabId); });
  api.shortcuts.onNextTab(() => cycleTab(1));
  api.shortcuts.onPrevTab(() => cycleTab(-1));
  api.shortcuts.onGoToTab((index) => goToTabByIndex(index));
  api.shortcuts.onRestartTerminal(() => { if (activeTabId) restartTerminal(activeTabId); });

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
      tab.fitAddon.fit();
    }
  }
}

let resizeTimeout: number;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = window.setTimeout(handleResize, 100) as unknown as number;
});

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

// Modal keyboard handling
modalOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && !e.shiftKey) saveModal();
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
