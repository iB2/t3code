/**
 * WorktreeManager — one git worktree + branch per T3 thread, guardrailed PR-only.
 *
 * ## Why this exists (Build 3: T3 as a control-plane over Paperclip)
 *
 * A T3 "thread"/"project" driven by the Megazord harness must not scribble on
 * the repo's base branch. This manager gives each thread its **own isolated
 * git worktree and branch** off a base branch, so the control-plane can manage
 * many concurrent projects over one repo without them colliding — and the only
 * way work leaves a thread is a **pull request** (`openPullRequest`). There is
 * deliberately NO merge/push-to-base path here: merging is a human click, which
 * mirrors Bruno's hard git rule ("branch → PR → PARE; merge is the human's
 * click", `.claude/rules/git-discipline.md`).
 *
 * ## Framework-agnostic on purpose
 *
 * Like {@link ../MegazordIntakeClient}, this is plain Node (spawns `git`/`gh`)
 * with no Effect/T3 imports, so it typechecks inside this leaf package's own
 * `tsc --noEmit` (no monorepo install) and is reused verbatim by the in-tree
 * `MegazordDriver`. The driver owns the Effect wrapping; this owns the git
 * mechanics and the guardrail.
 *
 * @module megazord/worktree
 */
import { spawn } from "node:child_process";
import * as nodePath from "node:path";

/** Deterministic, filesystem/branch-safe slug for a thread id. */
export function sanitizeThreadRef(threadId: string): string {
  const slug = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug === "" ? "thread" : slug;
}

export interface WorktreeManagerOptions {
  /** Absolute path to the primary repo checkout the control-plane manages. */
  readonly repoDir: string;
  /**
   * Directory that holds per-thread worktrees. Kept OUTSIDE `repoDir`'s tracked
   * tree by default (a sibling dir) so worktrees never appear as untracked
   * files in the base checkout. Defaults to `<repoDir>-megazord-worktrees`.
   */
  readonly worktreesDir?: string;
  /** Branch new thread branches fork from, and the only allowed PR base. Default `"main"`. */
  readonly baseBranch?: string;
  /** Prefix for per-thread branch names. Default `"megazord/thread-"`. */
  readonly branchPrefix?: string;
  /** Remote to push feature branches / open PRs against. Default `"origin"`. */
  readonly remote?: string;
  /** `git` executable. Default `"git"`. */
  readonly gitBin?: string;
  /** GitHub CLI executable used only by {@link WorktreeManager.openPullRequest}. Default `"gh"`. */
  readonly ghBin?: string;
  /** Max ms for any single git/gh invocation. Default 120000. */
  readonly commandTimeoutMs?: number;
}

/** Coordinates of one thread's isolated worktree + branch. */
export interface ThreadWorktree {
  readonly threadId: string;
  readonly branch: string;
  /** Absolute path to the worktree checkout. */
  readonly path: string;
  readonly baseBranch: string;
}

export interface WorktreeCommandDetail {
  readonly command?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

/** Thrown when a git/gh invocation fails. */
export class WorktreeError extends Error {
  override readonly name = "WorktreeError";
  readonly detail: WorktreeCommandDetail | undefined;
  constructor(message: string, detail?: WorktreeCommandDetail) {
    super(message);
    this.detail = detail;
  }
}

/**
 * Thrown when an operation would violate the PR-only guardrail — e.g. asking to
 * commit onto, or open a PR from, the base branch. This is the hard rule made
 * mechanical: a thread can only ever move work out via a PR from its own branch.
 */
export class WorktreeGuardrailError extends Error {
  override readonly name = "WorktreeGuardrailError";
  constructor(message: string) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class WorktreeManager {
  private readonly repoDir: string;
  private readonly worktreesDir: string;
  readonly baseBranch: string;
  private readonly branchPrefix: string;
  private readonly remote: string;
  private readonly gitBin: string;
  private readonly ghBin: string;
  private readonly timeoutMs: number;
  /** In-memory cache of resolved thread worktrees (source of truth is git). */
  private readonly known = new Map<string, ThreadWorktree>();

  constructor(options: WorktreeManagerOptions) {
    this.repoDir = options.repoDir;
    this.worktreesDir =
      options.worktreesDir ?? `${options.repoDir.replace(/[\\/]+$/, "")}-megazord-worktrees`;
    this.baseBranch = options.baseBranch ?? "main";
    this.branchPrefix = options.branchPrefix ?? "megazord/thread-";
    this.remote = options.remote ?? "origin";
    this.gitBin = options.gitBin ?? "git";
    this.ghBin = options.ghBin ?? "gh";
    this.timeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Deterministic branch name for a thread. */
  branchForThread(threadId: string): string {
    return `${this.branchPrefix}${sanitizeThreadRef(threadId)}`;
  }

  /** Absolute worktree path for a thread. */
  pathForThread(threadId: string): string {
    return nodePath.join(this.worktreesDir, sanitizeThreadRef(threadId));
  }

  /**
   * Create (or return the existing) isolated worktree + branch for a thread.
   * Idempotent: if the worktree already exists on disk it is reused. The new
   * branch is always forked from {@link baseBranch}, never checked out in the
   * base repo (so the base tree is untouched).
   */
  async ensureThreadWorktree(threadId: string): Promise<ThreadWorktree> {
    const cached = this.known.get(threadId);
    if (cached !== undefined) return cached;

    const branch = this.branchForThread(threadId);
    const path = this.pathForThread(threadId);
    if (branch === this.baseBranch) {
      throw new WorktreeGuardrailError(
        `refusing to bind thread '${threadId}' to the base branch '${this.baseBranch}'`,
      );
    }

    const existing = await this.findWorktreeByPath(path);
    if (existing !== undefined) {
      const record: ThreadWorktree = {
        threadId,
        branch: existing.branch,
        path,
        baseBranch: this.baseBranch,
      };
      this.known.set(threadId, record);
      return record;
    }

    // Base the new branch on the freshest local base ref. `git worktree add -b`
    // both creates the branch and checks it out into an isolated directory.
    const branchExists = await this.branchExists(branch);
    const addArgs = branchExists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, this.baseBranch];
    await this.git(addArgs);

    const record: ThreadWorktree = { threadId, branch, path, baseBranch: this.baseBranch };
    this.known.set(threadId, record);
    return record;
  }

  /** Cached lookup; does not touch git. */
  getThreadWorktree(threadId: string): ThreadWorktree | undefined {
    return this.known.get(threadId);
  }

  /**
   * List every worktree git currently knows about (parsed from
   * `git worktree list --porcelain`), including the base checkout.
   */
  async listWorktrees(): Promise<ReadonlyArray<{ path: string; branch: string; head: string }>> {
    const { stdout } = await this.git(["worktree", "list", "--porcelain"]);
    const out: Array<{ path: string; branch: string; head: string }> = [];
    let path = "";
    let head = "";
    let branch = "";
    const flush = () => {
      if (path !== "") out.push({ path, branch, head });
      path = "";
      head = "";
      branch = "";
    };
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        flush();
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        // refs/heads/<name>
        branch = line
          .slice("branch ".length)
          .trim()
          .replace(/^refs\/heads\//, "");
      } else if (line.trim() === "") {
        flush();
      }
    }
    flush();
    return out;
  }

  /**
   * Stage and commit everything in the thread's worktree onto its branch.
   * Guardrail: refuses if the worktree is somehow on the base branch. Returns
   * `{ committed:false }` when there is nothing to commit (clean tree).
   */
  async commitAll(
    threadId: string,
    message: string,
  ): Promise<{ committed: boolean; sha?: string }> {
    const wt = await this.ensureThreadWorktree(threadId);
    await this.assertNotBase(wt);
    await this.git(["add", "-A"], wt.path);
    const status = await this.git(["status", "--porcelain"], wt.path);
    if (status.stdout.trim() === "") return { committed: false };
    await this.git(["commit", "-m", message], wt.path);
    const sha = (await this.git(["rev-parse", "HEAD"], wt.path)).stdout.trim();
    return { committed: true, sha };
  }

  /**
   * Push the thread's feature branch to the remote. Guardrail: never pushes the
   * base branch (the refspec is pinned to the thread branch, and we assert the
   * worktree is not on base first).
   */
  async pushBranch(threadId: string): Promise<void> {
    const wt = await this.ensureThreadWorktree(threadId);
    await this.assertNotBase(wt);
    await this.git(["push", "-u", this.remote, `${wt.branch}:${wt.branch}`], wt.path);
  }

  /**
   * Open a pull request FROM the thread branch INTO the base branch via `gh`.
   * This is the only sanctioned way work leaves a thread. Guardrail: the PR base
   * is always {@link baseBranch} and the head is always the thread branch — this
   * function never merges. Returns the PR URL when `gh` prints one.
   */
  async openPullRequest(
    threadId: string,
    input: { readonly title: string; readonly body?: string },
  ): Promise<{ url?: string }> {
    const wt = await this.ensureThreadWorktree(threadId);
    await this.assertNotBase(wt);
    const args = [
      "pr",
      "create",
      "--base",
      this.baseBranch,
      "--head",
      wt.branch,
      "--title",
      input.title,
      "--body",
      input.body ?? "",
    ];
    const { stdout } = await this.run(this.ghBin, args, wt.path);
    const url = extractPrUrl(stdout);
    return url === undefined ? {} : { url };
  }

  /**
   * Remove a thread's worktree. Does NOT delete the branch (so an open PR keeps
   * working). `force` discards uncommitted changes.
   */
  async removeThreadWorktree(threadId: string, opts?: { readonly force?: boolean }): Promise<void> {
    const path = this.pathForThread(threadId);
    const args = ["worktree", "remove", path];
    if (opts?.force === true) args.push("--force");
    try {
      await this.git(args);
    } finally {
      this.known.delete(threadId);
    }
  }

  // --- internals ---------------------------------------------------------

  /** Refuse any write operation whose worktree resolves to the base branch. */
  private async assertNotBase(wt: ThreadWorktree): Promise<void> {
    const current = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], wt.path)).stdout.trim();
    if (current === this.baseBranch) {
      throw new WorktreeGuardrailError(
        `thread '${wt.threadId}' worktree is on base branch '${this.baseBranch}'; ` +
          `Megazord threads are PR-only and may never commit/push to base`,
      );
    }
    if (current !== wt.branch) {
      throw new WorktreeGuardrailError(
        `thread '${wt.threadId}' worktree is on '${current}', expected '${wt.branch}'`,
      );
    }
  }

  private async branchExists(branch: string): Promise<boolean> {
    const res = await this.git(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      this.repoDir,
      { allowFailure: true },
    );
    return res.code === 0;
  }

  private async findWorktreeByPath(path: string): Promise<{ branch: string } | undefined> {
    const target = nodePath.resolve(path).toLowerCase();
    for (const wt of await this.listWorktrees()) {
      if (nodePath.resolve(wt.path).toLowerCase() === target) return { branch: wt.branch };
    }
    return undefined;
  }

  private git(
    args: ReadonlyArray<string>,
    cwd: string = this.repoDir,
    opts?: { readonly allowFailure?: boolean },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.run(this.gitBin, args, cwd, opts);
  }

  private run(
    cmd: string,
    args: ReadonlyArray<string>,
    cwd: string,
    opts?: { readonly allowFailure?: boolean },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, [...args], {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const printable = `${cmd} ${args.join(" ")}`;
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new WorktreeError(`command timed out after ${this.timeoutMs}ms: ${printable}`, {
            command: printable,
            stdout,
            stderr,
          }),
        );
      }, this.timeoutMs);
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(
          new WorktreeError(`failed to spawn '${cmd}': ${err.message}`, {
            command: printable,
            stdout,
            stderr,
          }),
        );
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const exit = code ?? -1;
        if (exit !== 0 && opts?.allowFailure !== true) {
          reject(
            new WorktreeError(`command failed (${exit}): ${printable}`, {
              command: printable,
              stdout,
              stderr,
              code: exit,
            }),
          );
          return;
        }
        resolve({ stdout, stderr, code: exit });
      });
    });
  }
}

/** Pull the first github.com PR URL out of `gh pr create` stdout. */
export function extractPrUrl(stdout: string): string | undefined {
  const match = stdout.match(/https?:\/\/\S*github\.com\/\S+\/pull\/\d+/);
  return match?.[0];
}
