/**
 * claude-peers
 *
 * Peer discovery and messaging for Claude Code instances.
 *
 * Entry points:
 *   - server.ts  — MCP server (spawned by Claude Code, one per instance)
 *   - broker.ts  — Shared broker daemon (auto-launched or deployed separately)
 *   - client.ts  — Framework-agnostic SDK for non-Claude agents
 *   - cli.ts     — CLI utility for inspecting broker state
 *
 * See README.md for setup and usage.
 */

export { PeersClient } from "./client.ts";
export type { Peer, Message, PeersClientOptions, RegisterOptions } from "./client.ts";
