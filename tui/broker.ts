/**
 * tui/broker.ts — Broker HTTP fetch helper for comms-watch TUI
 *
 * Self-contained module (does not import from cli.ts per project convention).
 * Matches the brokerFetch pattern from cli.ts exactly.
 * Zero external dependencies — uses global fetch with AbortSignal.timeout.
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
export const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

/**
 * Fetch a broker endpoint with a 3-second timeout.
 * Throws on non-OK responses or network errors.
 */
export async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
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

/**
 * Safe polling wrapper — catches all errors and returns null instead of throwing.
 * Used by tabs that poll broker on intervals to avoid crashing on transient errors.
 */
export async function safeFetch<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    return await brokerFetch<T>(path, body);
  } catch {
    return null;
  }
}

/**
 * Check if the broker is running and reachable.
 * Returns true if /health responds OK, false otherwise.
 */
export async function isBrokerUp(): Promise<boolean> {
  try {
    await brokerFetch<{ status: string }>("/health");
    return true;
  } catch {
    return false;
  }
}
