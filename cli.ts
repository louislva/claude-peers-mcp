#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts watch           — Live TUI dashboard of peers & message flow
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// --- watch command helpers (must be defined before the top-level switch) ---

type WatchPeer = {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
};

type WatchMessage = {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  delivered: number | boolean;
};

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

const PEER_PALETTE = [
  C.brightCyan,
  C.brightMagenta,
  C.brightYellow,
  C.brightGreen,
  C.brightBlue,
  C.brightRed,
  C.cyan,
  C.magenta,
  C.yellow,
  C.green,
];

function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PEER_PALETTE[h % PEER_PALETTE.length]!;
}

function paint(text: string, color: string): string {
  return `${color}${text}${C.reset}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

function padRight(s: string, n: number): string {
  const v = visibleLen(s);
  return v >= n ? s : s + " ".repeat(n - v);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

function formatAgo(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 1) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h${Math.floor((diff % 3600) / 60)}m`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function homeCollapse(p: string): string {
  const home = process.env.HOME ?? "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
function sparkline(values: number[], width: number): string {
  if (values.length === 0) return " ".repeat(width);
  const slice = values.slice(-width);
  const max = Math.max(1, ...slice);
  const padded: number[] = Array(width - slice.length).fill(0).concat(slice);
  return padded
    .map((v) => {
      if (v <= 0) return C.gray + "·" + C.reset;
      const idx = Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)));
      const col = v === max ? C.brightGreen : v > max * 0.5 ? C.green : C.cyan;
      return col + SPARK[idx] + C.reset;
    })
    .join("");
}

function bar(value: number, max: number, width: number, color: string): string {
  if (max <= 0) return " ".repeat(width);
  const filled = Math.round((value / max) * width);
  return color + "█".repeat(filled) + C.gray + "░".repeat(width - filled) + C.reset;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function peerStatus(lastSeen: string, now: number): { dot: string; label: string; color: string } {
  const age = (now - new Date(lastSeen).getTime()) / 1000;
  if (age < 10) return { dot: "●", label: "active", color: C.brightGreen };
  if (age < 45) return { dot: "●", label: "idle", color: C.brightYellow };
  if (age < 180) return { dot: "●", label: "slow", color: C.yellow };
  return { dot: "○", label: "stale", color: C.gray };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

async function runWatch(): Promise<void> {
  const out = process.stdout;
  const startedAt = Date.now();
  let running = true;
  let frame = 0;

  out.write("\x1b[?25l\x1b[?1049h\x1b[2J\x1b[H");

  const cleanup = () => {
    if (!running) return;
    running = false;
    out.write("\x1b[?25h\x1b[?1049l");
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);

  const animations: Array<{ from: string; to: string; startedAt: number; text: string }> = [];
  let lastSeenMsgId = -1;
  const activity = new Map<string, number[]>();

  function touchActivity(id: string, count = 1) {
    let row = activity.get(id);
    if (!row) {
      row = Array(60).fill(0);
      activity.set(id, row);
    }
    row[59] = (row[59] ?? 0) + count;
  }

  setInterval(() => {
    for (const row of activity.values()) {
      row.shift();
      row.push(0);
    }
  }, 1000);

  while (running) {
    frame++;
    let peers: WatchPeer[] = [];
    let recent: { messages: WatchMessage[]; total: number } = { messages: [], total: 0 };
    let brokerUp = false;
    let recentEndpointMissing = false;

    try {
      await brokerFetch<{ status: string; peers: number }>("/health");
      brokerUp = true;
    } catch {
      brokerUp = false;
    }

    if (brokerUp) {
      const [peersResult, recentResult] = await Promise.allSettled([
        brokerFetch<WatchPeer[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null }),
        brokerFetch<{ messages: WatchMessage[]; total: number }>("/recent-messages", { limit: 80 }),
      ]);
      if (peersResult.status === "fulfilled") peers = peersResult.value;
      if (recentResult.status === "fulfilled") {
        recent = recentResult.value;
      } else {
        const msg = String(recentResult.reason ?? "");
        recentEndpointMissing = /404|not found/i.test(msg);
      }
    }

    for (const m of recent.messages) {
      if (m.id > lastSeenMsgId) {
        if (lastSeenMsgId !== -1) {
          animations.push({ from: m.from_id, to: m.to_id, startedAt: Date.now(), text: m.text });
          touchActivity(m.from_id);
          touchActivity(m.to_id);
        }
      }
    }
    if (recent.messages.length > 0) {
      lastSeenMsgId = Math.max(lastSeenMsgId, recent.messages[recent.messages.length - 1]!.id);
    }
    const animCutoff = Date.now() - 2000;
    while (animations.length > 0 && animations[0]!.startedAt < animCutoff) animations.shift();

    const cols = Math.max(70, out.columns ?? 100);
    const lines: string[] = [];
    const now = Date.now();
    const uptime = Math.floor((now - startedAt) / 1000);
    const spin = SPINNER[frame % SPINNER.length];

    // Header
    const title = `${spin} claude-peers · live watch`;
    const statusText = brokerUp
      ? `${paint("●", C.brightGreen)} broker ok`
      : `${paint("●", C.brightRed)} broker down`;
    const stats = brokerUp
      ? `peers ${paint(String(peers.length), C.brightCyan)}  ·  msgs ${paint(String(recent.total), C.brightMagenta)}  ·  uptime ${formatDuration(uptime)}`
      : "waiting for broker…";

    lines.push(paint("╔" + "═".repeat(cols - 2) + "╗", C.brightBlue));
    const headerInner = `${paint(title, C.bold + C.brightCyan)}  ${statusText}  ${paint("│", C.gray)}  ${stats}`;
    const innerLen = visibleLen(headerInner);
    const pad = Math.max(0, cols - 4 - innerLen);
    lines.push(
      paint("║ ", C.brightBlue) + headerInner + " ".repeat(pad) + paint(" ║", C.brightBlue),
    );
    lines.push(paint("╚" + "═".repeat(cols - 2) + "╝", C.brightBlue));
    lines.push("");

    // Peers
    lines.push(paint("◉ PEERS ", C.bold + C.brightCyan) + paint("─".repeat(Math.max(0, cols - 9)), C.gray));
    if (!brokerUp) {
      lines.push("  " + paint("broker is not running — start a claude session first", C.dim));
    } else if (peers.length === 0) {
      lines.push("  " + paint("no peers registered yet", C.dim));
    } else {
      const sorted = [...peers].sort(
        (a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime(),
      );
      for (const p of sorted) {
        const st = peerStatus(p.last_seen, now);
        const color = colorForId(p.id);
        const spark = sparkline(activity.get(p.id) ?? [], 20);
        const idLabel = paint(p.id, C.bold + color);
        const dot = paint(st.dot, st.color);
        const statusLabel = paint(padRight(st.label, 6), st.color);
        const pidLabel = paint(`pid ${p.pid}`, C.dim);
        const cwdLabel = paint(truncate(homeCollapse(p.cwd), Math.max(20, cols - 70)), C.white);
        const seen = paint(`seen ${formatAgo(p.last_seen, now)} ago`, C.dim);
        lines.push(`  ${dot} ${idLabel}  ${statusLabel} ${pidLabel}  ${cwdLabel}  ${spark}  ${seen}`);
        if (p.summary) {
          lines.push("    " + paint("└─ ", C.gray) + paint(truncate(p.summary, cols - 8), C.italic + C.gray));
        }
      }
    }
    lines.push("");

    // Live flow
    lines.push(paint("↯ LIVE FLOW ", C.bold + C.brightMagenta) + paint("─".repeat(Math.max(0, cols - 13)), C.gray));
    if (recentEndpointMissing) {
      lines.push(
        "  " +
          paint("broker is outdated (missing /recent-messages) — restart it:", C.yellow) +
          " " +
          paint("bun cli.ts kill-broker", C.bold),
      );
    } else if (animations.length === 0) {
      lines.push("  " + paint("(quiet — no messages in flight)", C.dim));
    } else {
      for (const anim of animations.slice(-5)) {
        const age = (Date.now() - anim.startedAt) / 2000;
        const t = Math.min(1, age);
        const trackWidth = Math.min(40, Math.max(10, cols - 50));
        const pos = Math.floor(t * (trackWidth - 1));
        let track = "";
        for (let i = 0; i < trackWidth; i++) {
          if (i === pos) track += paint("◆", C.brightYellow);
          else if (i < pos) track += paint("━", C.magenta);
          else track += paint("─", C.gray);
        }
        const from = paint(padRight(anim.from, 10), colorForId(anim.from));
        const to = paint(padRight(anim.to, 10), colorForId(anim.to));
        const arrow = paint("▶", C.brightMagenta);
        const preview = paint(truncate(anim.text.replace(/\s+/g, " "), 24), C.dim);
        lines.push(`  ${from} ${track} ${arrow} ${to}  ${preview}`);
      }
    }
    lines.push("");

    // Recent history
    lines.push(paint("✉ RECENT MESSAGES ", C.bold + C.brightYellow) + paint("─".repeat(Math.max(0, cols - 19)), C.gray));
    if (recentEndpointMissing) {
      lines.push("  " + paint("(unavailable — broker needs restart to expose /recent-messages)", C.dim));
    } else if (recent.messages.length === 0) {
      lines.push("  " + paint("(no messages yet)", C.dim));
    } else {
      const tail = recent.messages.slice(-8);
      for (const m of tail) {
        const time = paint(formatTime(m.sent_at), C.dim);
        const from = paint(padRight(m.from_id, 10), colorForId(m.from_id));
        const to = paint(padRight(m.to_id, 10), colorForId(m.to_id));
        const arrow = paint("━━▶", C.gray);
        const delivered = m.delivered ? paint("✓", C.brightGreen) : paint("…", C.yellow);
        const text = paint(truncate(m.text.replace(/\s+/g, " "), Math.max(10, cols - 50)), C.white);
        lines.push(`  ${time}  ${from} ${arrow} ${to}  ${delivered}  ${text}`);
      }
    }
    lines.push("");

    // Activity bars
    lines.push(
      paint("▓ ACTIVITY ", C.bold + C.brightGreen) +
        paint("(last 60s) ", C.dim) +
        paint("─".repeat(Math.max(0, cols - 23)), C.gray),
    );
    const peerIds = peers.map((p) => p.id);
    if (peerIds.length === 0) {
      lines.push("  " + paint("—", C.dim));
    } else {
      const totals = peerIds.map((id) => ({
        id,
        total: (activity.get(id) ?? []).reduce((a, b) => a + b, 0),
      }));
      const max = Math.max(1, ...totals.map((t) => t.total));
      const barW = Math.min(40, Math.max(10, cols - 30));
      for (const t of totals.sort((a, b) => b.total - a.total)) {
        const color = colorForId(t.id);
        lines.push(
          `  ${paint(padRight(t.id, 10), color)}  ${bar(t.total, max, barW, color)}  ${paint(String(t.total), C.bold)}`,
        );
      }
    }
    lines.push("");
    lines.push(paint(`  ${spin} refreshing · press `, C.dim) + paint("Ctrl-C", C.bold) + paint(" to exit", C.dim));

    let buf = "\x1b[H\x1b[J";
    for (const line of lines) buf += line + "\x1b[K\n";
    out.write(buf);

    await new Promise((r) => setTimeout(r, 200));
  }
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const parts = [`${p.id}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "watch": {
    await runWatch();
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts watch           Live TUI dashboard of peers & message flow
  bun cli.ts kill-broker     Stop the broker daemon`);
}

