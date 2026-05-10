#!/usr/bin/env node
// gsd-peers-sync — PostToolUse hook
// Automatically registers GSD subagents as claude-peers and keeps their
// summary in sync with the current task from STATE.md.
//
// How it works:
// 1. On each tool use, calls /session-heartbeat which atomically:
//    - Registers a peer if none exists for this session
//    - Updates the session's last_tool_use timestamp
//    - Syncs the task summary from STATE.md
// 2. All state lives in the broker's SQLite — no temp files, no cleanup scripts.
// 3. Session end is handled by the broker's stale peer cleanup (PID check).
//
// The hook talks directly to the broker HTTP API (default localhost:7899).
// No MCP server needed — this is a lightweight sidecar.
//
// Config: .planning/config.json → hooks.peers_sync: true (default: false)

// Repo's package.json has "type": "module", so node loads this as ESM and
// CJS `require` is unavailable. Use `node:` ESM imports instead.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT || '7899', 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const STATE_FILE = path.join('.planning', 'STATE.md');

// Extract current task summary from STATE.md frontmatter + content
function extractTaskSummary(cwd) {
  const statePath = path.join(cwd, STATE_FILE);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, 'utf8');
    const parts = [];

    // Extract phase from frontmatter or content
    const phaseMatch = content.match(/(?:current_phase|phase)\s*:\s*(.+)/i);
    if (phaseMatch) {
      parts.push(phaseMatch[1].trim());
    }

    // Extract current plan
    const planMatch = content.match(/(?:current_plan|plan)\s*:\s*(.+)/i);
    if (planMatch) {
      parts.push(`Plan: ${planMatch[1].trim()}`);
    }

    // Extract current task
    const taskMatch = content.match(/(?:current_task|task)\s*:\s*(.+)/i);
    if (taskMatch) {
      parts.push(`Task: ${taskMatch[1].trim()}`);
    }

    if (parts.length > 0) {
      return parts.join(' | ');
    }

    // Fallback: use first heading after frontmatter
    const headingMatch = content.match(/^#+\s+(.+)$/m);
    if (headingMatch) {
      return headingMatch[1].trim();
    }

    return null;
  } catch {
    return null;
  }
}

// Simple HTTP POST to broker (no external deps)
function brokerPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${BROKER_URL}${endpoint}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 3000,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(chunks));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(data);
    req.end();
  });
}

function isBrokerAlive() {
  return new Promise((resolve) => {
    const req = http.get(`${BROKER_URL}/health`, { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Get git root for cwd
function getGitRoot(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// --- Main hook logic ---

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id;
    const cwd = data.cwd || process.cwd();

    if (!sessionId) {
      process.exit(0);
    }

    // Check if peers_sync is enabled in config
    const configPath = path.join(cwd, '.planning', 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.hooks?.peers_sync === false) {
          process.exit(0);
        }
      } catch {
        // ignore parse errors, default to enabled if .planning exists
      }
    } else {
      // No GSD project — exit silently
      process.exit(0);
    }

    // Check if broker is alive
    if (!(await isBrokerAlive())) {
      process.exit(0);
    }

    // Single atomic call: registers peer if needed, updates session, syncs summary
    const gitRoot = getGitRoot(cwd);
    const summary = extractTaskSummary(cwd) || `GSD executor in ${path.basename(cwd)}`;

    try {
      await brokerPost('/session-heartbeat', {
        session_id: sessionId,
        pid: process.ppid || process.pid, // Use parent PID (the Claude process), not the hook's PID
        cwd,
        git_root: gitRoot,
        task_summary: summary,
      });
    } catch {
      // Broker unavailable, exit silently
    }

    process.exit(0);
  } catch {
    // Silent fail — never block tool execution
    process.exit(0);
  }
});
