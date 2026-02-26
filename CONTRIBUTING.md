# Contributing to Claude Terminal Manager

Thanks for your interest in contributing! This project is maintained by [TNL IT](https://tnlit.com.au) and we welcome contributions from the community.

## Getting Started

### Prerequisites

- **Node.js 18+** and npm
- **Windows 10/11** (primary platform — macOS/Linux contributions welcome)
- **Visual Studio Build Tools** with the C++ workload (required for `node-pty` native compilation)
- **Git**

### Setup

```bash
git clone https://github.com/tnl-it/claude-terminal-manager.git
cd claude-terminal-manager
npm install
npx electron-rebuild
npm start
```

If `node-pty` fails to compile, make sure you have the C++ build tools installed:
```bash
npm install -g windows-build-tools
```

### Project Structure

```
src/
├── main/           # Electron main process (Node.js)
│   ├── index.ts        # App entry, window lifecycle
│   ├── pty-manager.ts  # Terminal process spawning
│   ├── ipc-handlers.ts # IPC message routing
│   ├── store.ts        # Config persistence
│   ├── tray.ts         # System tray
│   └── shortcuts.ts    # Keyboard shortcuts
├── renderer/       # UI (runs in browser context)
│   ├── index.html      # HTML shell
│   ├── index.ts        # All UI logic
│   └── styles/         # CSS
├── preload/        # Secure bridge between main ↔ renderer
│   └── index.ts        # Context bridge API
└── shared/         # Shared types and constants
    └── types.ts
```

Read `CLAUDE.md` for detailed architecture documentation.

## How to Contribute

### Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Windows version and Node.js version
- Terminal output or screenshots if relevant

### Suggesting Features

Open an issue with the `enhancement` label. Describe the use case — *why* you want this feature, not just *what*. The best feature requests explain the problem they're solving.

Check the [Roadmap](README.md#roadmap) first to see if it's already planned.

### Submitting Code

1. **Fork** the repo and create a branch from `main`
2. **Make your changes** — keep commits focused and well-described
3. **Test** — run `npm start` and manually verify your changes work
4. **Submit a PR** — describe what you changed and why

#### Branch naming

- `fix/description` for bug fixes
- `feature/description` for new features
- `docs/description` for documentation

#### PR guidelines

- Keep PRs small and focused. One feature or fix per PR.
- Update `CLAUDE.md` if you change the architecture or add new concepts.
- If you add a new IPC channel, add it to the `IPC_CHANNELS` const in `shared/types.ts`.
- If you add a keyboard shortcut, update the table in `README.md`.

### Good First Issues

Look for issues labelled `good first issue`. These are typically:
- UI tweaks (CSS, layout adjustments)
- Adding a new keyboard shortcut
- Documentation improvements
- Small bug fixes with clear reproduction steps

### Areas Where We Need Help

- **macOS/Linux support** — The codebase should work cross-platform but we don't test on these. If you're on macOS or Linux, just getting it to build and run is a valuable contribution.
- **Accessibility** — Screen reader support, keyboard navigation, high contrast themes.
- **Auto-updater** — Electron auto-update setup with GitHub Releases.
- **App icon** — We need a proper .ico/.icns icon (see `assets/README.md`).

## Code Style

- TypeScript strict mode
- Functional React components with hooks (no class components)
- IPC channel names are namespaced: `pty:*`, `workspace:*`, `app:*`
- CSS uses custom properties defined in `global.css`
- No external UI framework — vanilla CSS for now (keeps the bundle small)

## Architecture Principles

1. **Main process does the heavy lifting** — PTY management, file system, config. The renderer just shows UI.
2. **Context isolation** — All communication between main and renderer goes through the preload bridge. No `nodeIntegration`.
3. **Config is just JSON** — `electron-store` writes to `%APPDATA%`. No database, no cloud. Users own their data.
4. **Tabs are independent** — Each tab has its own PTY process. Closing a tab kills its process. No shared state between terminals.

## Questions?

Open an issue or reach out to the maintainers. We're happy to help you get oriented in the codebase.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
