#!/usr/bin/env node
// Tarca Terminal — Claude Code SessionStart Hook
//
// This script is invoked by Claude Code's SessionStart hook when a new
// session begins. Claude Code pipes a JSON object to stdin containing
// the session_id. We write it to a .session file so Tarca Terminal can
// capture it for resume-on-reboot.
//
// Environment variables (set by Tarca Terminal's PTY spawner):
//   TARCA_METRICS_DIR  — directory for metrics/session files
//   TARCA_WORKSPACE_ID — workspace ID for this session

const fs = require('fs');
const path = require('path');

const metricsDir = process.env.TARCA_METRICS_DIR;
const workspaceId = process.env.TARCA_WORKSPACE_ID;

// Silently exit if not running inside Tarca Terminal
if (!metricsDir || !workspaceId) {
  process.exit(0);
}

let inputData = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(inputData.trim());
    if (!payload.session_id) return;

    // Ensure metrics directory exists
    if (!fs.existsSync(metricsDir)) {
      fs.mkdirSync(metricsDir, { recursive: true });
    }

    // Sanitize workspace ID for safe filenames (colons are invalid on Windows)
    const safeId = workspaceId.replace(/[:<>"|?*]/g, '_');
    const filePath = path.join(metricsDir, safeId + '.session');
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: payload.session_id,
      source: payload.source || 'unknown',
      timestamp: Date.now(),
    }), 'utf8');
  } catch {
    // Fail silently — never break Claude Code's workflow
  }
});

// Handle errors silently
process.stdin.on('error', () => {});
process.on('uncaughtException', () => process.exit(0));
