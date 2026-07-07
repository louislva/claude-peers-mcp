/**
 * Generate a 1-2 sentence summary of what a Claude Code instance is working on.
 *
 * Deterministic — derives the summary from git context with no network calls,
 * no API keys, and no failure modes. Returns null only if every input is empty.
 *
 * Replaces the previous Anthropic API integration (PR #25-era code that called
 * Claude Haiku for the same purpose). The AI version added an external dependency,
 * a billing surface, a CWD/git-branch privacy leak to api.anthropic.com, and a
 * silent-failure path on bad API responses — all for a 1-line label that doesn't
 * need intelligence.
 */

import { basename } from "node:path";

export function generateSummary(context: {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
}): string | null {
  const project = basename(context.git_root || context.cwd);
  // Return null rather than an empty string when the path resolves to something
  // basename() can't extract (e.g. "/" or ""). Callers use `if (summary)` so
  // both null and "" would be treated as absent, but the return type says
  // `string | null` — honor it literally.
  if (!project) return null;
  const parts = [project];

  if (context.git_branch && context.git_branch !== "main" && context.git_branch !== "master") {
    parts.push(`(${context.git_branch})`);
  }

  if (context.recent_files && context.recent_files.length > 0) {
    parts.push(`— editing ${context.recent_files[0]}`);
    if (context.recent_files.length > 1) {
      parts.push(`+${context.recent_files.length - 1}`);
    }
  }

  return parts.join(" ");
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
