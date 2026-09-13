/**
 * Normalized task state for a Megazord (capiva-factory) submission.
 *
 * The capiva-factory intake exposes two independent status surfaces:
 *
 *   1. The *actionable* status, persisted to `actionables/store.ndjson`, with
 *      the enum `pending_founder | dispatched | gate_blocked_escalated |
 *      resolved | dropped` (see capiva-factory `actionables/lib.mjs`).
 *   2. The *Paperclip issue / heartbeat-run* status, read from the running
 *      Paperclip org server at `GET /api/issues/:issueId` — free-form strings
 *      that evolve as the org executes the work.
 *
 * A T3 harness only needs a small, stable projection of those two surfaces to
 * drive its thread lifecycle (spinner, "blocked, needs founder", "done"). This
 * module owns that projection so the mapping lives in one tested place instead
 * of being scattered across the driver/adapter.
 *
 * @module megazord/taskState
 */

/**
 * Stable, harness-facing task state. Deliberately coarse — the T3 thread only
 * needs to know "is it still working / did it stall / is it finished".
 */
export type MegazordTaskState =
  | "queued"
  | "dispatched"
  | "blocked"
  | "done"
  | "dropped"
  | "unknown";

/** Actionable status slugs written by capiva-factory `actionables/lib.mjs`. */
export type FactoryActionableStatus =
  | "pending_founder"
  | "dispatched"
  | "gate_blocked_escalated"
  | "resolved"
  | "dropped";

const ACTIONABLE_STATE: Readonly<Record<FactoryActionableStatus, MegazordTaskState>> = {
  pending_founder: "queued",
  dispatched: "dispatched",
  gate_blocked_escalated: "blocked",
  resolved: "done",
  dropped: "dropped",
};

/**
 * Project a capiva-factory *actionable* status onto the harness-facing state.
 * Unknown/forward-compatible slugs collapse to `"unknown"` rather than throwing,
 * matching the factory's own forward-compat posture.
 */
export function actionableStatusToTaskState(status: string): MegazordTaskState {
  return (
    ACTIONABLE_STATE as Readonly<Record<string, MegazordTaskState | undefined>>
  )[status] ?? "unknown";
}

/**
 * Project a Paperclip *issue* status string onto the harness-facing state.
 *
 * Paperclip issue status values are not fixed by a contract we own, so this is
 * a defensive keyword match rather than a closed table. Kept separate from the
 * actionable mapping because the two vocabularies are independent.
 */
export function issueStatusToTaskState(status: string): MegazordTaskState {
  const s = status.trim().toLowerCase();
  if (s === "") return "unknown";
  if (["done", "closed", "resolved", "completed", "merged"].some((k) => s.includes(k))) {
    return "done";
  }
  if (["blocked", "escalat", "needs", "review", "waiting"].some((k) => s.includes(k))) {
    return "blocked";
  }
  if (["progress", "running", "active", "dispatch", "working"].some((k) => s.includes(k))) {
    return "dispatched";
  }
  if (["cancel", "drop", "reject", "abandon"].some((k) => s.includes(k))) {
    return "dropped";
  }
  if (["open", "todo", "backlog", "pending", "queued", "new"].some((k) => s.includes(k))) {
    return "queued";
  }
  return "unknown";
}

/** Whether a state is terminal (the harness can stop polling). */
export function isTerminalTaskState(state: MegazordTaskState): boolean {
  return state === "done" || state === "dropped";
}
