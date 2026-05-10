import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

export interface TestBroker {
  url: string;
  wsUrl: string;
  port: number;
  proc: ReturnType<typeof Bun.spawn>;
  dbPath: string;
  tmpDir: string;
}

// Each test file picks a port from a wide window so parallel suites don't collide.
let nextPort = 17900 + Math.floor(Math.random() * 5000);

export async function startBroker(
  envOverrides: Record<string, string> = {}
): Promise<TestBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
  const dbPath = join(tmpDir, "peers.db");

  for (let attempt = 0; attempt < 20; attempt++) {
    const port = nextPort++;
    const proc = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(port),
        CLAUDE_PEERS_DB: dbPath,
        CLAUDE_PEERS_DORMANT_TTL_HOURS: "24",
        ...envOverrides,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });

    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) { ready = true; break; }
      } catch { /* retry */ }
      await Bun.sleep(50);
    }
    if (ready) {
      return {
        url: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        port,
        proc,
        dbPath,
        tmpDir,
      };
    }
    try { proc.kill(); await proc.exited; } catch { /* */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
  throw new Error("could not start broker on any port");
}

export async function stopBroker(b: TestBroker): Promise<void> {
  try {
    b.proc.kill();
    await b.proc.exited;
  } catch { /* */ }
  // Best-effort cleanup; on Windows the SQLite file lingers a bit.
  for (let i = 0; i < 10; i++) {
    try { rmSync(b.tmpDir, { recursive: true, force: true }); break; } catch { await Bun.sleep(50); }
  }
}

export async function post<T = unknown>(
  url: string,
  body: unknown
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as T;
  return { status: res.status, body: parsed };
}

export async function get<T = unknown>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  const parsed = (await res.json()) as T;
  return { status: res.status, body: parsed };
}

/**
 * Find this Bun process's PID as seen by the broker -- used as a "guaranteed live"
 * pid in registration payloads. The broker checks `process.kill(pid, 0)` to detect
 * dead processes, so we need a pid the broker *can* signal.
 *
 * The current Bun test runner is a sibling process to the broker and can be
 * signalled, so process.pid works here.
 */
export function livePid(): number {
  return process.pid;
}

/**
 * sha256 hex helper for test fixtures (mimics the client's group_secret_hash).
 */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function groupId(secret: string): Promise<string> {
  return (await sha256Hex(secret)).slice(0, 32);
}
