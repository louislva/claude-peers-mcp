/**
 * Read an environment variable with a deprecation fallback.
 *
 * Prefers `newName`. If only `oldName` is set, returns its value and writes a
 * one-line deprecation notice to stderr. Used by the gsd-comms-mcp rename
 * (claude-peers → gsd-comms) so users with pre-existing `CLAUDE_PEERS_*`
 * environment variables continue to work while being nudged toward the new
 * `GSD_COMMS_*` names.
 */
const warned = new Set<string>();

export function envWithDeprecation(newName: string, oldName: string): string | undefined {
  if (process.env[newName] !== undefined) return process.env[newName];
  const old = process.env[oldName];
  if (old !== undefined) {
    if (!warned.has(oldName)) {
      warned.add(oldName);
      process.stderr.write(
        `[gsd-comms] note: ${oldName} is deprecated; use ${newName} instead\n`
      );
    }
    return old;
  }
  return undefined;
}
