#!/usr/bin/env node
// KiteTerm — Claude Code Statusline Hook
//
// This script is invoked by Claude Code's statusline hook after every
// assistant response. Claude Code pipes a JSON object to stdin containing
// context/cost/model info. We wrap it with a timestamp and workspaceId,
// then append it as a JSONL line to the metrics file.
//
// Environment variables (set by KiteTerm's PTY spawner):
//   KITETERM_METRICS_DIR  — directory for .jsonl metric files
//   KITETERM_WORKSPACE_ID — workspace ID for this session

const fs = require('fs');
const path = require('path');

const metricsDir = process.env.KITETERM_METRICS_DIR;
const workspaceId = process.env.KITETERM_WORKSPACE_ID;

// Silently exit if not running inside KiteTerm
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
    const metrics = JSON.parse(inputData.trim());

    const entry = {
      timestamp: Date.now(),
      workspaceId: workspaceId,
      metrics: metrics,
    };

    // Ensure metrics directory exists
    if (!fs.existsSync(metricsDir)) {
      fs.mkdirSync(metricsDir, { recursive: true });
    }

    const filePath = path.join(metricsDir, workspaceId + '.jsonl');
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Fail silently — never break Claude Code's workflow
  }
});

// Handle errors silently
process.stdin.on('error', () => {});
process.on('uncaughtException', () => process.exit(0));
