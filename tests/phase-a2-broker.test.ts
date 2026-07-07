/**
 * Phase A.2 regression tests — broker-side worktree-aware peer discovery.
 *
 * Covers:
 *   - R1: deriveRepoCommonRoot (main + worktree → shared repo_common_root)
 *   - R1: handleListPeers scope=repo clusters main + worktree peers
 *   - R1: scope=repo falls back to git_root equality for NULL absolute_git_dir
 *         (back-compat with pre-A.1 peer rows)
 *   - R3: handleListPeers name_like substring filter (min 2 chars, no-op below)
 *   - R6.2: handleListPeers has_tmux filter (excludes NULL/empty tmux_session)
 *
 * Mirrors the inline-logic test pattern used in name-dedup.test.ts: copies the
 * helper + filter implementations from broker.ts into the test against pure
 * in-memory data. If the prod implementations diverge, this mirror must be
 * updated alongside.
 */

import { describe, test, expect } from "bun:test";

// Mirror of broker.ts deriveRepoCommonRoot. Keep in sync.
function deriveRepoCommonRoot(absoluteGitDir: string | null): string | null {
  if (!absoluteGitDir) return null;
  const stripped = absoluteGitDir.replace(/\/worktrees\/[^/]+\/?$/, "");
  if (!stripped.endsWith("/.git") && stripped !== ".git") return null;
  const repoRoot = stripped.replace(/\/?\.git$/, "");
  return repoRoot || null;
}

// Minimal Peer shape for filter tests. Mirrors fields read by the filters.
type TestPeer = {
  id: string;
  name: string | null;
  git_root: string | null;
  absolute_git_dir: string | null;
  tmux_session: string | null;
};

// Mirror of broker.ts handleListPeers `case "repo":` branch. The DB query
// (selectAllPeers.all()) is replaced with the input array; the rest of the
// logic is verbatim.
function scopeRepoFilter(
  all: TestPeer[],
  callerAbsoluteGitDir: string | null,
  callerGitRoot: string | null,
): TestPeer[] {
  const callerRepoRoot = deriveRepoCommonRoot(callerAbsoluteGitDir);
  if (callerRepoRoot) {
    return all.filter((p) => {
      const peerRoot = deriveRepoCommonRoot(p.absolute_git_dir);
      if (peerRoot) return peerRoot === callerRepoRoot;
      return callerGitRoot !== null && p.git_root === callerGitRoot;
    });
  }
  if (callerGitRoot) {
    return all.filter((p) => p.git_root === callerGitRoot);
  }
  return [];
}

// Mirror of broker.ts has_tmux filter (broker.ts:712).
function applyHasTmux(peers: TestPeer[], hasTmux: boolean | undefined): TestPeer[] {
  if (hasTmux === true) {
    return peers.filter((p) => p.tmux_session !== null && p.tmux_session !== "");
  }
  return peers;
}

// Mirror of broker.ts name_like filter (broker.ts:718).
function applyNameLike(peers: TestPeer[], nameLike: string | null | undefined): TestPeer[] {
  if (nameLike && nameLike.length >= 2) {
    const lower = nameLike.toLowerCase();
    return peers.filter((p) => p.name !== null && p.name.toLowerCase().includes(lower));
  }
  return peers;
}

describe("Phase A.2 — deriveRepoCommonRoot (R1)", () => {
  test("main repo: /repo/.git → /repo", () => {
    expect(deriveRepoCommonRoot("/repo/.git")).toBe("/repo");
  });

  test("worktree: /repo/.git/worktrees/feature → /repo", () => {
    expect(deriveRepoCommonRoot("/repo/.git/worktrees/feature")).toBe("/repo");
  });

  test("worktree with trailing slash collapses to same root", () => {
    expect(deriveRepoCommonRoot("/repo/.git/worktrees/feature/")).toBe("/repo");
  });

  test("nested repo path: /home/user/project/.git → /home/user/project", () => {
    expect(deriveRepoCommonRoot("/home/user/project/.git")).toBe("/home/user/project");
  });

  test("main + worktree of the SAME repo yield IDENTICAL roots (cluster invariant)", () => {
    const main = deriveRepoCommonRoot("/tmp/r/.git");
    const wt = deriveRepoCommonRoot("/tmp/r/.git/worktrees/feature");
    expect(main).toBe("/tmp/r");
    expect(wt).toBe("/tmp/r");
    expect(main).toBe(wt!);
  });

  test("NULL input: returns null (pre-A.1 row signal)", () => {
    expect(deriveRepoCommonRoot(null)).toBeNull();
  });

  test("empty string: returns null", () => {
    expect(deriveRepoCommonRoot("")).toBeNull();
  });

  test("malformed (no .git suffix): returns null", () => {
    expect(deriveRepoCommonRoot("/repo/random")).toBeNull();
  });

  test("malformed (worktrees-but-no-trailing-name): returns null", () => {
    // /repo/.git/worktrees with no /<name> suffix is not a valid worktree
    // absolute-git-dir — derive should refuse it, not produce a phantom root.
    expect(deriveRepoCommonRoot("/repo/.git/worktrees")).toBeNull();
  });
});

describe("Phase A.2 — scope=repo worktree clustering (R1)", () => {
  test("clusters main + worktree peers under shared repo_common_root", () => {
    // Pre-A.2 broker would return only the row whose git_root matched
    // verbatim — main and worktree have DIFFERENT git_root values.
    const peers: TestPeer[] = [
      { id: "main", name: "main", git_root: "/tmp/r", absolute_git_dir: "/tmp/r/.git", tmux_session: null },
      { id: "wt", name: "wt", git_root: "/tmp/r-wt", absolute_git_dir: "/tmp/r/.git/worktrees/feature", tmux_session: null },
      { id: "other", name: "other", git_root: "/other", absolute_git_dir: "/other/.git", tmux_session: null },
    ];
    const result = scopeRepoFilter(peers, "/tmp/r/.git", "/tmp/r");
    expect(result.map((p) => p.id).sort()).toEqual(["main", "wt"]);
  });

  test("back-compat: NULL absolute_git_dir falls back to git_root equality", () => {
    const peers: TestPeer[] = [
      { id: "old-same-root", name: "old", git_root: "/tmp/r", absolute_git_dir: null, tmux_session: null },
      { id: "old-other-root", name: "elsewhere", git_root: "/other", absolute_git_dir: null, tmux_session: null },
    ];
    const result = scopeRepoFilter(peers, "/tmp/r/.git", "/tmp/r");
    expect(result.map((p) => p.id)).toEqual(["old-same-root"]);
  });

  test("caller from worktree finds main peer (clustering is bidirectional)", () => {
    const peers: TestPeer[] = [
      { id: "main", name: "main", git_root: "/tmp/r", absolute_git_dir: "/tmp/r/.git", tmux_session: null },
    ];
    const result = scopeRepoFilter(peers, "/tmp/r/.git/worktrees/W", "/tmp/r-wt");
    expect(result.map((p) => p.id)).toEqual(["main"]);
  });

  test("does NOT cross-cluster peers from different repos", () => {
    const peers: TestPeer[] = [
      { id: "p1", name: "p1", git_root: "/tmp/a", absolute_git_dir: "/tmp/a/.git", tmux_session: null },
      { id: "p2", name: "p2", git_root: "/tmp/b", absolute_git_dir: "/tmp/b/.git", tmux_session: null },
    ];
    expect(scopeRepoFilter(peers, "/tmp/a/.git", "/tmp/a").map((p) => p.id)).toEqual(["p1"]);
  });

  test("mixed peer set: A.1+ peers via repo_root + pre-A.1 peer via git_root", () => {
    const peers: TestPeer[] = [
      { id: "main-new", name: "n1", git_root: "/tmp/r", absolute_git_dir: "/tmp/r/.git", tmux_session: null },
      { id: "wt-new", name: "n2", git_root: "/tmp/r-wt", absolute_git_dir: "/tmp/r/.git/worktrees/W", tmux_session: null },
      { id: "main-old", name: "n3", git_root: "/tmp/r", absolute_git_dir: null, tmux_session: null },
    ];
    const result = scopeRepoFilter(peers, "/tmp/r/.git", "/tmp/r");
    expect(result.map((p) => p.id).sort()).toEqual(["main-new", "main-old", "wt-new"]);
  });
});

describe("Phase A.2 — has_tmux filter (R6.2)", () => {
  const peers: TestPeer[] = [
    { id: "tmuxed", name: "n1", git_root: null, absolute_git_dir: null, tmux_session: "rag" },
    { id: "bare", name: "n2", git_root: null, absolute_git_dir: null, tmux_session: null },
    { id: "empty-tmux", name: "n3", git_root: null, absolute_git_dir: null, tmux_session: "" },
  ];

  test("has_tmux=true excludes peers with NULL tmux_session", () => {
    const result = applyHasTmux(peers, true);
    expect(result.find((p) => p.id === "bare")).toBeUndefined();
  });

  test("has_tmux=true excludes peers with empty-string tmux_session", () => {
    const result = applyHasTmux(peers, true);
    expect(result.find((p) => p.id === "empty-tmux")).toBeUndefined();
  });

  test("has_tmux=true keeps peers with a real tmux_session", () => {
    expect(applyHasTmux(peers, true).map((p) => p.id)).toEqual(["tmuxed"]);
  });

  test("has_tmux=undefined → no filter applied (default)", () => {
    expect(applyHasTmux(peers, undefined).length).toBe(3);
  });

  test("has_tmux=false → no filter applied (explicit opt-out)", () => {
    expect(applyHasTmux(peers, false).length).toBe(3);
  });
});

describe("Phase A.2 — name_like filter (R3)", () => {
  const peers: TestPeer[] = [
    { id: "1", name: "rag.2", git_root: null, absolute_git_dir: null, tmux_session: null },
    { id: "2", name: "rag.2.task.12345", git_root: null, absolute_git_dir: null, tmux_session: null },
    { id: "3", name: "codex.1", git_root: null, absolute_git_dir: null, tmux_session: null },
    { id: "4", name: null, git_root: null, absolute_git_dir: null, tmux_session: null },
  ];

  test("name_like='rag' matches 'rag.2' AND 'rag.2.task.12345'", () => {
    expect(applyNameLike(peers, "rag").map((p) => p.id).sort()).toEqual(["1", "2"]);
  });

  test("name_like='rag' does NOT match 'codex.1'", () => {
    const result = applyNameLike(peers, "rag");
    expect(result.find((p) => p.id === "3")).toBeUndefined();
  });

  test("single-char input ('r') → no filter applied (below 2-char min)", () => {
    expect(applyNameLike(peers, "r").length).toBe(4);
  });

  test("name_like is case-insensitive ('RAG' matches 'rag.2')", () => {
    expect(applyNameLike(peers, "RAG").map((p) => p.id).sort()).toEqual(["1", "2"]);
  });

  test("name_like null/undefined → no filter applied", () => {
    expect(applyNameLike(peers, null).length).toBe(4);
    expect(applyNameLike(peers, undefined).length).toBe(4);
  });

  test("peers with NULL name are excluded when name_like is applied (no false-positive substring on null)", () => {
    const result = applyNameLike(peers, "rag");
    expect(result.find((p) => p.id === "4")).toBeUndefined();
  });
});
