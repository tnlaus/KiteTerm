# KiteTerm

## What This Is

A desktop app (Electron) that manages multiple Claude Code terminal sessions across projects. Users define workspaces (name + folder + startup command), each opens as a tab with an embedded terminal. Config persists across reboots so users never manually cd into folders or re-open terminals.

## Tech Stack

- **Electron** (main + renderer processes)
- **TypeScript** for the renderer UI (vanilla DOM, no framework)
- **xterm.js** + **xterm-addon-fit** + **xterm-addon-web-links** + **xterm-addon-search** for terminal emulation
- **node-pty** for spawning real shell processes (uses ConPTY on Windows)
- **electron-store** for JSON config persistence
- **esbuild** for renderer bundling

## Target Platform

**Windows first.** Default shell is PowerShell. Package as `.exe` via electron-builder.

## Architecture

```
Main Process                    Renderer Process
┌─────────────┐    IPC          ┌──────────────┐
│ PTY Manager │ <──────────>    │ Vanilla TS   │
│ (node-pty)  │  stdin/stdout   │  ├ TabBar    │
│             │                 │  ├ Terminal  │ (xterm.js)
│ Store       │ <──────────>    │  ├ StatusBar │
│ (config)    │  workspace ops  │  └ Modals    │
│             │                 │              │
│ Tray        │                 │              │
│ Shortcuts   │                 │              │
└─────────────┘                 └──────────────┘
```

**IPC Channels:**
- `pty:spawn` — Create new PTY for workspace
- `pty:data` — Bidirectional terminal data stream
- `pty:resize` — Terminal resize events
- `pty:kill` — Kill a PTY process
- `workspace:*` — CRUD operations on workspace config
- `app:*` — Window state, tray operations, scrollback, export/import
- `template:*` — Workspace template CRUD

## Project Structure

```
src/
├── main/
│   ├── index.ts           # Electron app entry, window creation
│   ├── pty-manager.ts     # Spawns and manages node-pty processes (+ Shield hooks)
│   ├── ipc-handlers.ts    # All IPC channel handlers
│   ├── store.ts           # electron-store config wrapper + API key encryption
│   ├── tray.ts            # System tray icon + menu
│   ├── shortcuts.ts       # Global keyboard shortcuts
│   ├── claude-metrics.ts  # Statusline metrics watcher, auth check, analytics
│   ├── anthropic-api.ts   # Anthropic API client (org usage)
│   └── plugin-loader.ts   # Shield plugin discovery and lifecycle
├── renderer/
│   ├── index.html         # HTML shell
│   ├── index.ts           # All UI logic (vanilla TypeScript)
│   └── styles/
│       └── global.css     # Global styles + xterm overrides
├── preload/
│   └── index.ts           # Context bridge for secure IPC
└── shared/
    ├── types.ts           # Shared TypeScript interfaces
    └── plugin-types.ts    # Shield plugin interface contract
```

## Key Design Decisions

1. **Each tab = one or more PTY processes.** Switching tabs doesn't kill the PTY — it just detaches xterm from the data stream and reattaches when you switch back. Split panes give each pane its own PTY.
2. **Scrollback buffer is persisted** to `userData/scrollback/` on close and periodically (every 30s).
3. **Startup commands** are written to PTY stdin after a short delay (600ms) to let the shell initialize.
4. **Window state** (size, position, active tab) saved on every change via electron-store (debounced).
5. **Context isolation is ON** — all IPC goes through the preload bridge. No nodeIntegration in renderer.

## Build & Run

```bash
npm install
npm start          # Dev mode (build + run)
npm run build      # Production build
npm run make       # Package as .exe
```

**IMPORTANT:** Before running `npm start`, always kill any lingering Electron processes first:
```bash
taskkill //F //IM electron.exe 2>/dev/null; npm start
```
This prevents stale processes from locking files or ports. Do this every time you restart the app.

## Features

1. **Scrollback Persistence** — Terminal buffer saved/restored across sessions
2. **Split Panes** — Horizontal/vertical splits with resizable handles
3. **Workspace Groups** — Collapsible group headers in tab bar
4. **Unread Badges** — Blue dot on inactive tabs receiving output
5. **Quick Switcher** — Ctrl+P fuzzy search across workspaces
6. **Drag-Drop Tabs** — Reorder tabs by dragging
7. **Terminal Search** — Ctrl+F in-terminal search
8. **Workspace Templates** — Save/reuse workspace configurations
9. **Auto-Restart** — Configurable per-workspace crash recovery
10. **Export/Import Config** — JSON export/import from File menu

## Shield Plugin Architecture

KiteTerm supports a runtime-discovered plugin called **KiteTerm Shield** (paid, closed source). The free app works identically without it.

### Plugin System Files

```
src/shared/plugin-types.ts     # Plugin interface contract (ShieldPlugin, DataEvent, etc.)
src/main/plugin-loader.ts      # Discovery, loading, lifecycle management
SHIELD.md                      # Full Shield architecture specification
```

### How It Works

1. On startup, `plugin-loader.ts` checks for Shield in 3 locations + Windows registry
2. If found, loads it via `require()`, calls `initialize()` with a `PluginContext`
3. Two interception hooks in `pty-manager.ts` call Shield's `interceptInput()` / `interceptOutput()` on every data event
4. Shield returns `{ data }` to pass through, or `{ data: null }` to block
5. Shield emits detection events to the renderer via `PluginContext.emitDetection()`

### Interception Points

Both hooks are in `src/main/pty-manager.ts` (main process, full Node.js access):

- **Input hook** — `writeToPty()` calls `shield.interceptInput()` before `process.write(data)`
- **Output hook** — `ptyProcess.onData()` calls `shield.interceptOutput()` before sending to renderer

### IPC Channels (Shield <-> Renderer)

- `shield:status` — Shield enabled/disabled + detection count
- `shield:detection` — Real-time detection event for toast/status bar

### Important

- The free codebase never imports Shield code directly — only the interface types
- Shield runs in the main process, not the renderer (full Node.js access for file I/O, crypto)
- If Shield is not installed, the interception hooks are skipped (zero overhead)
- See `SHIELD.md` for the full architecture spec including detection patterns, policy engine, and audit logging

## Conventions

- Use TypeScript strict mode
- Vanilla TypeScript for renderer (no framework)
- IPC channel names are namespaced: `pty:*`, `workspace:*`, `app:*`, `template:*`, `shield:*`
- Colors use CSS custom properties defined in global.css
- All user-facing strings are in components (no i18n yet)
