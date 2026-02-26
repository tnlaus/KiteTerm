<div align="center">

# KiteTerm

**Multi-session workspace manager for Claude Code power users**

[![License: MIT](https://img.shields.io/badge/License-MIT-58A6FF.svg?style=flat-square)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg?style=flat-square&logo=windows)](https://github.com/tnlaus/KiteTerm/releases)
[![Built with Electron](https://img.shields.io/badge/Built_with-Electron-47848F.svg?style=flat-square&logo=electron)](https://www.electronjs.org/)
[![Claude Code](https://img.shields.io/badge/Made_for-Claude_Code-D4A574.svg?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)

Stop juggling terminal windows. Define your workspaces once, and every Claude Code session opens in the right folder, every time — even after a reboot.

[**Download Latest Release**](https://github.com/tnlaus/KiteTerm/releases)

---

<!--
  SCREENSHOT PLACEHOLDER
  Replace with actual screenshots once the app is running.
-->

<img src="docs/screenshot-hero.png" alt="KiteTerm" width="800">

*Tabbed terminal sessions with persistent workspaces, split panes, and keyboard shortcuts.*

</div>

---

## The Problem

If you're running multiple Claude Code instances across different projects, you know the drill:

1. Open a terminal, `cd ~/projects/t365`, `claude`
2. Open another terminal, `cd ~/projects/client-portal`, `claude`
3. Open another terminal, `cd ~/projects/infrastructure`, `claude`
4. Repeat after every reboot, every morning, every time Windows Updates decides to restart at 3am.

## The Solution

KiteTerm lets you define **workspaces** — a name, a folder, and an optional startup command. Each workspace gets a tab with a full terminal. Close the app, reboot, come back — everything reopens exactly where you left it.

### Features

- **Tabbed workspaces** — Each project gets its own terminal tab with a color-coded indicator
- **Split panes** — Split any tab horizontally or vertically for side-by-side terminals
- **Persistent config** — Workspaces survive reboots. Open the app and you're back to work
- **Scrollback persistence** — Terminal output is saved and restored across sessions
- **Auto-start commands** — Automatically run `claude` (or any command) when a tab opens
- **Auto-restart** — Optionally restart crashed terminals automatically
- **Workspace groups** — Organize workspaces into collapsible groups
- **Workspace templates** — Save and reuse workspace configurations
- **Quick switcher** — `Ctrl+P` to fuzzy-search and jump between workspaces
- **Terminal search** — `Ctrl+F` to search terminal output
- **Drag-drop tabs** — Reorder tabs by dragging
- **Unread badges** — Blue dot on tabs that received output while inactive
- **System tray** — Minimize to tray, quick-switch between workspaces from the tray menu
- **Export/import** — Share workspace configs between machines
- **Keyboard shortcuts** — Full keyboard-driven workflow
- **Polished UI** — Dark theme, status bar, context menus, folder picker

## Quick Start

### Download

Grab the latest `.exe` from [**Releases**](https://github.com/tnlaus/KiteTerm/releases).

### Or build from source

```bash
git clone https://github.com/tnlaus/KiteTerm.git
cd KiteTerm
npm install
npx electron-rebuild
npm start
```

> **Requirements:** Node.js 18+, npm, Windows 10/11. Native compilation of `node-pty` requires the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload).

## Usage

1. **Create a workspace** — Click `+` or press `Ctrl+T`
2. **Pick a folder** — Browse to your project directory
3. **Set a startup command** — `claude` is the default, but you can use anything
4. **Work** — Switch between tabs with `Ctrl+1-9` or `Ctrl+Tab`
5. **Close the app** — It minimizes to the system tray. Your terminals keep running.
6. **Reboot** — Reopen the app. All workspaces restore. Run `claude /resume` to pick up conversations.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New workspace |
| `Ctrl+W` | Close current tab |
| `Ctrl+1` – `Ctrl+9` | Switch to tab by number |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+P` | Quick switcher |
| `Ctrl+F` | Search terminal output |
| `Ctrl+Shift+R` | Restart current terminal |
| `Ctrl+Shift+D` | Split pane down |
| `Ctrl+Shift+E` | Split pane right |
| `Ctrl+Shift+W` | Close current pane |
| `Ctrl+Shift+T` | Toggle window visibility (global) |
| `Ctrl+Q` | Quit |

## How It Works

Each workspace spawns a real PowerShell process via [node-pty](https://github.com/microsoft/node-pty) (the same library VS Code uses). Terminal rendering is handled by [xterm.js](https://xtermjs.org/). Workspace configs are stored as JSON via [electron-store](https://github.com/sindresorhus/electron-store) — no database, no cloud, everything stays on your machine.

```
┌─────────────────────────────────────────────┐
│  Electron Main Process                      │
│  ┌──────────┐  ┌─────┐  ┌───────────────┐  │
│  │ PTY Mgr  │──│ IPC │──│  Renderer     │  │
│  │ (node-pty)│  │     │  │  (xterm.js)   │  │
│  └──────────┘  └─────┘  └───────────────┘  │
│  ┌──────────┐  ┌──────────┐                 │
│  │  Store   │  │  Tray    │                 │
│  │  (JSON)  │  │  Menu    │                 │
│  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────┘
```

## FAQ

**Can I restore a Claude Code conversation after a reboot?**
The terminal session itself can't survive a reboot (that's an OS limitation). But Claude Code has built-in session resume — just run `claude /resume` in the restored terminal and it picks up your last conversation.

**Does this work on macOS/Linux?**
The codebase is cross-platform (Electron + node-pty work everywhere), but we currently only build and test on Windows. macOS/Linux support is on the roadmap — PRs welcome.

**Is my data sent anywhere?**
No. Everything runs locally. Workspace configs are stored in `%APPDATA%/kiteterm-config/`. No telemetry, no analytics, no network calls.

**Why not just use Windows Terminal?**
Windows Terminal is great, but it doesn't have the concept of persistent named workspaces with auto-start commands. You can't define "open PowerShell in this folder and run `claude`" as a reusable, restorable workspace. That's the gap this fills.

## Roadmap

- [ ] Detect Claude Code exit and show "Resume" button
- [ ] Settings panel (font size, default shell, theme)
- [ ] Auto-updater
- [ ] macOS and Linux builds
- [ ] Session sharing / collaboration

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Whether it's a bug fix, feature, docs improvement, or just a typo — all contributions are appreciated.

## License

[MIT](LICENSE) — Use it, fork it, modify it, ship it. No restrictions.

---

<div align="center">

Built by **[TNL IT](https://tnlit.com.au)**

</div>
