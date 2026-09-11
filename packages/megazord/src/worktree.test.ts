import { describe, expect, it } from "vite-plus/test";

import { extractPrUrl, sanitizeThreadRef, WorktreeManager } from "./worktree.ts";

describe("sanitizeThreadRef", () => {
  it("lowercases and slugifies", () => {
    expect(sanitizeThreadRef("Thread ABC/123")).toBe("thread-abc-123");
  });
  it("collapses and trims separators", () => {
    expect(sanitizeThreadRef("  --Foo__Bar--  ")).toBe("foo__bar");
  });
  it("falls back for empty input", () => {
    expect(sanitizeThreadRef("   ")).toBe("thread");
  });
});

describe("WorktreeManager branch/path derivation", () => {
  const mgr = new WorktreeManager({ repoDir: "/repo", baseBranch: "main" });

  it("derives a deterministic per-thread branch", () => {
    expect(mgr.branchForThread("t-1")).toBe("megazord/thread-t-1");
  });

  it("derives an isolated worktree path outside the repo tree by default", () => {
    const p = mgr.pathForThread("t-1");
    expect(p).toContain("megazord-worktrees");
    expect(p).toContain("t-1");
    expect(p.startsWith("/repo/")).toBe(false);
  });

  it("exposes the base branch as the only PR target", () => {
    expect(mgr.baseBranch).toBe("main");
  });
});

describe("extractPrUrl", () => {
  it("pulls the PR url from gh output", () => {
    const out = "Creating pull request for x into main\nhttps://github.com/iB2/t3code/pull/2\n";
    expect(extractPrUrl(out)).toBe("https://github.com/iB2/t3code/pull/2");
  });
  it("returns undefined when absent", () => {
    expect(extractPrUrl("no url here")).toBeUndefined();
  });
});
