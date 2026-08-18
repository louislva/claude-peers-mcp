/**
 * Generate a 1-2 sentence summary of what a Claude Code instance is likely
 * working on, based on its working directory and git context.
 *
 * Uses OpenAI's gpt-5.4-nano for cheap, fast inference.
 * Requires OPENAI_API_KEY environment variable.
 * Falls back gracefully if unavailable — but says why on stderr. A silent
 * fallback here is indistinguishable from "the feature does not exist", which
 * is how this went unnoticed across 198 sessions.
 */

/**
 * MCP stdio servers must keep stdout clean for the protocol, so every
 * diagnostic goes to stderr with the same prefix the server uses.
 */
function warn(msg: string) {
  console.error(`[claude-peers] auto-summary: ${msg}`);
}

export async function generateSummary(context: {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
}): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    warn("OPENAI_API_KEY is not set in this process; skipping");
    return null;
  }

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

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          {
            role: "system",
            content:
              "You generate brief summaries of what a developer is working on based on their project context. Respond with exactly 1-2 sentences, no more. Be specific about the project name and likely task.",
          },
          {
            role: "user",
            content: `Based on this context, what is this developer likely working on?\n\n${parts.join("\n")}`,
          },
        ],
        // The GPT-5 family rejects `max_tokens` (it wants
        // `max_completion_tokens`) and rejects any `temperature` other than
        // the default. Sending either returns HTTP 400.
        max_completion_tokens: 400,
        // Reasoning tokens come out of the same budget as the answer, so keep
        // the thinking short or a 1-2 sentence summary can be starved.
        reasoning_effort: "low",
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      warn(`OpenAI returned HTTP ${res.status} ${detail.slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: { content: string | null };
        finish_reason?: string;
      }>;
    };
    const choice = data.choices[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      // A 200 with empty content means the budget went to reasoning tokens.
      warn(
        `OpenAI returned no content (finish_reason=${choice?.finish_reason ?? "unknown"})`,
      );
      return null;
    }
    return text;
  } catch (e) {
    warn(e instanceof Error ? e.message : String(e));
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
