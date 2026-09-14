#!/usr/bin/env node
/**
 * paperclip-mcp — an MCP (stdio) server that lets an agent OPERATE the local
 * Paperclip/T3 orchestration plane as tools: run work (spawn an agent as a
 * routed thread), read the live snapshot, check/continue/answer threads, and
 * inspect accounts+quota. Wraps the proven `MegazordT3DispatchClient` (same
 * origin-resolve + scoped-token-mint + HTTP path that `t3-dispatch` uses).
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdio (MCP stdio transport).
 * The token is minted at runtime and NEVER written to disk.
 *
 * This is Track A of the Paperclip control-plane (see
 * capiva-factory/PAPERCLIP-CONTROL-PLANE-SPEC.md). Routines/scheduling land
 * NATIVELY on top of this (Track B, Bruno's decision 2026-09-14).
 *
 * @module megazord/bin/paperclip-mcp
 */
import { MegazordDispatchError, MegazordT3DispatchClient } from "../src/dispatch.ts";

const SERVER_INFO = { name: "paperclip", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const client = new MegazordT3DispatchClient({});

// ── HTTP helper for read endpoints the client does not wrap yet ──────────────
async function orchGet(path) {
  const origin = await client.origin();
  const token = await client.token();
  const res = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Routines/org live on the isolated company instance (Paperclip acp-engine),
//    a LOCAL unauthenticated HTTP API (default :3100). The 31 native routines
//    were created by capiva-factory/scripts/native-routines-setup.mjs, all with
//    their schedule trigger DISABLED (Bruno's credit-safety mandate). Enabling a
//    routine is Bruno's explicit decision — never auto-enable. ─────────────────
const ROUTINES_BASE = process.env.PAPERCLIP_ROUTINES_BASE ?? "http://127.0.0.1:3100/api";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "47ef245e-ff23-41be-a39d-21e4ac66ed2a";

async function routinesApi(method, path, body) {
  const res = await fetch(`${ROUTINES_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

function asRoutineList(d) {
  return Array.isArray(d) ? d : (d.routines ?? d.data ?? []);
}

// ── Tools: name -> { description, inputSchema, handler(args) -> object } ──────
const TOOLS = {
  paperclip_run: {
    description:
      "Run work on Paperclip: spawn an agent as a routed T3 thread (a task) and " +
      "start its first turn. Returns the thread id + cockpit link. Use for ad-hoc " +
      "runs and for kicking off any project work.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The first-turn prompt / instruction." },
        scope: {
          type: "string",
          enum: ["general", "ssb"],
          description: "NDA/quota scope (default general).",
        },
        driver: {
          type: "string",
          enum: ["codex", "claudeAgent"],
          description: "Force a harness (optional).",
        },
        model: { type: "string", description: "Pin the thread model (optional)." },
        project_title: { type: "string", description: "Target project by exact title (optional)." },
        title: { type: "string", description: "Thread title shown in the cockpit (optional)." },
        runtime: { type: "string", description: "Runtime mode (default full-access)." },
      },
      required: ["task"],
    },
    handler: async (a) => {
      const out = await client.dispatch({
        task: a.task,
        scope: a.scope ?? "general",
        mode: "full",
        runtimeMode: a.runtime ?? "full-access",
        ...(a.driver ? { driver: a.driver } : {}),
        ...(a.model ? { model: a.model } : {}),
        ...(a.project_title ? { projectTitle: a.project_title } : {}),
        ...(a.title ? { title: a.title } : {}),
      });
      return {
        threadId: out.threadId,
        url: out.url,
        instance: out.instanceId,
        driver: out.driver,
        model: out.model,
        why: out.decision?.reason,
      };
    },
  },

  paperclip_snapshot: {
    description:
      "Read the live orchestration snapshot: every project and thread (task) with " +
      "its state. The foundation for monitoring / resilience (stuck or never-run work).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => await orchGet("/api/orchestration/snapshot"),
  },

  paperclip_thread_status: {
    description: "Check whether a thread (task) is still open/alive.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
    handler: async (a) => {
      const origin = await client.origin();
      const token = await client.token();
      const open = await client.threadIsOpen(origin, token, a.threadId);
      return { threadId: a.threadId, open };
    },
  },

  paperclip_thread_continue: {
    description:
      "Send a follow-up turn to an EXISTING thread and wait for the reply " +
      "(continue a conversation instead of spawning a new task).",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        message: { type: "string" },
        timeout_seconds: { type: "number", description: "Max wait (default 900)." },
      },
      required: ["threadId", "message"],
    },
    handler: async (a) => {
      const out = await client.sendTurnAndAwait({
        threadId: a.threadId,
        task: a.message,
        ...(a.timeout_seconds ? { timeoutMs: a.timeout_seconds * 1000 } : {}),
      });
      return out;
    },
  },

  paperclip_accounts: {
    description:
      "Inspect the org side you can see locally: provider instances (the agents/" +
      "accounts) and their quota/usage. Read-only.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      accounts: await client.accounts(),
      usage: await client.usage().catch((e) => `usage unavailable: ${String(e).slice(0, 120)}`),
    }),
  },

  paperclip_routine_list: {
    description:
      "List the native Paperclip routines (recurring work) of the company, with " +
      "each one's status and whether its schedule trigger is enabled (i.e. will " +
      "auto-fire). Read-only. Foundation for the resilience monitor.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const rs = asRoutineList(await routinesApi("GET", `/companies/${COMPANY_ID}/routines`));
      return {
        total: rs.length,
        routines: rs.map((r) => {
          const sched = (r.triggers ?? []).filter((t) => t.kind === "schedule");
          return {
            id: r.id,
            title: r.title,
            status: r.status,
            scheduleEnabled: sched.some((t) => t.enabled),
            cron: sched.map((t) => t.cronExpression).join(", ") || null,
          };
        }),
      };
    },
  },

  paperclip_routine_get: {
    description: "Get one routine in full (triggers, variables, assignee, policies).",
    inputSchema: {
      type: "object",
      properties: { routineId: { type: "string" } },
      required: ["routineId"],
    },
    handler: async (a) => await routinesApi("GET", `/routines/${a.routineId}`),
  },
};

// ── JSON-RPC / MCP plumbing ──────────────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function result(id, res) {
  send({ jsonrpc: "2.0", id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // no reply
  if (method === "ping") return result(id, {});
  if (method === "tools/list") {
    return result(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (!tool) return error(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.handler(params.arguments ?? {});
      return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      const detail =
        e instanceof MegazordDispatchError && e.detail?.responseText
          ? ` (${e.detail.responseText})`
          : "";
      return result(id, {
        content: [{ type: "text", text: `error: ${e?.message ?? String(e)}${detail}` }],
        isError: true,
      });
    }
  }
  if (id !== undefined) return error(id, -32601, `method not found: ${method}`);
}

// newline-delimited JSON on stdin
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg?.id !== undefined) error(msg.id, -32603, String(e?.stack ?? e));
    });
  }
});
process.stdin.on("end", () => process.exit(0));
