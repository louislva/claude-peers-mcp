/**
 * Generate a 1-2 sentence summary of what a Claude Code instance is likely
 * working on, based on its working directory and git context.
 *
 * Uses OpenAI's chat completions API for cheap, fast inference.
 * Token resolution order:
 *   1. OPENAI_API_KEY environment variable
 *   2. Codex CLI OAuth token (~/.codex/auth.json)
 * Falls back gracefully if neither is available.
 */

const DEFAULT_MODEL = "gpt-5.4-nano";
const CODEX_AUTH_PATH = `${process.env.HOME ?? "~"}/.codex/auth.json`;

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
}

/**
 * Attempt to read the Codex CLI OAuth access token from ~/.codex/auth.json.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function getCodexOAuthToken(): Promise<string | null> {
  try {
    const file = Bun.file(CODEX_AUTH_PATH);
    if (!(await file.exists())) {
      return null;
    }
    const data: CodexAuthFile = await file.json();
    return data.tokens?.access_token?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve an API bearer token from available sources.
 * Priority: OPENAI_API_KEY env var > Codex CLI OAuth token.
 */
async function resolveApiToken(): Promise<string | null> {
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return envKey;
  }
  return getCodexOAuthToken();
}

export async function generateSummary(context: {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
  model?: string;
}): Promise<string | null> {
  const apiToken = await resolveApiToken();
  if (!apiToken) {
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

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        model,
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
        max_tokens: 100,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content?.trim() ?? null;
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
