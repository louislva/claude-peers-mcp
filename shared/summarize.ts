/**
 * Generate a 1-2 sentence summary of what a Claude Code instance is likely
 * working on, based on its working directory and git context.
 *
 * Uses Codex CLI (`codex exec`) for inference, leveraging the user's
 * existing OAuth authentication from ~/.codex/auth.json.
 * Falls back gracefully if Codex CLI is not available.
 */

const DEFAULT_MODEL = "gpt-5.4-mini";

/**
 * Find the codex CLI binary path.
 */
async function findCodexBinary(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["which", "codex"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0 && text.trim()) {
      return text.trim();
    }
  } catch {
    // codex not installed
  }
  return null;
}

export async function generateSummary(context: {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
  model?: string;
}): Promise<string | null> {
  const codexPath = await findCodexBinary();
  if (!codexPath) {
    return null;
  }

  const model = context.model ?? DEFAULT_MODEL;

  const parts = [`Working directory: ${context.cwd}`];
  if (context.git_root) {
    parts.push(`Git repo root: ${context.git_root}`);
  }
  if (context.git_branch) {
    parts.push(`Branch: ${context.git_branch}`);
  }
  if (context.recent_files && context.recent_files.length > 0) {
    parts.push(`Recently modified files: ${context.recent_files.join(", ")}`);
  }

  const prompt = `You generate brief summaries of what a developer is working on based on their project context. Respond with exactly 1-2 sentences, no more. Be specific about the project name and likely task.\n\nBased on this context, what is this developer likely working on?\n\n${parts.join("\n")}`;

  // Use a temp file for clean output (codex exec -o writes only the final message)
  const outputFile = `/tmp/gsd-comms-summary-${process.pid}-${Date.now()}.txt`;

  try {
    const proc = Bun.spawn(
      [
        codexPath,
        "exec",
        "--model", model,
        "--sandbox", "read-only",
        "--ephemeral",
        "--skip-git-repo-check",
        "-o", outputFile,
        prompt,
      ],
      {
        cwd: context.cwd,
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env },
      }
    );

    const exited = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) =>
        setTimeout(() => {
          proc.kill();
          resolve(1);
        }, 15000)
      ),
    ]);

    if (exited !== 0) {
      return null;
    }

    const file = Bun.file(outputFile);
    if (!(await file.exists())) {
      return null;
    }

    const output = await file.text();
    // Clean up temp file
    try { await Bun.write(outputFile, ""); await file.delete?.(); } catch {}
    try { const { unlink } = await import("node:fs/promises"); await unlink(outputFile); } catch {}

    const trimmed = output.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Get the current git branch name for a directory.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

/**
 * Get recently modified tracked files in the git repo.
 */
export async function getRecentFiles(
  cwd: string,
  limit = 10
): Promise<string[]> {
  try {
    // Get modified/staged files first
    const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    const files = diffText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    if (files.length >= limit) {
      return files.slice(0, limit);
    }

    // Also get recently committed files
    const logProc = Bun.spawn(
      ["git", "log", "--oneline", "--name-only", "-5", "--format="],
      {
        cwd,
        stdout: "pipe",
        stderr: "ignore",
      }
    );
    const logText = await new Response(logProc.stdout).text();
    await logProc.exited;

    const logFiles = logText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    const allFiles = [...new Set([...files, ...logFiles])];
    return allFiles.slice(0, limit);
  } catch {
    return [];
  }
}
