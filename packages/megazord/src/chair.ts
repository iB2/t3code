/**
 * Megazord chair — the pure half of `bin/t3-chair.mjs`, the one command an
 * external orchestrator (a "chair") uses to run the local T3: see what needs a
 * decision, read a thread, and act on it.
 *
 * Since T3 0.1.0 the chair reads threads through T3's MCP (`./mcp.ts`), so the
 * status comes from {@link classifyMcpThread}; {@link classifyThread} reads the
 * pre-0.1.0 snapshot shape that the other megazord CLIs still use.
 *
 * Two things live here because they must not depend on I/O:
 *
 *  - **The fence.** The chair is a remote agent, so whatever it reads leaves the
 *    machine. The policy file names projects and provider instances that stay
 *    local; a hidden thread is not listed, not readable and not writable, and the
 *    chair never learns it exists. No policy file means no access at all.
 *  - **The status of a thread**, from the same snapshot the UI reads, so "needs a
 *    decision" is decided in one place instead of by each caller.
 *
 * Framework-agnostic plain Node, like `dispatch.ts`.
 *
 * @module megazord/chair
 */
import { pendingUserInput, type PendingUserInput } from "./dispatch.ts";

/** What stays on this machine. Both lists are exact ids. */
export interface ChairPolicy {
  readonly blockedProjectIds: ReadonlyArray<string>;
  readonly blockedInstanceIds: ReadonlyArray<string>;
}

/** Raised for a missing/invalid policy or a target outside it. Always a refusal. */
export class ChairRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChairRefusal";
  }
}

function idList(raw: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new ChairRefusal(`refused: chair policy field '${field}' must be a list of ids`);
  }
  return raw.map((v) => (v as string).trim());
}

/**
 * Parse the policy file for one environment. Fail-closed: both fields are
 * required, even if empty.
 *
 * The top-level lists are the `local` environment's, so a policy written before
 * there was more than one machine keeps meaning the same thing. Any other
 * environment needs its own entry under `environments`: ids differ per machine
 * (the same account can sit under another instance id there), so reusing this
 * machine's lists could leave a client account open. No entry, no access.
 */
export function parsePolicy(raw: unknown, environment = "local"): ChairPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ChairRefusal("refused: chair policy must be a JSON object");
  }
  let r = raw as Record<string, unknown>;
  if (environment !== "local") {
    const envs = r["environments"];
    const entry =
      envs !== null && typeof envs === "object" && !Array.isArray(envs)
        ? (envs as Record<string, unknown>)[environment]
        : undefined;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ChairRefusal(
        `refused: the chair policy has no entry for environment '${environment}'`,
      );
    }
    r = entry as Record<string, unknown>;
  }
  return {
    blockedProjectIds: idList(r["blockedProjectIds"], "blockedProjectIds"),
    blockedInstanceIds: idList(r["blockedInstanceIds"], "blockedInstanceIds"),
  };
}

type Row = Record<string, unknown>;

function instanceIdOf(thread: Row): string {
  const sel = thread["modelSelection"];
  return sel !== null && typeof sel === "object" ? String((sel as Row)["instanceId"] ?? "") : "";
}

export function projectVisible(policy: ChairPolicy, project: Row): boolean {
  return (
    (project["deletedAt"] ?? null) === null &&
    !policy.blockedProjectIds.includes(String(project["id"] ?? ""))
  );
}

/**
 * A thread is visible only when its project and its provider instance are both
 * outside the policy. A thread with no readable instance is hidden: unknown is
 * not the same as allowed.
 */
export function threadVisible(policy: ChairPolicy, thread: Row): boolean {
  if ((thread["deletedAt"] ?? null) !== null) return false;
  if (policy.blockedProjectIds.includes(String(thread["projectId"] ?? ""))) return false;
  const instanceId = instanceIdOf(thread);
  return instanceId !== "" && !policy.blockedInstanceIds.includes(instanceId);
}

/** Refuse an instance the policy keeps local (for `open --instance`). */
export function assertInstanceAllowed(policy: ChairPolicy, instanceId: string): void {
  if (policy.blockedInstanceIds.includes(instanceId)) {
    throw new ChairRefusal(`refused: instance '${instanceId}' is outside the chair policy`);
  }
}

/** An approval the agent is blocked on, with the id needed to answer it. */
export interface PendingApproval {
  readonly requestId: string;
  readonly requestKind: string;
  readonly detail: string;
}

/** Approvals of a turn that were requested and never resolved, oldest first. */
export function pendingApprovals(
  activities: ReadonlyArray<Row>,
  turnId: string,
): ReadonlyArray<PendingApproval> {
  const open = new Map<string, PendingApproval>();
  for (const a of activities) {
    if (turnId !== "" && a["turnId"] !== turnId) continue;
    const kind = String(a["kind"] ?? "");
    if (!kind.startsWith("approval.")) continue;
    const payload = a["payload"];
    if (payload === null || typeof payload !== "object") continue;
    const p = payload as Row;
    const requestId = String(p["requestId"] ?? "");
    if (requestId === "") continue;
    if (kind === "approval.requested") {
      open.set(requestId, {
        requestId,
        requestKind: String(p["requestKind"] ?? ""),
        detail: String(p["detail"] ?? a["summary"] ?? ""),
      });
    } else {
      open.delete(requestId);
    }
  }
  return [...open.values()];
}

/**
 * Where a thread stands for someone deciding what to do next:
 *
 *  - `question` / `approval`: the agent is blocked until someone answers.
 *  - `running`: a turn is in flight and nothing is asked of anyone.
 *  - `error` / `interrupted`: the last turn did not finish.
 *  - `idle`: the last turn finished and the thread is still open — the place a
 *    "should I go on?" ending lands.
 *  - `done`: the thread was settled.
 *  - `empty`: no turn ever ran.
 *  - `queued`: no turn is running, but messages sit in a queue that T3 holds
 *    after the last turn ended (a stop, a failure, a session limit). T3 will
 *    not settle the thread until they are sent or dropped.
 */
export type ChairStatus =
  | "question"
  | "approval"
  | "queued"
  | "running"
  | "error"
  | "interrupted"
  | "idle"
  | "done"
  | "empty";

/** Statuses where the next move belongs to the chair, not to the agent. */
export const NEEDS_DECISION: ReadonlyArray<ChairStatus> = [
  "question",
  "approval",
  "queued",
  "error",
  "interrupted",
  "idle",
];

export interface ChairThreadState {
  readonly status: ChairStatus;
  readonly turnId: string;
  readonly pendingInput?: PendingUserInput;
  readonly pendingApprovals?: ReadonlyArray<PendingApproval>;
}

/**
 * Classify one thread. `activities` is the thread detail's activity log; the
 * snapshot carries none, so a caller that only has the snapshot row passes `[]`
 * and gets `running` where the detail would say `question` or `approval`.
 */
export function classifyThread(thread: Row, activities: ReadonlyArray<Row>): ChairThreadState {
  const turn = thread["latestTurn"];
  const session = thread["session"];
  const turnRow = turn !== null && typeof turn === "object" ? (turn as Row) : undefined;
  const sessionStatus =
    session !== null && typeof session === "object" ? String((session as Row)["status"] ?? "") : "";
  const turnId = String(turnRow?.["turnId"] ?? "");
  const turnState = String(turnRow?.["state"] ?? "");
  const live =
    turnState === "running" || sessionStatus === "running" || sessionStatus === "starting";

  if (live) {
    const pendingInput = pendingUserInput(activities, turnId);
    if (pendingInput !== undefined) return { status: "question", turnId, pendingInput };
    const approvals = pendingApprovals(activities, turnId);
    if (approvals.length > 0) return { status: "approval", turnId, pendingApprovals: approvals };
    return { status: "running", turnId };
  }
  if ((thread["settledAt"] ?? null) !== null) return { status: "done", turnId };
  if (turnState === "error" || sessionStatus === "error") return { status: "error", turnId };
  if (turnState === "interrupted") return { status: "interrupted", turnId };
  if (turnRow === undefined) return { status: "empty", turnId };
  return { status: "idle", turnId };
}

/**
 * Classify a thread row from T3's MCP (`t3_thread_list` / `t3_thread_read`),
 * which reports the latest run's durable status instead of turns and activities.
 *
 * A run blocked on a person still reports `running` (or `waiting`); what tells
 * it apart is `pendingRequestCount`, which only `t3_thread_read` carries. With
 * a pending question (pass it as `pendingInput`) the thread is a `question`;
 * with requests but no question it is a permission approval, which the MCP can
 * neither answer nor describe, so that case only flags it.
 *
 * `t3_thread_read` reports a thread whose last turn ended while a follow-up
 * waited in the queue as `queued`, with no active run: the queued run never
 * starts on its own. That is a held queue, not a turn in flight. A brand-new
 * thread whose first run is still queued has no earlier run and stays
 * `running`. (`t3_thread_list` ignores the queued run and reports the last run
 * that ran, so the two views disagree; this one is what settle checks.)
 */
export function classifyMcpThread(thread: Row, pendingInput?: PendingUserInput): ChairThreadState {
  const turnId = String(thread["latestRunId"] ?? "");
  const status = String(thread["status"] ?? "");
  if (thread["settled"] === true) return { status: "done", turnId };
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      if (pendingInput !== undefined) return { status: "question", turnId, pendingInput };
      if (status === "queued" && heldQueue(thread)) return { status: "queued", turnId };
      if (status !== "waiting" && Number(thread["pendingRequestCount"] ?? 0) === 0) {
        return { status: "running", turnId };
      }
      return {
        status: "approval",
        turnId,
        pendingApprovals: [
          {
            requestId: "",
            requestKind: "approval",
            detail: "the agent is waiting for a permission approval; answer it in the T3 app",
          },
        ],
      };
    case "failed":
      return { status: "error", turnId };
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return { status: "interrupted", turnId };
    default:
      // `completed`, or `idle` on a thread that already has a conversation
      // (threads migrated from before 0.1.0 report idle with no run id).
      return Number(thread["itemCount"] ?? 0) > 0 || turnId !== ""
        ? { status: "idle", turnId }
        : { status: "empty", turnId };
  }
}

const TERMINAL_RUN = ["completed", "failed", "interrupted", "cancelled", "rolled_back"];

/** No run is active and an earlier run already ran to an end: the queue is held. */
function heldQueue(thread: Row): boolean {
  if ((thread["activeRunId"] ?? null) !== null) return false;
  const runs = Array.isArray(thread["recentRuns"])
    ? (thread["recentRuns"] as ReadonlyArray<Row>)
    : [];
  return runs.some(
    (run) =>
      (run["startedAt"] ?? null) !== null && TERMINAL_RUN.includes(String(run["status"] ?? "")),
  );
}

/**
 * Why `settle` must refuse a thread in this state, or undefined when it may go
 * ahead. A held queue is refused unless the caller asked to drop it: T3 itself
 * refuses to settle a thread with a queued message, and dropping one throws
 * away an instruction, so it is never done silently.
 */
export function settleRefusal(
  state: ChairThreadState,
  options: { readonly dropQueued?: boolean; readonly queuedCount?: number } = {},
): string | undefined {
  switch (state.status) {
    case "running":
      return "is running, not finished";
    case "question":
      return "is waiting on a question; answer it first";
    case "approval":
      return "is waiting on an approval; answer it in the T3 app first";
    case "queued": {
      if (options.dropQueued === true) return undefined;
      const n = options.queuedCount;
      const what = n === undefined ? "queued messages" : `${n} queued message${n === 1 ? "" : "s"}`;
      return `has ${what} held after its last turn ended and no turn running (stalled queue); T3 settles it only once they are sent or dropped: pass --drop-queued to drop them and settle`;
    }
    default:
      return undefined;
  }
}
