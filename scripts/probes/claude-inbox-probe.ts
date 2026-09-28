// Phase 0 probe: post one line into a Claude Code session's inbox socket.
// Usage: PROBE_SOCKET=... PROBE_TOKEN=... bun claude-inbox-probe.ts "<text>" [log-file]
import { connect } from "node:net";
import { appendFileSync } from "node:fs";

const socketPath = process.env.PROBE_SOCKET;
const token = process.env.PROBE_TOKEN;
const text = process.argv[2] ?? "[claude-peers probe] inbox wake test";
const logFile = process.argv[3];

function log(line: string) {
  const entry = `${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} ${line}`;
  if (logFile) appendFileSync(logFile, entry + "\n");
  else console.log(entry);
}

if (!socketPath) {
  log("ERR no PROBE_SOCKET");
  process.exit(2);
}

const timer = setTimeout(() => {
  log("TIMEOUT");
  process.exit(3);
}, 2000);

const client = connect(socketPath, () => {
  if (token) client.write(JSON.stringify({ type: "auth", token }) + "\n");
  client.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  client.end();
});

client.on("error", (err: NodeJS.ErrnoException) => {
  clearTimeout(timer);
  log(`ERR ${err.code ?? err.message}`);
  process.exit(2);
});

client.on("close", (hadError) => {
  clearTimeout(timer);
  if (!hadError) log(`OK wrote auth=${Boolean(token)}`);
  process.exit(hadError ? 2 : 0);
});
