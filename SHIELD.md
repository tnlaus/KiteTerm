# KiteTerm Shield — Architecture Specification

## Overview

KiteTerm Shield is the paid, closed-source DLP/audit/compliance layer for KiteTerm. It ships as a plugin that the free app discovers at runtime. If installed and licensed, the PTY data stream routes through Shield's interceptor pipeline. If not installed, KiteTerm works identically — no artificial crippling.

**Buyer persona:** CISOs, security managers, government procurement — not individual developers.

**Core value proposition:** "What controls do you have around AI-assisted development?" KiteTerm Shield is the answer.

## Open Core Split

| | KiteTerm (Free, MIT) | KiteTerm Shield (Paid, Closed Source) |
|---|---|---|
| **Codebase** | Public GitHub repo | Separate private repo |
| **Distribution** | GitHub Releases, npm | Separate installer / plugin package |
| **Terminal management** | Yes | Inherits from free |
| **Claude Code integration** | Yes (metrics, analytics) | Inherits from free |
| **DLP pattern scanning** | No | Yes |
| **Policy engine** | No | Yes |
| **Audit logging** | No | Yes |
| **SIEM integration** | No | Yes |
| **Session recording** | No | Yes (opt-in) |

## Plugin Architecture

Shield is a runtime-discovered plugin. The free app checks for it on startup and hooks it into the data stream if found.

### Discovery

On app launch, `src/main/plugin-loader.ts` checks these locations in order:

1. `{appPath}/plugins/kiteterm-shield/` (bundled with enterprise installer)
2. `{userData}/plugins/kiteterm-shield/` (user-installed)
3. Registry key `HKLM\SOFTWARE\KiteTerm\ShieldPath` (IT-deployed via GPO)

The plugin must expose a `package.json` with `"kiteterm-plugin": "shield"` and a `main` entry pointing to a CommonJS module.

### Plugin Interface

The free app defines a `ShieldPlugin` interface in `src/shared/plugin-types.ts`. Shield implements this interface. The free app never imports Shield code directly — it loads dynamically via `require()` after validation.

```typescript
interface ShieldPlugin {
  name: string;
  version: string;

  // Lifecycle
  initialize(context: PluginContext): Promise<void>;
  shutdown(): Promise<void>;

  // Data stream interception
  interceptInput(event: DataEvent): DataEvent | null;  // null = block
  interceptOutput(event: DataEvent): DataEvent | null;

  // License
  validateLicense(): Promise<LicenseStatus>;

  // UI extension point
  getStatusBarComponent?(): ShieldStatusInfo;
}
```

### Data Flow with Shield

```
User keystroke / paste
    |
    v
xterm.js onData()
    |
    v
[Renderer] api.pty.write(paneId, data)
    |
    v
[IPC] pty:data:to-main  -->  ipc-handlers.ts
    |
    v
+----------------------------------+
| Shield Interceptor (INPUT)       |  <-- Plugin hooks in here
| +------------------------------+ |
| | Pattern Scanner              | |  Regex + keyword matching
| | Policy Engine                | |  Evaluate rules for this workspace
| | Decision: pass / warn / block| |
| | Audit Logger                 | |  Log the event
| +------------------------------+ |
+----------------------------------+
    |
    v (if not blocked)
writeToPty() --> node-pty stdin
    |
    v
Shell / Claude Code processes input
    |
    v
node-pty onData() fires with output
    |
    v
+----------------------------------+
| Shield Interceptor (OUTPUT)      |  <-- Plugin hooks in here too
| +------------------------------+ |
| | Pattern Scanner              | |  Scan responses for leaks
| | Audit Logger                 | |  Log detections
| +------------------------------+ |
+----------------------------------+
    |
    v (if not blocked)
[IPC] pty:data:to-renderer
    |
    v
[Renderer] pane.terminal.write(data)
    |
    v
xterm.js displays output
```

### Hook Points in Free Codebase

The free app has two interception points where Shield's middleware is called:

**Input interception — `src/main/pty-manager.ts : writeToPty()`**
```
Before: managed.process.write(data)
With Shield: data = shield.interceptInput({ workspaceId, data, direction: 'input', timestamp }) ?? BLOCKED
```

**Output interception — `src/main/pty-manager.ts : ptyProcess.onData()`**
```
Before: window.webContents.send(PTY_DATA_TO_RENDERER, { workspaceId, data })
With Shield: data = shield.interceptOutput({ workspaceId, data, direction: 'output', timestamp }) ?? BLOCKED
```

Both hooks are in the **main process** (not renderer), so Shield never runs in the browser context and has full Node.js access for file I/O, crypto, network.

## Detection Categories

### Australian PII (ISM-0408, ISM-1187)

| Pattern | Regex / Logic | Example |
|---------|---------------|---------|
| Tax File Number (TFN) | 9 digits, Luhn-like check digit | `123 456 782` |
| Medicare number | 10-11 digits, specific format | `2123 45670 1` |
| ABN | 11 digits, mod-89 check | `51 824 753 556` |
| ACN | 9 digits, mod-10 check | `004 085 616` |
| Passport | Alpha + 7 digits | `N1234567` |
| Driver's licence | State-specific formats | `12345678` (NSW) |

### Credentials (ISM-1546)

| Pattern | Regex | Example |
|---------|-------|---------|
| AWS Access Key | `AKIA[0-9A-Z]{16}` | `AKIAIOSFODNN7EXAMPLE` |
| AWS Secret Key | 40 chars base64 after `=` or `:` | `wJalrXUtnFEMI/K7MDENG/...` |
| Azure token | `eyJ...` (JWT format) | `eyJhbGciOiJSUzI1NiIs...` |
| GCP service account | `"type": "service_account"` JSON | `{"type":"service_account",...}` |
| Generic API key | `sk-[a-zA-Z0-9]{20,}`, `key-...`, `token-...` | `sk-ant-api03-...` |
| SSH private key | `-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----` | PEM block |
| DB connection string | `(Server|Data Source)=...;Password=...` | SQL Server conn string |
| Bearer token | `Bearer [A-Za-z0-9\-._~+/]+=*` | `Bearer eyJhbGci...` |

### Classification Markers (ISM-0271, ISM-0272)

| Pattern | Keywords |
|---------|----------|
| Australian classifications | `OFFICIAL`, `OFFICIAL:Sensitive`, `PROTECTED`, `SECRET`, `TOP SECRET` |
| Dissemination markers | `AUSTEO`, `AGAO`, `REL ...`, `NATIONAL CABINET` |
| Caveats | `EYES ONLY`, `NOT FOR RELEASE`, `SENSITIVE:Legal`, `SENSITIVE:Personal` |

### Code Secrets (ISM-1227)

| Pattern | Detection method |
|---------|-----------------|
| `.env` file contents | Key=value pairs, `export VAR=`, `dotenv` format |
| Hardcoded passwords | `password\s*[:=]\s*['"]...`, `passwd`, `secret` in assignments |
| JWT tokens | `eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+` |
| Private keys (PEM) | `-----BEGIN.*PRIVATE KEY-----` block |
| Certificate files | `-----BEGIN CERTIFICATE-----` |

### Data Patterns (ISM-1187)

| Pattern | Detection method |
|---------|-----------------|
| Credit card numbers | 13-19 digits, Luhn check |
| Bulk email addresses | 5+ email addresses in single input |
| Bulk phone numbers | 5+ AU phone numbers (`04xx`, `+614xx`) in single input |
| Medicare claims data | MBS/PBS item number patterns |

## Action Modes

Three modes per pattern per workspace:

### Monitor
- Log the detection silently
- Show a subtle counter in the status bar (e.g., "Shield: 3 detections")
- No interruption to developer workflow
- Best for: initial rollout, baselining, low-risk workspaces

### Warn
- Show a non-blocking toast notification in the renderer
- Developer can click "Continue" or "Cancel"
- Either choice is logged
- Best for: moderate-risk workspaces, training period

### Block
- Prevent the data from reaching the PTY (input) or terminal (output)
- Show an inline explanation in the terminal
- Always logged as a blocked event
- Best for: high-security workspaces, classified environments

## Audit Logging

### Event Format (JSONL)

```json
{
  "timestamp": "2026-02-28T09:14:33.221Z",
  "sessionId": "abc-123",
  "workspace": "DISR Azure Migration",
  "workspaceId": "12c1fa30-...",
  "user": "matt@tnlit.com.au",
  "event": "dlp_detection",
  "direction": "input",
  "category": "credential",
  "pattern": "aws_access_key",
  "action": "warned",
  "userResponse": "continued",
  "context": "Paste operation, 342 characters",
  "hash": "sha256:e3b0c44298fc..."
}
```

### Design Principles

- **No raw content by default** — Only metadata, category, and action. No terminal content in logs unless explicitly opted in.
- **Tamper-evident** — Each log entry includes a SHA-256 hash chaining to the previous entry. Tampering breaks the chain.
- **Rotatable** — Daily log rotation with configurable retention period.
- **Exportable** — CLI tool to export logs as CSV/JSON for SIEM ingestion.
- **Optional session recording** — Full terminal I/O can be recorded per workspace if the policy requires it. User is shown a clear "This session is being recorded" indicator.

### Storage

```
{userData}/shield/
├── audit/
│   ├── 2026-02-28.jsonl      # Daily audit logs
│   ├── 2026-02-27.jsonl
│   └── ...
├── sessions/                   # Optional full session recordings
│   ├── {sessionId}.cast       # asciicast v2 format
│   └── ...
├── policies/
│   └── active-policy.json     # Current policy config
└── license.json               # License key + validation cache
```

## Policy Configuration

Policies are JSON documents that define rules per workspace or globally:

```json
{
  "version": 1,
  "defaultAction": "monitor",
  "globalRules": [
    { "category": "credential", "action": "block" },
    { "category": "classification", "action": "warn" },
    { "category": "pii", "action": "monitor" }
  ],
  "workspaceOverrides": {
    "workspace-id-1": {
      "name": "DISR Protected",
      "rules": [
        { "category": "pii", "action": "block" },
        { "category": "classification", "action": "block" }
      ],
      "sessionRecording": true
    }
  }
}
```

Policies can be:
- Configured locally via Shield settings UI
- Deployed via GPO (registry-pushed JSON)
- Pulled from a central policy server (enterprise feature)

## IPC Channels (Shield <-> Renderer)

```
shield:status          — Shield enabled/disabled + detection count
shield:detection       — Real-time detection event (for toast/status bar)
shield:policy:get      — Get current policy
shield:policy:update   — Update policy
shield:license:status  — License validation result
shield:audit:query     — Query audit logs for dashboard
```

## Licensing

### Key Format
Standard RSA-signed JWT containing:
- `org`: Organization name
- `seats`: Max concurrent users
- `features`: Enabled feature flags
- `exp`: Expiry timestamp

### Validation
- Offline validation via embedded public key (no phone-home required)
- Optional online validation for seat counting in multi-user deployments
- Grace period: 30 days after expiry before enforcement

## Pricing Model

| Tier | Price | Target |
|------|-------|--------|
| Per-seat | $50-100/user/month | Small teams |
| Site license | Annual flat fee, tiered by headcount | Agencies |
| Bundled | Included in TNL consulting engagement | Existing clients |

The first sales are embedded in service engagements, not standalone product purchases.

## Implementation Phases

### Phase 1: Pattern Scanner (MVP)
- TFN, Medicare, ABN detection
- AWS/Azure credential detection
- SSH private key detection
- Monitor mode only (log, don't block)
- Basic audit log output

### Phase 2: Policy Engine + Actions
- Warn and Block modes
- Per-workspace policy overrides
- Toast notifications in renderer
- Blocked event terminal messages

### Phase 3: Audit Dashboard + Export
- Shield tab in analytics dashboard
- Detection timeline chart
- CSV/JSON export for SIEM
- Log integrity verification

### Phase 4: Enterprise Features
- Central policy server
- GPO deployment
- Session recording (asciicast format)
- SIEM webhook integration (Splunk, Sentinel, Elastic)
- IRAP assessment documentation
