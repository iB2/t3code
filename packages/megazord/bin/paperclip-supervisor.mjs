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

async function sweep({ stuckMs = 30 * 60_000, staleMs = 26 * 3_600_000 } = {}) {
  const now = Date.now();
  const findings = [];
  const timed = async (fn) => {
    const t0 = Date.now();
    try {
      return { ok: true, ms: Date.now() - t0, value: await fn() };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
    }
  };

  const orch = await timed(() => orchGet("/api/orchestration/snapshot"));
  const rout = await timed(() => routinesApi("GET", `/companies/${COMPANY_ID}/routines`));
  if (!orch.ok)
    findings.push({
      severity: "critical",
      area: "backend",
      message: `orchestration (:3773) down: ${orch.error}`,
    });
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

  if (report.findings.length > 0) {
    const lines = report.findings.map(
      (f) => `${f.severity === "critical" ? "🔴" : "⚠️"} [${f.area}] ${f.message}`,
    );
    const healedLine = report.healed.length
      ? `\n\nself-heal: ${report.healed.map((h) => `${h.routine} retry=${h.retried}`).join("; ")}`
      : "";
    await alert(
      `[paperclip supervisor] ${report.criticals} crítico(s), ${report.findings.length} finding(s):\n` +
        lines.join("\n") +
        healedLine,
    );
  }
  console.log(JSON.stringify(report));
  // Exit 0 whenever the sweep RAN (healthy or with findings — findings are
  // delivered via the alert + health.json, not the exit code). A dead-man's-switch
  // watching this task wants 0 = "it ran"; only a real run failure (the catch
  // below) is non-zero, so findings don't get mistaken for the monitor failing.
  // exitCode (not process.exit): the token mint spawns a child process, and
  // forcing teardown while its handle closes trips a libuv assertion on Windows.
  process.exitCode = 0;
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 3;
});
