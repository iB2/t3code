#!/usr/bin/env node
/**
 * t3-chair — the one command an external orchestrator (a "chair") uses to run the
 * local T3 without the GUI: see what needs a decision, read a thread, act on it.
 *
 * The other megazord CLIs each do one thing for a caller that already knows which
 * thread it wants. A chair starts from nothing, so this adds the missing reads
 * (`projects`, `inbox`, `threads`, `read`) and puts every write behind the same two
 * rules:
 *
 *  - **The fence.** `<base-dir>/chair/policy.json` names the projects and provider
 *    instances that stay on this machine. A thread outside the policy is not
 *    listed, not readable and not writable. No policy file means no access.
 *  - **The log.** Every write needs `--why` and is recorded in
 *    `<base-dir>/chair/decisions.jsonl` BEFORE it is dispatched, then again with
 *    its outcome, so a decision that went wrong can be found and a started job can
 *    always be stopped.
 *
 * Output is always JSON on stdout. Exit 3 is a refusal (fence, bad target, missing
 * `--why`), 2 is a usage error, 1 is a failure.
 *
 * Usage:
 *   node bin/t3-chair.mjs projects
 *   node bin/t3-chair.mjs inbox [--project <id|title>]
 *   node bin/t3-chair.mjs threads --project <id|title> [--status <s>] [--limit 30]
 *   node bin/t3-chair.mjs read --thread <id> [--messages 6] [--chars 4000]
 *   node bin/t3-chair.mjs open --project <id|title> --title "<t>" --task "<brief>" --why "<reason>"
 *        [--instance <id>] [--model <id>] [--runtime <mode>] [--no-start]
 *   node bin/t3-chair.mjs continue --thread <id> --task "<text>" --why "<reason>"
 *        [--wait] [--timeout-seconds 900]
 *   node bin/t3-chair.mjs answer --thread <id> --answer "<text>" --why "<reason>" [--request <id>]
 *   node bin/t3-chair.mjs approve --thread <id> --request <id> --decision accept|decline --why "<reason>"
 *   node bin/t3-chair.mjs interrupt --thread <id> --why "<reason>"
 *   node bin/t3-chair.mjs wait --thread <id> [--since <iso>] [--timeout-seconds 900]
 *   node bin/t3-chair.mjs log [--tail 20]
 *
 * The token is minted at runtime and NEVER written to disk.
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
  classifyThread,
  parsePolicy,
  projectVisible,
  threadVisible,
} from "../src/chair.ts";
import {
  MegazordDispatchError,
  MegazordT3DispatchClient,
  defaultBaseDir,
} from "../src/dispatch.ts";

const VALUE_FLAGS = new Set([
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
  "model",
  "runtime",
  "answer",
  "request",
  "decision",
  "since",
  "timeout-seconds",
  "tail",
  "base-dir",
]);
const BOOL_FLAGS = new Set(["wait", "no-start", "help"]);
const APPROVAL_DECISIONS = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"];
const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"];

function usage(message) {
  console.error(`t3-chair: ${message}`);
  process.exit(2);
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

async function loadPolicy(baseDir) {
  const file = nodePath.join(baseDir, "chair", "policy.json");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new ChairRefusal(`refused: no chair policy at ${file}; the chair has no access`);
  }
  try {
    return parsePolicy(JSON.parse(raw));
  } catch (e) {
    if (e instanceof ChairRefusal) throw e;
    throw new ChairRefusal(`refused: chair policy at ${file} is not valid JSON`);
  }
}

/** Everything a verb needs: the client, the fence and the live snapshot. */
async function openSession(args) {
  const baseDir = args["base-dir"] ?? defaultBaseDir();
  const policy = await loadPolicy(baseDir);
  const client = new MegazordT3DispatchClient({ baseDir });
  const [origin, token, environmentId] = await Promise.all([
    client.origin(),
    client.token(),
    client.environmentId(),
  ]);
  const get = async (path) => {
    const res = await fetch(`${origin}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
    return res.json();
  };
  const post = async (command) => {
    const res = await fetch(`${origin}/api/orchestration/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`dispatch ${command.type} rejected: ${res.status} ${res.statusText}`);
    }
    const body = await res.json().catch(() => ({}));
    return typeof body?.sequence === "number" ? body.sequence : -1;
  };
  const snapshot = await get("/api/orchestration/snapshot");
  const projects = (snapshot.projects ?? []).filter((p) => projectVisible(policy, p));
  const projectIds = new Set(projects.map((p) => p.id));
  const threads = (snapshot.threads ?? []).filter(
    (t) => projectIds.has(t.projectId) && threadVisible(policy, t),
  );
  const url = (threadId) => `${origin}/${environmentId}/${threadId}`;
  return { baseDir, policy, client, get, post, projects, threads, url };
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

/** The snapshot row of a thread the chair may touch, or a refusal. */
function resolveThread(session, threadId) {
  const wanted = String(threadId).trim();
  const row = session.threads.find((t) => t.id === wanted);
  if (row === undefined) {
    throw new ChairRefusal(`refused: no thread '${wanted}' within the chair policy`);
  }
  return row;
}

async function threadDetail(session, row) {
  const body = await session.get(`/api/orchestration/threads/${encodeURIComponent(row.id)}`);
  const detail = body?.thread;
  if (detail === null || typeof detail !== "object") {
    throw new Error(`thread ${row.id} has no detail on the live server`);
  }
  return detail;
}

function summarize(session, row, state) {
  const project = session.projects.find((p) => p.id === row.projectId);
  return {
    threadId: row.id,
    project: project?.title ?? "",
    title: row.title,
    status: state.status,
    updatedAt: row.updatedAt,
    instanceId: row.modelSelection?.instanceId ?? "",
    model: row.modelSelection?.model ?? "",
    runtimeMode: row.runtimeMode,
    ...(state.pendingInput ? { question: state.pendingInput } : {}),
    ...(state.pendingApprovals ? { approvals: state.pendingApprovals } : {}),
    url: session.url(row.id),
  };
}

/** A thread's state; the detail is only fetched when the snapshot says it is live. */
async function stateOf(session, row) {
  const quick = classifyThread(row, []);
  if (quick.status !== "running") return quick;
  const detail = await threadDetail(session, row);
  return classifyThread(detail, Array.isArray(detail.activities) ? detail.activities : []);
}

// ── decision log ────────────────────────────────────────────────────────────

async function logLine(session, entry) {
  const dir = nodePath.join(session.baseDir, "chair");
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
  await logLine(session, { id, phase: "intent", verb: args.verb, why: args.why, ...intent });
  try {
    const result = await action();
    await logLine(session, { id, phase: "result", ok: true });
    return { decisionId: id, ...result };
  } catch (e) {
    await logLine(session, { id, phase: "result", ok: false, error: String(e?.message ?? e) });
    throw e;
  }
}

// ── verbs ───────────────────────────────────────────────────────────────────

const VERBS = {
  async projects(session) {
    return session.projects.map((p) => {
      const counts = {};
      for (const t of session.threads.filter((x) => x.projectId === p.id)) {
        const s = classifyThread(t, []).status;
        counts[s] = (counts[s] ?? 0) + 1;
      }
      return { projectId: p.id, title: p.title, workspaceRoot: p.workspaceRoot, threads: counts };
    });
  },

  async inbox(session, args) {
    const scope = args.project ? resolveProject(session, args.project).id : undefined;
    const rows = session.threads.filter(
      (t) => (scope === undefined || t.projectId === scope) && (t.archivedAt ?? null) === null,
    );
    const needsDecision = [];
    const running = [];
    for (const row of rows) {
      const state = await stateOf(session, row);
      if (NEEDS_DECISION.includes(state.status)) needsDecision.push(summarize(session, row, state));
      else if (state.status === "running") running.push(summarize(session, row, state));
    }
    const byRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
    return { needsDecision: needsDecision.sort(byRecent), running: running.sort(byRecent) };
  },

  async threads(session, args) {
    need(args, "project");
    const project = resolveProject(session, args.project);
    const limit = intFlag(args, "limit", 30);
    const out = [];
    const rows = session.threads
      .filter((t) => t.projectId === project.id)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const row of rows) {
      const state = await stateOf(session, row);
      if (args.status !== undefined && state.status !== args.status) continue;
      out.push(summarize(session, row, state));
      if (out.length >= limit) break;
    }
    return out;
  },

  async read(session, args) {
    need(args, "thread");
    const row = resolveThread(session, args.thread);
    const detail = await threadDetail(session, row);
    const state = classifyThread(detail, Array.isArray(detail.activities) ? detail.activities : []);
    const count = intFlag(args, "messages", 6);
    const chars = intFlag(args, "chars", 4000);
    const messages = (Array.isArray(detail.messages) ? detail.messages : [])
      .filter((m) => m.streaming !== true && String(m.text ?? "").trim() !== "")
      .slice(-count)
      .map((m) => ({ role: m.role, at: m.createdAt, text: clip(m.text, chars) }));
    return { ...summarize(session, row, state), branch: row.branch, messages };
  },

  async open(session, args) {
    need(args, "project", "title", "task");
    const project = resolveProject(session, args.project);
    if (args.instance !== undefined) assertInstanceAllowed(session.policy, args.instance);
    const runtimeMode = args.runtime ?? "full-access";
    if (!RUNTIME_MODES.includes(runtimeMode)) usage(`--runtime must be one of ${RUNTIME_MODES}`);
    return decide(session, args, { projectId: project.id, title: args.title }, async () => {
      const out = await session.client.dispatch({
        task: args.task,
        scope: "general",
        projectId: project.id,
        title: args.title,
        runtimeMode,
        mode: args["no-start"] ? "create" : "full",
        ...(args.instance !== undefined ? { instance: args.instance } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
      });
      assertInstanceAllowed(session.policy, out.instanceId);
      return {
        threadId: out.threadId,
        instanceId: out.instanceId,
        model: out.model,
        started: out.mode === "full",
        url: out.url,
      };
    });
  },

  async continue(session, args) {
    need(args, "thread", "task");
    const row = resolveThread(session, args.thread);
    const timeoutMs = intFlag(args, "timeout-seconds", 900) * 1000;
    return decide(session, args, { threadId: row.id }, async () => {
      const turn = {
        threadId: row.id,
        task: args.task,
        scope: "general",
        runtimeMode: row.runtimeMode,
        interactionMode: row.interactionMode,
      };
      if (args.wait) {
        const out = await session.client.sendTurnAndAwait({ ...turn, timeoutMs });
        return {
          threadId: row.id,
          state: out.state,
          timedOut: out.timedOut,
          text: out.text,
          ...(out.pendingInput ? { question: out.pendingInput } : {}),
          url: out.url,
        };
      }
      const out = await session.client.dispatch({ ...turn, mode: "full" });
      return { threadId: row.id, started: true, url: out.url };
    });
  },

  async answer(session, args) {
    need(args, "thread", "answer");
    const row = resolveThread(session, args.thread);
    const state = await stateOf(session, row);
    const requestId = args.request ?? state.pendingInput?.requestId;
    if (requestId === undefined) {
      throw new ChairRefusal(`refused: thread '${row.id}' has no open question`);
    }
    return decide(session, args, { threadId: row.id, requestId }, async () => {
      const sequence = await session.client.respondUserInput({
        threadId: row.id,
        requestId,
        answer: args.answer,
      });
      return { threadId: row.id, requestId, sequence };
    });
  },

  async approve(session, args) {
    need(args, "thread", "request", "decision");
    if (!APPROVAL_DECISIONS.includes(args.decision)) {
      usage(`--decision must be one of ${APPROVAL_DECISIONS}`);
    }
    const row = resolveThread(session, args.thread);
    const state = await stateOf(session, row);
    if (!(state.pendingApprovals ?? []).some((a) => a.requestId === args.request)) {
      throw new ChairRefusal(`refused: thread '${row.id}' has no open approval '${args.request}'`);
    }
    const intent = { threadId: row.id, requestId: args.request, decision: args.decision };
    return decide(session, args, intent, async () => {
      const sequence = await session.post({
        type: "thread.approval.respond",
        commandId: randomUUID(),
        threadId: row.id,
        requestId: args.request,
        decision: args.decision,
        createdAt: new Date().toISOString(),
      });
      return { threadId: row.id, requestId: args.request, sequence };
    });
  },

  async interrupt(session, args) {
    need(args, "thread");
    const row = resolveThread(session, args.thread);
    return decide(session, args, { threadId: row.id }, async () => {
      const sequence = await session.post({
        type: "thread.turn.interrupt",
        commandId: randomUUID(),
        threadId: row.id,
        createdAt: new Date().toISOString(),
      });
      return { threadId: row.id, sequence };
    });
  },

  async wait(session, args) {
    need(args, "thread");
    const row = resolveThread(session, args.thread);
    const out = await session.client.awaitTurn({
      threadId: row.id,
      timeoutMs: intFlag(args, "timeout-seconds", 900) * 1000,
      ...(args.since !== undefined ? { since: args.since } : {}),
    });
    return {
      threadId: row.id,
      state: out.state,
      timedOut: out.timedOut,
      text: out.text,
      ...(out.pendingInput ? { question: out.pendingInput } : {}),
      url: out.url,
    };
  },

  async log(session, args) {
    const tail = intFlag(args, "tail", 20);
    let raw = "";
    try {
      raw = await readFile(nodePath.join(session.baseDir, "chair", "decisions.jsonl"), "utf8");
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.verb === undefined || args.verb === "help") {
    process.stdout.write(`t3-chair <${Object.keys(VERBS).join("|")}> [flags]\n`);
    return;
  }
  const verb = Object.hasOwn(VERBS, args.verb) ? VERBS[args.verb] : undefined;
  if (verb === undefined) usage(`unknown verb: ${args.verb}`);
  try {
    print(await verb(await openSession(args), args));
  } catch (e) {
    if (e instanceof ChairRefusal || (e instanceof MegazordDispatchError && e.refusal)) {
      console.error(`t3-chair: ${e.message}`);
      process.exit(3);
    }
    console.error(`t3-chair: ${e?.message ?? String(e)}`);
    process.exit(1);
  }
}

await main();
