#!/usr/bin/env node
/**
 * paperclip-supervisor — the resilience loop of the Paperclip control-plane
 * (Track C). Runs a health sweep, writes a report, and ALERTS Bruno on the
 * WhatsApp control group when something is wrong. Standalone on purpose: it must
 * detect problems even when the agent session is down, so it depends on nothing
 * but the two local backends + the WhatsApp bridge send endpoint.
 *
 * Schedule it (Windows task, every ~5min) like the _health/manifest.yaml
 * dead-man's-switch. Exit 0 = healthy, 1 = findings, 2 = a backend is down.
 *
 * Flags:
 *   --dry-run   print the alert instead of sending it (for testing)
 *   --heal      attempt safe self-heal (retry a routine whose last run FAILED).
 *               OFF by default — retrying costs credit, so it is opt-in.
 *
 * @module megazord/bin/paperclip-supervisor
 */
import { MegazordT3DispatchClient } from "../src/dispatch.ts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";

const ROUTINES_BASE = process.env.PAPERCLIP_ROUTINES_BASE ?? "http://127.0.0.1:3100/api";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "47ef245e-ff23-41be-a39d-21e4ac66ed2a";
const ALERT_CHAT = process.env.PAPERCLIP_ALERT_CHAT ?? "120363428713578541@g.us";
const BRIDGE_URL = process.env.WHATSAPP_API_URL ?? "http://localhost:8080/api";
const BRIDGE_TOKEN_FILE =
  process.env.WHATSAPP_BRIDGE_TOKEN_FILE ??
  nodePath.join(
    os.homedir(),
    "Documents/DevProjects/whatsapp-mcp/whatsapp-bridge/store/.bridge-token",
  );
const REPORT_DIR = nodePath.join(os.homedir(), ".cache/paperclip-supervisor");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const HEAL = argv.includes("--heal");

const client = new MegazordT3DispatchClient({});

async function orchGet(path) {
  const origin = await client.origin();
  const token = await client.token();
  const res = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}
async function routinesApi(method, path, body) {
  const res = await fetch(`${ROUTINES_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
  return res.json();
}
const asList = (d) => (Array.isArray(d) ? d : (d?.routines ?? d?.data ?? []));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed(fn) {
  const t0 = Date.now();
  try {
    return { ok: true, ms: Date.now() - t0, value: await fn() };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// A check that fails once under machine load (mint subprocess contention, a slow
// backend) shouldn't page anyone. Try twice, short backoff between, before a
// check counts as failed. Only fires the alert path if BOTH attempts fail.
const RETRY_BACKOFF_MS = 2_500;
async function timedWithRetry(
  fn,
  { attempts = 2, backoffMs = RETRY_BACKOFF_MS, wait = sleep } = {},
) {
  let result;
  for (let i = 0; i < attempts; i++) {
    result = await timed(fn);
    if (result.ok) return result;
    if (i < attempts - 1) await wait(backoffMs);
  }
  return result;
}

const PROBE_TIMEOUT_MS = 5_000;
/** Cheap, unauthenticated liveness probe: does the origin answer at all? Used to
 * tell "backend is actually down" apart from "the token mint was slow/timed out
 * while the server kept serving requests" — the latter is not a critical. */
async function probeOrigin(origin, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/`, { signal: controller.signal });
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, error: String(e?.message ?? e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Classify an orchestration check failure using the origin probe result. */
function classifyOrchFailure(orch, probe) {
  if (probe.reachable) {
    return {
      severity: "warn",
      area: "backend",
      message: `orchestration (:3773) mint lento (${orch.ms}ms) — backend responde (HTTP ${probe.status}): ${orch.error}`,
    };
  }
  return {
    severity: "critical",
    area: "backend",
    message: `orchestration (:3773) down: ${orch.error}`,
  };
}

async function sweep({ stuckMs = 30 * 60_000, staleMs = 26 * 3_600_000 } = {}) {
  const now = Date.now();
  const findings = [];

  const orch = await timedWithRetry(() => orchGet("/api/orchestration/snapshot"));
  const rout = await timedWithRetry(() => routinesApi("GET", `/companies/${COMPANY_ID}/routines`));
  if (!orch.ok) {
    let probe;
    try {
      probe = await probeOrigin(await client.origin());
    } catch (e) {
      probe = { reachable: false, error: String(e?.message ?? e).slice(0, 200) };
    }
    findings.push(classifyOrchFailure(orch, probe));
  }
  if (!rout.ok)
    findings.push({
      severity: "critical",
      area: "backend",
      message: `routines (:3100) down: ${rout.error}`,
    });

  const healed = [];
  if (rout.ok) {
    const rs = asList(rout.value);
    const enabled = rs.filter((r) =>
      (r.triggers ?? []).some((t) => t.kind === "schedule" && t.enabled),
    );
    for (const r of enabled) {
      const runs = await timed(() => routinesApi("GET", `/routines/${r.id}/runs?limit=5`));
      if (!runs.ok) continue;
      const list = asList(runs.value);
      const last = list[0];
      if (!last) {
        findings.push({
          severity: "warn",
          area: "routine",
          message: `${r.title}: enabled but never ran`,
        });
        continue;
      }
      const failed = last.status === "failed" || last.failureReason;
      const started = Date.parse(last.completedAt ?? last.createdAt ?? last.triggeredAt ?? "");
      if (failed) {
        findings.push({
          severity: "warn",
          area: "routine",
          message: `${r.title}: last run failed (${last.failureReason ?? last.status})`,
        });
        if (HEAL) {
          const retry = await timed(() =>
            routinesApi("POST", `/routines/${r.id}/run`, { source: "manual" }),
          );
          healed.push({ routine: r.title, retried: retry.ok, runId: retry.value?.id });
        }
      } else if (Number.isFinite(started) && now - started > staleMs) {
        findings.push({
          severity: "warn",
          area: "routine",
          message: `${r.title}: no completed run in ${Math.round((now - started) / 3_600_000)}h`,
        });
      }
    }
  }

  if (orch.ok) {
    const threads = [];
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === "object") {
        if (typeof o.threadId === "string" || (o.id && o.title && o.state)) threads.push(o);
        Object.values(o).forEach(walk);
      }
    };
    walk(orch.value);
    for (const t of threads) {
      const st = t.state ?? t.status ?? "unknown";
      const ts = Date.parse(t.latestActivityAt ?? t.updatedAt ?? t.createdAt ?? "");
      if (["running", "starting"].includes(st) && Number.isFinite(ts) && now - ts > stuckMs) {
        findings.push({
          severity: "warn",
          area: "thread",
          message: `thread ${String(t.threadId ?? t.id).slice(0, 8)} stuck in '${st}' ${Math.round((now - ts) / 60_000)}min`,
        });
      }
    }
  }

  const criticals = findings.filter((f) => f.severity === "critical").length;
  return {
    checkedAt: new Date().toISOString(),
    healthy: criticals === 0 && findings.length === 0,
    criticals,
    findings,
    healed,
    backends: { orchestration: orch.ok, routines: rout.ok },
  };
}

async function alert(text) {
  if (DRY_RUN) {
    console.log("[dry-run] would alert:\n" + text);
    return;
  }
  const token = (await readFile(BRIDGE_TOKEN_FILE, "utf8").catch(() => "")).trim();
  const res = await fetch(`${BRIDGE_URL}/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ recipient: ALERT_CHAT, message: text }),
  });
  if (!res.ok) throw new Error(`alert send failed: HTTP ${res.status}`);
}

async function main() {
  const report = await sweep();
  await mkdir(REPORT_DIR, { recursive: true }).catch(() => {});
  await writeFile(nodePath.join(REPORT_DIR, "health.json"), JSON.stringify(report, null, 2)).catch(
    () => {},
  );

  // Dedup/backoff: NUNCA re-alerta o mesmo problema a cada sweep (isso inundava
  // o grupo de controle enquanto um backend ficava fora). Alerta só quando o
  // conjunto de findings MUDA, ou como lembrete no máx 1x/h se persistir; e
  // manda UM aviso de recuperação quando volta ao saudável.
  const stateFile = nodePath.join(REPORT_DIR, "alert-state.json");
  const prev = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}")) || {};
  const BACKOFF_MS = 60 * 60_000;
  const now = Date.now();
  if (report.findings.length > 0) {
    const sig = report.findings
      .map((f) => `${f.severity}:${f.area}:${f.message}`)
      .sort()
      .join("|");
    const changed = prev.sig !== sig;
    const stale = !prev.lastAlertAt || now - prev.lastAlertAt > BACKOFF_MS;
    if (changed || stale) {
      const lines = report.findings.map(
        (f) => `${f.severity === "critical" ? "🔴" : "⚠️"} [${f.area}] ${f.message}`,
      );
      const healedLine = report.healed.length
        ? `\n\nself-heal: ${report.healed.map((h) => `${h.routine} retry=${h.retried}`).join("; ")}`
        : "";
      const since = changed ? now : prev.since || now;
      const repeat =
        !changed && stale ? ` (persiste há ${Math.round((now - since) / 60000)}min)` : "";
      await alert(
        `[paperclip supervisor] ${report.criticals} crítico(s), ${report.findings.length} finding(s)${repeat}:\n` +
          lines.join("\n") +
          healedLine,
      );
      await writeFile(stateFile, JSON.stringify({ sig, lastAlertAt: now, since })).catch(() => {});
    }
  } else if (prev.sig) {
    // estava alertando e recuperou: um aviso, depois silêncio.
    await alert("[paperclip supervisor] ✅ recuperado — backends OK.").catch(() => {});
    await writeFile(stateFile, "{}").catch(() => {});
  }
  console.log(JSON.stringify(report));
  // Set exitCode (don't process.exit): the token mint spawns a child process, and
  // forcing teardown while its handle closes trips a libuv assertion on Windows.
  // Letting the event loop drain closes handles cleanly.
  process.exitCode = report.criticals > 0 ? 2 : report.findings.length > 0 ? 1 : 0;
}

// Guarded so the module can be `import`ed (for unit tests) without running the
// real sweep against live backends / sending an alert.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exitCode = 3;
  });
}

export { timed, timedWithRetry, probeOrigin, classifyOrchFailure, sweep };
