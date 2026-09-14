#!/usr/bin/env node
// paperclip-relay.mjs — Fase 4 do Megazord (§3a RELAY): o Paperclip OBSERVA e
// REPORTA o que o T3 faz. Read-only no T3 (event stream / projections do
// state.sqlite), HTTP no Paperclip. O Bruno vê ao vivo no cockpit os threads
// (sessões/subagents) e a atividade mais recente de cada um. Mesmo padrão do
// mirror do WhatsApp, mirando a API do Paperclip.
//
// NÃO toca o T3 (abre o sqlite em modo read-only). Idempotente: mapeia
// thread_id -> issue_id num state file; cria a issue uma vez, depois só faz
// PATCH da descrição/atividade. Espelha num projeto dedicado "T3 Mirror" pra não
// poluir o board de trabalho real.
//
// Uso: node paperclip-relay.mjs [--apply] [--days N] [--max N]
//   dry-run por padrão (mostra o que espelharia). --apply escreve no Paperclip.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const BASE = (process.env.PAPERCLIP_ROUTINES_BASE || "http://127.0.0.1:3100").replace(/\/api$/, "");
const CO = process.env.PAPERCLIP_COMPANY_ID || "47ef245e-ff23-41be-a39d-21e4ac66ed2a";
const T3_DB = process.env.T3_STATE_DB || path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
const MIRROR_PROJECT = "T3 Mirror";
const STATE = path.join(os.homedir(), ".cache", "paperclip-relay", "state.json");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const DAYS = Number(argv[argv.indexOf("--days") + 1]) || 3;
const MAX = Number(argv[argv.indexOf("--max") + 1]) || 25;

// sqlite: tenta better-sqlite3 do t3code; senão, node:sqlite (Node >=22).
function openDb() {
  const require = createRequire(import.meta.url);
  try {
    const Database = require("better-sqlite3");
    const db = new Database(T3_DB, { readonly: true, fileMustExist: true });
    return { all: (q, ...a) => db.prepare(q).all(...a) };
  } catch {
    /* tenta node:sqlite */
  }
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(T3_DB, { readOnly: true });
    return { all: (q, ...a) => db.prepare(q).all(...a) };
  } catch (e) {
    throw new Error(`sem driver sqlite (better-sqlite3 ou node:sqlite): ${e.message}`);
  }
}

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${String(t).slice(0, 140)}`);
  return j;
}
const arr = (d, ...k) => (Array.isArray(d) ? d : (k.map((x) => d?.[x]).find(Array.isArray) ?? []));

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return { threads: {} };
  }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

async function ensureMirrorProject() {
  const projects = arr(await api("GET", `/api/companies/${CO}/projects`), "projects", "data");
  const found = projects.find((p) => (p.name || "").trim() === MIRROR_PROJECT);
  if (found) return found.id;
  if (!APPLY) return "(criaria projeto T3 Mirror)";
  const p = await api("POST", `/api/companies/${CO}/projects`, {
    name: MIRROR_PROJECT,
    description:
      "Espelho read-only vivo das sessões/threads do T3 (relay Megazord §3a). Não editar — gerado.",
  });
  return p.id || p.project?.id;
}

function mirrorBody(t, act) {
  const flags = [];
  if (t.pending_approval_count)
    flags.push(`⏳ ${t.pending_approval_count} aprovação(ões) pendente(s)`);
  if (t.pending_user_input_count)
    flags.push(`✋ ${t.pending_user_input_count} input(s) pendente(s)`);
  if (t.has_actionable_proposed_plan) flags.push("📋 plano proposto");
  return [
    `**Thread T3** \`${t.thread_id}\``,
    `Atualizado: ${t.updated_at}${t.branch ? ` · branch \`${t.branch}\`` : ""}${t.runtime_mode ? ` · ${t.runtime_mode}` : ""}`,
    flags.length ? `\nEstado: ${flags.join(" · ")}` : "",
    act
      ? `\n**Última atividade** (${act.kind || "—"}${act.tone ? `/${act.tone}` : ""}):\n${(act.summary || "").slice(0, 500)}`
      : "",
    `\n_espelho relay — ${new Date().toISOString().slice(0, 16)}_`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const db = openDb();
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const threads = db.all(
    `SELECT * FROM projection_threads
     WHERE deleted_at IS NULL AND archived_at IS NULL
       AND updated_at >= ? AND title NOT LIKE '%apagar%'
     ORDER BY updated_at DESC LIMIT ?`,
    since,
    MAX,
  );
  const state = loadState();
  const projectId = await ensureMirrorProject();

  console.log(`=== PAPERCLIP-RELAY (T3 -> cockpit) ===`);
  console.log(
    `threads ativos (${DAYS}d, max ${MAX}): ${threads.length} | projeto: ${projectId} | modo: ${APPLY ? "APPLY" : "DRY-RUN"}\n`,
  );

  let created = 0,
    updated = 0;
  for (const t of threads) {
    const acts = db.all(
      `SELECT kind,tone,summary,created_at,sequence FROM projection_thread_activities
       WHERE thread_id=? ORDER BY sequence DESC LIMIT 1`,
      t.thread_id,
    );
    const act = acts[0];
    const title = `[T3] ${(t.title || t.thread_id).slice(0, 70)}`;
    const body = mirrorBody(t, act);
    const rec = state.threads[t.thread_id];
    if (!rec) {
      console.log(`  + novo: ${title}`);
      if (APPLY && typeof projectId === "string" && projectId.length > 20) {
        const iss = await api("POST", `/api/companies/${CO}/issues`, {
          title,
          description: body,
          projectId,
        });
        state.threads[t.thread_id] = {
          issueId: iss.id || iss.issue?.id,
          lastSeq: act?.sequence || 0,
        };
        created++;
      }
    } else if (!act || act.sequence > (rec.lastSeq || 0)) {
      console.log(`  ~ update: ${title}`);
      if (APPLY && rec.issueId) {
        await api("PATCH", `/api/issues/${rec.issueId}`, { description: body });
        rec.lastSeq = act?.sequence || rec.lastSeq;
        updated++;
      }
    }
  }
  if (APPLY) saveState(state);
  console.log(`\nDONE. criadas=${created} atualizadas=${updated}${APPLY ? "" : " (dry-run)"}`);
}
main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
