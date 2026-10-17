#!/usr/bin/env node
/**
 * t3-chair — the one command an external orchestrator (a "chair") uses to run
 * T3 without the GUI: see what needs a decision, read a thread, act on it.
 *
 * The other megazord CLIs each do one thing for a caller that already knows which
 * thread it wants. A chair starts from nothing, so this adds the missing reads
 * (`projects`, `inbox`, `threads`, `read`) and puts every write behind the same two
 * rules:
 *
 *  - **The fence.** `<base-dir>/chair/policy.json` names the projects and provider
 *    instances that stay on this machine. A thread outside the policy is not
 *    listed, not readable and not writable. No policy file means no access, and
 *    an environment other than `local` needs its own entry in it.
 *  - **The log.** Every write needs `--why` and is recorded in
 *    `<base-dir>/chair/decisions.jsonl` BEFORE it is sent, then again with its
 *    outcome, so a decision that went wrong can be found and a started job can
 *    always be stopped.
 *
 * It talks to T3 through T3's own MCP endpoint (`src/mcp.ts`), the surface T3
 * keeps for agents it did not start; 0.1.0 removed the HTTP routes the chair
 * used before. Each environment is signed in once with `login`, approved by a
 * person in the browser, and the stored credential is reused until it expires
 * (30 days). `--env <name>` picks the environment; the default is `local`.
 *
 * Output is always JSON on stdout. Exit 3 is a refusal (fence, bad target, missing
 * `--why`), 2 is a usage error, 1 is a failure (including a missing or expired
 * credential, whose message says how to renew it).
 *
 * Usage:
 *   node bin/t3-chair.mjs login [--env <name>] [--no-browser]
 *   node bin/t3-chair.mjs envs
 *   node bin/t3-chair.mjs accounts
 *   node bin/t3-chair.mjs projects
 *   node bin/t3-chair.mjs inbox [--project <id|title>]
 *   node bin/t3-chair.mjs threads --project <id|title> [--status <s>] [--limit 30]
 *   node bin/t3-chair.mjs read --thread <id> [--messages 6] [--chars 4000]
 *   node bin/t3-chair.mjs open --project <id|title> --title "<t>" --task "<brief>" --why "<reason>"
 *        [--account "<name>" | --instance <id>] [--model <id>] [--runtime <mode>] [--no-start]
 *        [--base <branch> | --in-place] [--effort <level>]
 *   node bin/t3-chair.mjs continue --thread <id> --task "<text>" --why "<reason>"
 *        [--wait] [--timeout-seconds 900] [--effort <level>]
 *   node bin/t3-chair.mjs answer --thread <id> --answer "<text>" --why "<reason>" [--request <id>]
 *   node bin/t3-chair.mjs interrupt --thread <id> --why "<reason>"
 *   node bin/t3-chair.mjs settle --thread <id> --why "<reason>"
 *   node bin/t3-chair.mjs wait --thread <id> [--timeout-seconds 900]
 *   node bin/t3-chair.mjs log [--tail 20]
 *
 * Every verb that touches threads takes `--env <name>`.
 *
 * `open` sets the model's effort to `high` unless `--effort` says otherwise (it
 * needs `--account` to know the model; without one T3's project default
 * stands). `continue --effort` changes an existing thread's level from that
 * turn on. `read` reports the level a thread is set to.
 *
 * `open` gives each new thread its own worktree, branched from
 * `origin/<base>` (default `main`), so threads in the same project can run side
 * by side. `--in-place` runs it in the project folder instead, for work that
 * needs what is only on that machine; such threads must run one at a time.
 *
 * Accounts are shown and chosen by display name (`account`, e.g. "Claude
 * Pessoal"): the instance id behind a name differs from machine to machine.
 *
 * `approve` is kept as a verb but always refuses: T3's MCP cannot answer
 * permission approvals, so they are answered in the T3 app.
 *
 * `--task-file <path>` and `--answer-file <path>` read the text from a UTF-8 file
 * instead of the command line; use them for anything longer than one line.
 *
 * @module megazord/bin/t3-chair
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";

import {
  ChairRefusal,
  NEEDS_DECISION,
  assertInstanceAllowed,
  classifyMcpThread,
  parsePolicy,
  projectVisible,
  threadVisible,
} from "../src/chair.ts";
import { defaultBaseDir } from "../src/dispatch.ts";
import {
  McpToolError,
  appOrigin,
  connect,
  loadCredential,
  loadEnvironments,
  login,
  resolveEnvironment,
} from "../src/mcp.ts";

const VALUE_FLAGS = new Set([
  "env",
  "project",
  "thread",
  "status",
  "limit",
  "messages",
  "chars",
  "title",
  "task",
  "why",
  "instance",
  "account",
  "base",
  "effort",
  "model",
  "runtime",
  "answer",
  "request",
  "decision",
  "since",
  "timeout-seconds",
  "tail",
  "base-dir",
  "task-file",
  "answer-file",
]);
const BOOL_FLAGS = new Set(["wait", "no-start", "no-browser", "in-place", "help"]);
const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"];

/** A malformed command (exit 2). Thrown, never exit()ed: see main. */
class ChairUsage extends Error {}

function usage(message) {
  throw new ChairUsage(message);
}

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const out = { verb };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) usage(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) out[name] = true;
    else if (VALUE_FLAGS.has(name)) out[name] = rest[++i];
    else usage(`unknown flag: ${a}`);
  }
  return out;
}

function need(args, ...names) {
  for (const n of names) {
    if (typeof args[n] !== "string" || args[n].trim() === "") usage(`--${n} is required`);
  }
}

function intFlag(args, name, fallback) {
  if (args[name] === undefined) return fallback;
  const n = Number(args[name]);
  if (!Number.isInteger(n) || n <= 0) usage(`--${name} must be a positive integer`);
  return n;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 1) + "\n");
}

function clip(text, max) {
  const t = String(text ?? "");
  return t.length <= max ? t : `${t.slice(0, max)}… [+${t.length - max} chars]`;
}

function baseDirOf(args) {
  return args["base-dir"] ?? defaultBaseDir();
}

async function loadPolicy(baseDir, environment) {
  const file = nodePath.join(baseDir, "chair", "policy.json");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new ChairRefusal(`refused: no chair policy at ${file}; the chair has no access`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ChairRefusal(`refused: chair policy at ${file} is not valid JSON`);
  }
  return parsePolicy(json, environment);
}

// ── session: one environment, its fence and its MCP connection ─────────────

/** A thread row in the shape the fence reads, keeping the MCP row alongside. */
function rowOf(t, projectId) {
  return {
    id: t.threadId,
    projectId: t.projectId ?? projectId,
    title: t.title,
    updatedAt: t.updatedAt,
    deletedAt: null,
    archived: t.archived === true,
    modelSelection: { instanceId: t.providerInstanceId ?? "", model: t.model ?? "" },
    runtimeMode: t.runtimeMode,
    interactionMode: t.interactionMode,
    branch: t.branch ?? null,
    mcp: t,
  };
}

async function openSession(args) {
  const baseDir = baseDirOf(args);
  const env = await resolveEnvironment(baseDir, args.env);
  const policy = await loadPolicy(baseDir, env.name);
  const mcp = await connect(baseDir, env);

  const projectList = [];
  for (let cursor = 0; cursor !== null && cursor !== undefined;) {
    const page = await mcp.call("t3_project_list", { limit: 100, cursor });
    projectList.push(...(page.projects ?? []));
    cursor = page.nextCursor;
  }
  const projects = projectList.filter((p) => projectVisible(policy, p));
  const visibleProjectIds = new Set(projects.map((p) => p.id));

  let environmentId;
  const url = async (threadId) => {
    environmentId ??= (await mcp.call("t3_environment_read")).environmentId;
    return `${appOrigin(env)}/${environmentId}/${threadId}`;
  };

  /** Visible threads of one project; `settled` picks the active or the settled list. */
  const listThreads = async (projectId, settled, max = Infinity) => {
    const rows = [];
    for (let cursor = 0; cursor !== null && cursor !== undefined && rows.length < max;) {
      const page = await mcp.call("t3_thread_list", { projectId, settled, limit: 100, cursor });
      for (const t of page.threads ?? []) {
        const row = rowOf(t, projectId);
        if (threadVisible(policy, row) && !row.archived) rows.push(row);
      }
      cursor = page.nextCursor;
    }
    return rows;
  };

  /** One thread the chair may touch, read live, or a refusal. */
  const getThread = async (threadId) => {
    const wanted = String(threadId).trim();
    let body;
    try {
      body = await mcp.call("t3_thread_read", { threadId: wanted, limit: 1, maxCharsPerItem: 1 });
    } catch (e) {
      if (e instanceof McpToolError) {
        throw new ChairRefusal(`refused: no thread '${wanted}' within the chair policy`);
      }
      throw e;
    }
    const row = rowOf(body.thread ?? {});
    if (!visibleProjectIds.has(row.projectId) || !threadVisible(policy, row)) {
      throw new ChairRefusal(`refused: no thread '${wanted}' within the chair policy`);
    }
    return row;
  };

  // Instance ids differ per machine (the same account can be `claudeAgent` on
  // one and `claudeAgent_3` on another); the display name is what stays the
  // same, so that is what the chair shows and accepts.
  let providers;
  const allProviders = async () => {
    providers ??= (await mcp.call("orchestrator_capabilities")).providers ?? [];
    return providers;
  };
  /** Accounts a thread can run on here: enabled, with models, outside the fence. */
  const accounts = async () =>
    (await allProviders())
      .filter(
        (p) =>
          (p.models ?? []).length > 0 &&
          (p.constraints ?? []).length === 0 &&
          !policy.blockedInstanceIds.includes(p.providerInstanceId),
      )
      .map((p) => ({
        account: p.displayName ?? p.providerInstanceId,
        instanceId: p.providerInstanceId,
        models: p.models.map((m) => m.id),
      }));
  /** The reasoning levels a model offers here (its `effort` option), or [] if it has none. */
  const effortLevels = async (instanceId, model) => {
    const provider = (await allProviders()).find((p) => p.providerInstanceId === instanceId);
    const option = (provider?.models ?? [])
      .find((m) => m.id === model)
      ?.options?.find((o) => o.id === "effort");
    return (option?.options ?? []).map((o) => o.id);
  };
  const accountName = async (instanceId) =>
    (await allProviders()).find((p) => p.providerInstanceId === instanceId)?.displayName ??
    instanceId;

  return {
    baseDir,
    env,
    policy,
    mcp,
    projects,
    listThreads,
    getThread,
    url,
    accounts,
    accountName,
    effortLevels,
  };
}

function resolveProject(session, ref) {
  const wanted = String(ref).trim();
  const match =
    session.projects.find((p) => p.id === wanted) ??
    session.projects.find((p) => p.title === wanted);
  if (match === undefined) {
    throw new ChairRefusal(`refused: no project '${wanted}' within the chair policy`);
  }
  return match;
}

/** A pending question in the shape the chair has always printed. */
function questionOf(request) {
  return {
    requestId: request.requestId,
    questions: (request.questions ?? []).map((q) => ({
      id: String(q.id ?? q.question ?? ""),
      question: String(q.question ?? ""),
      header: String(q.header ?? ""),
      options: (q.options ?? [])
        .map((o) => String(o.value ?? o.label ?? ""))
        .filter((o) => o !== ""),
      multiSelect: q.multiSelect === true,
    })),
  };
}

async function pendingQuestion(session, threadId, requestId) {
  let id = requestId;
  if (id === undefined) {
    const { requestIds } = await session.mcp.call("t3_pending_request_list", { threadId });
    id = requestIds?.[0];
  }
  if (id === undefined) return undefined;
  return questionOf(await session.mcp.call("t3_pending_request_read", { threadId, requestId: id }));
}

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * A thread's state. A run blocked on a person still reads `running`, and only
 * `t3_thread_read` says how many requests are pending, so an active thread
 * from a list is re-read; the question itself is fetched only when one waits.
 */
async function stateOf(session, row) {
  let thread = row.mcp;
  if (ACTIVE.has(thread.status) && thread.pendingRequestCount === undefined) {
    const body = await session.mcp.call("t3_thread_read", {
      threadId: row.id,
      limit: 1,
      maxCharsPerItem: 1,
    });
    thread = { ...thread, ...body.thread };
  }
  const pending =
    ACTIVE.has(thread.status) && Number(thread.pendingRequestCount ?? 0) > 0
      ? await pendingQuestion(session, row.id)
      : undefined;
  return classifyMcpThread(thread, pending);
}

async function summarize(session, row, state) {
  const project = session.projects.find((p) => p.id === row.projectId);
  return {
    environment: session.env.name,
    threadId: row.id,
    project: project?.title ?? "",
    title: row.title,
    status: state.status,
    updatedAt: row.updatedAt,
    account: await session.accountName(row.modelSelection.instanceId),
    instanceId: row.modelSelection.instanceId,
    model: row.modelSelection.model,
    runtimeMode: row.runtimeMode,
    ...(state.pendingInput ? { question: state.pendingInput } : {}),
    ...(state.pendingApprovals ? { approvals: state.pendingApprovals } : {}),
    url: await session.url(row.id),
  };
}

const ROLE = { user_message: "user", assistant_message: "assistant", proposed_plan: "plan" };

/** The last `count` conversation messages of a thread, oldest first. */
async function lastMessages(session, threadId, count, chars, itemCount, runId) {
  const collect = async (start) => {
    const out = [];
    for (let after = start; after !== null && after !== undefined;) {
      const page = await session.mcp.call("t3_thread_read", {
        threadId,
        view: "messages",
        limit: 100,
        maxCharsPerItem: chars,
        ...(after >= 0 ? { afterPosition: after } : {}),
      });
      for (const item of page.items ?? []) {
        if (runId !== undefined && item.runId !== runId) continue;
        if (item.status === "running" || String(item.text ?? "").trim() === "") continue;
        out.push({
          role: ROLE[item.type] ?? item.type,
          at: item.updatedAt,
          text: item.textTruncated ? `${item.text}… [truncated]` : item.text,
        });
      }
      after = page.hasMore ? page.nextPosition : null;
    }
    return out.slice(-count);
  };
  // Jump near the end of a long thread; fall back to the whole thread when
  // that window turns out to hold too few messages.
  const window = Math.max(200, count * 20);
  if (itemCount > window) {
    const tail = await collect(itemCount - window);
    if (tail.length >= count) return tail;
  }
  return collect(-1);
}

// ── decision log ────────────────────────────────────────────────────────────

async function logLine(baseDir, entry) {
  const dir = nodePath.join(baseDir, "chair");
  await mkdir(dir, { recursive: true });
  await appendFile(
    nodePath.join(dir, "decisions.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
    "utf8",
  );
}

/** Record the intent, run the action, record how it ended. */
async function decide(session, args, intent, action) {
  need(args, "why");
  const id = randomUUID();
  await logLine(session.baseDir, {
    id,
    phase: "intent",
    verb: args.verb,
    environment: session.env.name,
    why: args.why,
    ...intent,
  });
  try {
    const result = await action(id);
    await logLine(session.baseDir, { id, phase: "result", ok: true });
    return { decisionId: id, ...result };
  } catch (e) {
    await logLine(session.baseDir, {
      id,
      phase: "result",
      ok: false,
      error: String(e?.message ?? e),
    });
    throw e;
  }
}

const WAIT_STATE = {
  completed: "completed",
  idle: "completed",
  failed: "error",
  interrupted: "interrupted",
  cancelled: "interrupted",
  rolled_back: "interrupted",
};

const WAIT_SLICE_MS = 5000;

/**
 * Wait for a run and report it the way `wait` and `continue --wait` always have.
 *
 * `t3_thread_wait` returns only when the run ends, and a run blocked on a
 * question or an approval never ends by itself, so the wait goes in short
 * slices and checks for pending requests between them: a blocked run comes
 * back at once (`awaiting-input`, or `running` with `approvals`), not at the
 * deadline.
 */
async function waitOutcome(session, threadId, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let waited;
  let row;
  for (;;) {
    const slice = Math.max(1, Math.min(WAIT_SLICE_MS, deadline - Date.now()));
    waited = await session.mcp.call(
      "t3_thread_wait",
      { threadId, ...(runId ? { runId } : {}), timeoutMs: slice },
      slice + 60_000,
    );
    row = await session.getThread(threadId);
    if (!waited.timedOut || Number(row.mcp.pendingRequestCount ?? 0) > 0) break;
    if (Date.now() >= deadline) break;
  }
  const blocked = waited.timedOut && Number(row.mcp.pendingRequestCount ?? 0) > 0;
  const pending = blocked ? await pendingQuestion(session, threadId) : undefined;
  const approvals =
    blocked && pending === undefined ? classifyMcpThread(row.mcp).pendingApprovals : undefined;
  const state = pending
    ? "awaiting-input"
    : waited.timedOut
      ? "running"
      : (WAIT_STATE[waited.status] ?? "running");
  const finalRun = waited.runId ?? runId;
  const messages = finalRun
    ? await lastMessages(session, threadId, 50, 50_000, Number(row.mcp.itemCount ?? 0), finalRun)
    : [];
  return {
    threadId,
    state,
    timedOut: waited.timedOut === true && !blocked,
    ...(approvals ? { approvals } : {}),
    text: messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text)
      .join("\n\n"),
    ...(pending ? { question: pending } : {}),
    url: await session.url(threadId),
  };
}

const DEFAULT_EFFORT = "high";

/** Refuse an effort level the model does not offer on this machine. */
async function assertEffort(session, instanceId, model, effort) {
  const levels = await session.effortLevels(instanceId, model);
  if (!levels.includes(effort)) {
    usage(
      `--effort for ${model} must be one of ${levels.join(", ") || "(none: this model has no effort setting)"}`,
    );
  }
}

/** The effort a thread is set to, as T3 recorded it. */
async function threadEffort(session, threadId) {
  const config = await session.mcp.call("t3_thread_configuration", { threadId });
  const option = (config.modelSelection?.options ?? []).find((o) => o.id === "effort");
  return option?.value ?? "model default";
}

/**
 * Wait for T3 to finish preparing a new thread's worktree. Launching returns
 * before the worktree exists, and a bad base branch only fails afterwards, so
 * `open` checks here instead of reporting a thread that is already dead.
 * Returns the failure text, or undefined once the worktree exists (or the
 * preparation is still going at the deadline).
 */
async function workspaceFailure(session, threadId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { thread } = await session.mcp.call("t3_thread_read", {
      threadId,
      limit: 1,
      maxCharsPerItem: 1,
    });
    if (thread?.worktreePath) return undefined;
    if (thread?.status === "failed") {
      const activity = await session.mcp.call("t3_thread_read", {
        threadId,
        view: "activity",
        limit: 20,
        maxCharsPerItem: 500,
      });
      const error = (activity.items ?? []).filter((i) => i.type === "error").pop();
      return String(error?.text ?? "workspace preparation failed");
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// ── verbs ───────────────────────────────────────────────────────────────────

/** Verbs that run before (or without) a signed-in session. */
const LOCAL_VERBS = {
  async login(args) {
    const baseDir = baseDirOf(args);
    const env = await resolveEnvironment(baseDir, args.env);
    console.error(
      `t3-chair: approve this sign-in in the browser for environment '${env.name}' (${env.mcpUrl}).\n` +
        "  Use a pairing code from Settings → Connections on that machine, or `t3 auth pairing create` there,\n" +
        "  and choose Full access so the chair can work on full-access threads. If no browser opened, visit:",
    );
    return login(baseDir, env, {
      announce: (url) => console.error(`  ${url}`),
      openBrowser: args["no-browser"] !== true,
    });
  },

  async envs(args) {
    const baseDir = baseDirOf(args);
    const out = [];
    for (const env of await loadEnvironments(baseDir)) {
      const c = await loadCredential(baseDir, env.name);
      let policy = "ok";
      try {
        await loadPolicy(baseDir, env.name);
      } catch (e) {
        policy = String(e?.message ?? e);
      }
      out.push({
        name: env.name,
        mcpUrl: env.mcpUrl,
        signedIn: c !== undefined,
        expiresAt: c?.expiresAt ?? null,
        policy,
      });
    }
    return out;
  },

  async log(args) {
    const tail = intFlag(args, "tail", 20);
    let raw = "";
    try {
      raw = await readFile(nodePath.join(baseDirOf(args), "chair", "decisions.jsonl"), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-tail)
      .map((line) => JSON.parse(line));
  },
};

const VERBS = {
  /** The accounts a new thread can run on in this environment, by name. */
  async accounts(session) {
    return session.accounts();
  },

  async projects(session) {
    const out = [];
    for (const p of session.projects) {
      const counts = {};
      for (const row of await session.listThreads(p.id, false)) {
        const s = row.mcp.status === "waiting" ? "waiting" : classifyMcpThread(row.mcp).status;
        counts[s] = (counts[s] ?? 0) + 1;
      }
      // The settled list can be long; its size is all `projects` needs.
      const settled = await session.mcp.call("t3_thread_list", {
        projectId: p.id,
        settled: true,
        limit: 1,
      });
      if (Number(settled.total ?? 0) > 0) counts.done = Number(settled.total);
      out.push({
        projectId: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
        threads: counts,
      });
    }
    return out;
  },

  async inbox(session, args) {
    const scope = args.project ? [resolveProject(session, args.project)] : session.projects;
    const needsDecision = [];
    const running = [];
    for (const p of scope) {
      for (const row of await session.listThreads(p.id, false)) {
        const state = await stateOf(session, row);
        if (NEEDS_DECISION.includes(state.status)) {
          needsDecision.push(await summarize(session, row, state));
        } else if (state.status === "running") {
          running.push(await summarize(session, row, state));
        }
      }
    }
    const byRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
    return { needsDecision: needsDecision.sort(byRecent), running: running.sort(byRecent) };
  },

  async threads(session, args) {
    need(args, "project");
    const project = resolveProject(session, args.project);
    const limit = intFlag(args, "limit", 30);
    const out = [];
    for (const settled of [false, true]) {
      const rows = (await session.listThreads(project.id, settled)).sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
      );
      for (const row of rows) {
        const state = await stateOf(session, row);
        if (args.status !== undefined && state.status !== args.status) continue;
        out.push(await summarize(session, row, state));
        if (out.length >= limit) return out;
      }
    }
    return out;
  },

  async read(session, args) {
    need(args, "thread");
    const row = await session.getThread(args.thread);
    const state = await stateOf(session, row);
    const count = intFlag(args, "messages", 6);
    const chars = intFlag(args, "chars", 4000);
    const messages = (
      await lastMessages(session, row.id, count, chars, Number(row.mcp.itemCount ?? 0))
    ).map((m) => ({ ...m, text: clip(m.text, chars) }));
    return {
      ...(await summarize(session, row, state)),
      effort: await threadEffort(session, row.id),
      branch: row.branch,
      messages,
    };
  },

  async open(session, args) {
    need(args, "project", "title", "task");
    const project = resolveProject(session, args.project);
    if (args.account !== undefined && args.instance !== undefined) {
      usage("pass --account or --instance, not both");
    }
    if (args.account !== undefined) {
      const wanted = args.account.trim().toLowerCase();
      const available = await session.accounts();
      const match = available.find((a) => a.account.toLowerCase() === wanted);
      if (match === undefined) {
        throw new ChairRefusal(
          `refused: no account '${args.account}' on '${session.env.name}'; available: ${available.map((a) => a.account).join(", ")}`,
        );
      }
      args.instance = match.instanceId;
    }
    if (args.instance !== undefined) assertInstanceAllowed(session.policy, args.instance);
    const runtimeMode = args.runtime ?? "full-access";
    if (!RUNTIME_MODES.includes(runtimeMode)) usage(`--runtime must be one of ${RUNTIME_MODES}`);
    let modelSelection;
    if (args.instance !== undefined) {
      let model = args.model;
      if (model === undefined) {
        const provider = (await session.accounts()).find((a) => a.instanceId === args.instance);
        model = provider?.models?.[0];
        if (model === undefined) {
          throw new ChairRefusal(
            `refused: instance '${args.instance}' has no available model here`,
          );
        }
      }
      modelSelection = { instanceId: args.instance, model };
    } else if (args.model !== undefined) {
      modelSelection = { model: args.model };
    }
    // Without options a model runs at its own default effort (medium for Opus
    // 5.5), not the level the app's composer is set to: the desktop settings
    // never reach a thread opened over MCP. So `open` asks for DEFAULT_EFFORT
    // unless told otherwise, whenever it knows the account and the model has
    // that level. With no account it cannot know the model, so it leaves T3's
    // project default alone.
    let effort;
    if (args.effort !== undefined) {
      if (modelSelection?.instanceId === undefined) usage("--effort needs --account (or --instance)");
      await assertEffort(session, modelSelection.instanceId, modelSelection.model, args.effort);
      effort = args.effort;
    } else if (modelSelection?.instanceId !== undefined) {
      const levels = await session.effortLevels(modelSelection.instanceId, modelSelection.model);
      if (levels.includes(DEFAULT_EFFORT)) effort = DEFAULT_EFFORT;
    }
    if (effort !== undefined) {
      modelSelection = { ...modelSelection, options: [{ id: "effort", value: effort }] };
    }
    if (args["in-place"] && args.base !== undefined) usage("pass --base or --in-place, not both");
    const base = args.base ?? "main";
    const workspaceStrategy = args["in-place"]
      ? { type: "root" }
      : { type: "worktree", baseRef: base, startFromOrigin: true };
    const intent = {
      projectId: project.id,
      title: args.title,
      workspace: args["in-place"] ? "in-place" : `worktree from origin/${base}`,
    };
    return decide(session, args, intent, async () => {
      const launched = await session.mcp.call("t3_thread_launch", {
        title: args.title,
        projectId: project.id,
        runtimeMode,
        workspaceStrategy,
        ...(args["no-start"] ? {} : { message: args.task }),
        ...(modelSelection ? { modelSelection } : {}),
      });
      const threadId = launched.threadId ?? launched.thread?.threadId;
      if (typeof threadId !== "string") {
        throw new Error(`t3_thread_launch returned no thread id: ${JSON.stringify(launched)}`);
      }
      // The project default may have picked an account the fence keeps local:
      // stop it before it gets anywhere, then refuse.
      const body = await session.mcp.call("t3_thread_read", {
        threadId,
        limit: 1,
        maxCharsPerItem: 1,
      });
      const instanceId = body.thread?.providerInstanceId ?? "";
      if (session.policy.blockedInstanceIds.includes(instanceId) || instanceId === "") {
        await session.mcp.call("t3_thread_interrupt", {
          threadId,
          reason: "outside the chair policy",
        });
        await session.mcp.call("t3_thread_organize", { action: "archive", threadId });
        throw new ChairRefusal(
          `refused: the new thread landed on instance '${instanceId}', outside the chair policy; it was stopped and archived`,
        );
      }
      if (!args["in-place"] && !args["no-start"]) {
        const failure = await workspaceFailure(session, threadId);
        if (failure !== undefined) {
          await session.mcp.call("t3_thread_organize", { action: "archive", threadId });
          throw new Error(
            `${failure}; the thread was archived. Check --base: it must be a branch on origin (usually main or master)`,
          );
        }
      }
      return {
        threadId,
        account: await session.accountName(instanceId),
        instanceId,
        model: body.thread?.model ?? "",
        effort: effort ?? "model default",
        workspace: args["in-place"] ? "in-place" : `worktree from origin/${base}`,
        started: !args["no-start"],
        url: await session.url(threadId),
      };
    });
  },

  async continue(session, args) {
    need(args, "thread", "task");
    const row = await session.getThread(args.thread);
    const timeoutMs = intFlag(args, "timeout-seconds", 900) * 1000;
    // `--effort` changes the thread's own setting before the turn goes out, so
    // it holds for this turn and the ones after it.
    let selection;
    if (args.effort !== undefined) {
      const config = await session.mcp.call("t3_thread_configuration", { threadId: row.id });
      selection = config.modelSelection ?? {};
      await assertEffort(session, selection.instanceId, selection.model, args.effort);
    }
    const intent = { threadId: row.id, ...(args.effort !== undefined ? { effort: args.effort } : {}) };
    return decide(session, args, intent, async (decisionId) => {
      if (selection !== undefined) {
        const others = (selection.options ?? []).filter((o) => o.id !== "effort");
        await session.mcp.call("t3_thread_configure", {
          threadId: row.id,
          modelSelection: { ...selection, options: [...others, { id: "effort", value: args.effort }] },
        });
      }
      const sent = await session.mcp.call("t3_thread_send", {
        threadId: row.id,
        message: args.task,
        mode: "queue",
        clientRequestId: decisionId,
      });
      if (args.wait) return waitOutcome(session, row.id, sent.runId, timeoutMs);
      return {
        threadId: row.id,
        started: true,
        effort: await threadEffort(session, row.id),
        url: await session.url(row.id),
      };
    });
  },

  async answer(session, args) {
    need(args, "thread", "answer");
    const row = await session.getThread(args.thread);
    const pending = await pendingQuestion(session, row.id, args.request);
    if (pending === undefined) {
      throw new ChairRefusal(`refused: thread '${row.id}' has no open question`);
    }
    const intent = { threadId: row.id, requestId: pending.requestId };
    return decide(session, args, intent, async () => {
      const answers = {};
      for (const q of pending.questions) answers[q.id] = args.answer;
      const out = await session.mcp.call("t3_pending_request_respond", {
        threadId: row.id,
        requestId: pending.requestId,
        answers,
      });
      return { threadId: row.id, requestId: pending.requestId, sequence: out.sequence ?? -1 };
    });
  },

  async approve(session, args) {
    need(args, "thread");
    const row = await session.getThread(args.thread);
    throw new ChairRefusal(
      `refused: T3's MCP cannot answer permission approvals; approve it in the T3 app: ${await session.url(row.id)}`,
    );
  },

  async interrupt(session, args) {
    need(args, "thread");
    const row = await session.getThread(args.thread);
    return decide(session, args, { threadId: row.id }, async (decisionId) => {
      const out = await session.mcp.call("t3_thread_interrupt", {
        threadId: row.id,
        reason: clip(args.why, 2000),
        clientRequestId: decisionId,
      });
      return { threadId: row.id, ...out };
    });
  },

  /** Close a thread whose work is finished, so it leaves the inbox. */
  async settle(session, args) {
    need(args, "thread");
    const row = await session.getThread(args.thread);
    const state = await stateOf(session, row);
    if (["running", "question", "approval"].includes(state.status)) {
      throw new ChairRefusal(`refused: thread '${row.id}' is ${state.status}, not finished`);
    }
    return decide(session, args, { threadId: row.id }, async () => {
      await session.mcp.call("t3_thread_organize", { action: "settle", threadId: row.id });
      return { threadId: row.id, settled: true };
    });
  },

  async wait(session, args) {
    need(args, "thread");
    const row = await session.getThread(args.thread);
    return waitOutcome(session, row.id, undefined, intFlag(args, "timeout-seconds", 900) * 1000);
  },
};

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const all = [...Object.keys(LOCAL_VERBS), ...Object.keys(VERBS)];
    if (args.help || args.verb === undefined || args.verb === "help") {
      process.stdout.write(`t3-chair <${all.join("|")}> [--env <name>] [flags]
`);
      return;
    }
    if (!all.includes(args.verb)) usage(`unknown verb: ${args.verb}`);
    // A brief is long and multi-line; a shell argument is a bad carrier for it.
    for (const name of ["task", "answer"]) {
      const file = args[`${name}-file`];
      if (file !== undefined) args[name] = await readFile(file, "utf8");
    }
    if (Object.hasOwn(LOCAL_VERBS, args.verb)) print(await LOCAL_VERBS[args.verb](args));
    else print(await VERBS[args.verb](await openSession(args), args));
  } catch (e) {
    console.error(`t3-chair: ${e?.message ?? String(e)}`);
    // exitCode, not exit(): on Windows, exiting while fetch's sockets are still
    // closing aborts Node (libuv UV_HANDLE_CLOSING) and loses the exit code.
    process.exitCode = e instanceof ChairUsage ? 2 : e instanceof ChairRefusal ? 3 : 1;
  }
}

await main();
