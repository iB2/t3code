/**
 * Observe — richer projection of a live Paperclip issue into the thread view.
 *
 * `taskState.ts` collapses a Paperclip issue to a coarse
 * {@link MegazordTaskState} (is it working / stalled / finished). That drives the
 * thread lifecycle, but the DISTRIBUTION-PLAN wants the cockpit to show what the
 * org is actually DOING in real time: "status, fase, agente, custo/risco se
 * disponível". This module extracts those extra, best-effort signals from the
 * issue object and formats them into the human text the driver surfaces.
 *
 * Everything here is defensive: Paperclip's issue shape is not a contract we own,
 * so each field is probed and simply omitted when absent. Never throws.
 *
 * @module megazord/observe
 */
import { issueStatusToTaskState, type MegazordTaskState } from "./taskState.ts";

/** A best-effort, human-facing snapshot of a running thread's execution. */
export interface MegazordObservation {
  readonly state: MegazordTaskState;
  /** The raw upstream status string. */
  readonly rawStatus: string;
  /** Lifecycle phase, when the issue exposes one (e.g. "review", "dispatch"). */
  readonly phase?: string;
  /** The agent/assignee currently on it. */
  readonly agent?: string;
  /** Cost/usage signal, when present (free-form, e.g. "$0.42" or "12k tok"). */
  readonly cost?: string;
  /** Risk/tier signal, when present (free-form, e.g. "tier 2" or "high"). */
  readonly risk?: string;
}

function firstString(
  obj: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** Pull a nested assignee/agent name out of the common Paperclip shapes. */
function readAgent(body: Record<string, unknown>): string | undefined {
  const flat = firstString(body, ["assignee", "agent", "worker", "owner"]);
  if (flat !== undefined) return flat;
  const nested = body["assignee"];
  if (nested !== null && typeof nested === "object") {
    return firstString(nested as Record<string, unknown>, ["name", "displayName", "handle", "id"]);
  }
  return undefined;
}

/**
 * Project a Paperclip issue object onto a {@link MegazordObservation}. Reads
 * `.status` for the coarse state and best-effort probes for phase/agent/cost/risk.
 * Missing fields are omitted, never guessed.
 */
export function observeFromIssue(body: Record<string, unknown>): MegazordObservation {
  const rawStatus = firstString(body, ["status", "state"]) ?? "";
  const phase = firstString(body, ["phase", "stage", "step", "lifecycle"]);
  const agent = readAgent(body);
  const cost = firstString(body, ["cost", "costUsd", "usd", "spend", "tokens", "usage"]);
  const risk = firstString(body, ["risk", "tier", "severity", "priority"]);
  return {
    state: issueStatusToTaskState(rawStatus),
    rawStatus,
    ...(phase !== undefined ? { phase } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(risk !== undefined ? { risk } : {}),
  };
}

/**
 * A compact "phase · agent · cost · risk" detail line for the thread, or `""`
 * when nothing extra is known. The driver appends this to status notes so the
 * cockpit shows live execution detail, not just a coarse state word.
 */
export function observationDetail(obs: {
  readonly phase?: string;
  readonly agent?: string;
  readonly cost?: string;
  readonly risk?: string;
}): string {
  const parts: string[] = [];
  if (obs.phase !== undefined && obs.phase !== "") parts.push(`phase: ${obs.phase}`);
  if (obs.agent !== undefined && obs.agent !== "") parts.push(`agent: ${obs.agent}`);
  if (obs.cost !== undefined && obs.cost !== "") parts.push(`cost: ${obs.cost}`);
  if (obs.risk !== undefined && obs.risk !== "") parts.push(`risk: ${obs.risk}`);
  return parts.join(" · ");
}
