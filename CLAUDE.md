# Claude Terminal Manager

## What This Is

A desktop app (Electron) that manages multiple Claude Code terminal sessions across projects. Users define workspaces (name + folder + startup command), each opens as a tab with an embedded terminal. Config persists across reboots so users never manually cd into folders or re-open terminals.

## Tech Stack

- **Electron** (main + renderer processes)
- **React 18** + **TypeScript** for the renderer UI
- **xterm.js** + **xterm-addon-fit** + **xterm-addon-web-links** for terminal emulation
- **node-pty** for spawning real shell processes (uses ConPTY on Windows)
- **electron-store** for JSON config persistence
- **Tailwind CSS** via CDN for styling
- **electron-forge** for building and packaging

## Target Platform

**Windows first.** Default shell is PowerShell. Package as `.exe` via electron-forge/squirrel.

## Architecture

```
Main Process                    Renderer Process
┌─────────────┐    IPC          ┌──────────────┐
│ PTY Manager │ ←──────────→    │ React App    │
│ (node-pty)  │  stdin/stdout   │  ├ TabBar    │
│             │                 │  ├ Terminal  │ (xterm.js)
│ Store       │ ←──────────→    │  ├ StatusBar │
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
- `app:*` — Window state, tray operations

## Project Structure

```
src/
├── main/
│   ├── index.ts           # Electron app entry, window creation
│   ├── pty-manager.ts     # Spawns and manages node-pty processes
│   ├── ipc-handlers.ts    # All IPC channel handlers
│   ├── store.ts           # electron-store config wrapper
│   ├── tray.ts            # System tray icon + menu
│   └── shortcuts.ts       # Global keyboard shortcuts
├── renderer/
│   ├── index.html         # HTML shell
│   ├── index.tsx          # React entry point
│   ├── App.tsx            # Root component, state management
│   ├── components/
│   │   ├── TabBar.tsx     # Workspace tab strip
│   │   ├── Terminal.tsx   # xterm.js terminal wrapper
│   │   ├── StatusBar.tsx  # Bottom status bar
│   │   └── WorkspaceModal.tsx  # Add/edit workspace dialog
│   ├── hooks/
│   │   └── useTerminal.ts # Terminal lifecycle management
│   └── styles/
│       └── global.css     # Global styles + xterm overrides
├── preload/
│   └── index.ts           # Context bridge for secure IPC
└── shared/
    └── types.ts           # Shared TypeScript interfaces
```

## Key Design Decisions

1. **Each tab = one PTY process.** Switching tabs doesn't kill the PTY — it just detaches xterm from the data stream and reattaches when you switch back.
2. **Scrollback buffer is kept in memory** per terminal instance. Not persisted to disk in v1.
3. **Startup commands** are written to PTY stdin after a short delay (500ms) to let the shell initialize.
4. **Window state** (size, position, active tab) saved on every change via electron-store.
5. **Context isolation is ON** — all IPC goes through the preload bridge. No nodeIntegration in renderer.

## Build & Run

```bash
npm install
npm start          # Dev mode with hot reload
npm run build      # Production build
npm run make       # Package as .exe
```

## Current Status

Scaffolded. All core files in place with implementations. Ready for iteration.

## What Needs Work (Priority Order)

1. **Test the PTY ↔ xterm bridge** — This is the critical path. Make sure terminal input/output works.
2. **Workspace modal** — The add/edit dialog needs the native folder picker wired up.
3. **Tab drag-and-drop reordering** — Not implemented yet.
4. **Tray icon** — Needs a real .ico asset (currently uses a placeholder).
5. **Theme** — Dark theme is in place. Light theme toggle is a nice-to-have.
6. **Split panes** — v2 feature. Not scaffolded.
7. **Auto-updater** — Not implemented. Add when ready to distribute.

## Conventions

- Use TypeScript strict mode
- Functional React components with hooks only
- IPC channel names are namespaced: `pty:*`, `workspace:*`, `app:*`
- Colors use CSS custom properties defined in global.css
- All user-facing strings are in components (no i18n yet)
