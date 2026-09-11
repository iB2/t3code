/**
 * Round-trip projection: capiva-factory task state -> T3 thread events.
 *
 * ## The seam this closes (Build 3 round-trip)
 *
 * The spike (`PR#1`) could submit a T3 task to the factory and normalize its
 * status into a {@link MegazordTaskState}. What was missing is the RETURN leg:
 * turning the factory's evolving status into the discrete lifecycle events a T3
 * thread renders (spinner starts, "dispatched to the org", "blocked — needs
 * founder", "done"). This module owns that mapping as a pure state machine.
 *
 * ## Why plain descriptors, not `ProviderRuntimeEvent`s
 *
 * The canonical `ProviderRuntimeEvent` (packages/contracts) uses *branded*
 * strings (EventId, TrimmedNonEmptyString, IsoDateTime) and needs a per-event
 * `eventId`/`createdAt` minted from the server's Effect runtime. A leaf package
 * that imported all that would drag Effect into its standalone typecheck. So
 * this module emits framework-agnostic {@link MegazordThreadEvent} descriptors
 * describing WHAT happened; the in-tree `MegazordDriver` maps each descriptor to
 * a fully-branded `ProviderRuntimeEvent` (`session.started`, `turn.started`,
 * `item.completed`, `turn.completed`, `runtime.error`) via its `buildEventBase`
 * helper and offers them onto the adapter's event queue. Keeping the *decision*
 * here makes it unit-testable without a monorepo install; keeping the *branding*
 * in the driver keeps this package Effect-free.
 *
 * @module megazord/runtimeEvents
 */
import { isTerminalTaskState, type MegazordTaskState } from "./taskState.ts";

/**
 * A single thread-facing lifecycle event, provider-agnostic. The driver decides
 * the exact `ProviderRuntimeEvent` type for each `kind`:
 *
 * | kind             | driver emits                                             |
 * |------------------|----------------------------------------------------------|
 * | `session-started`| `session.started` + `thread.started`                     |
 * | `turn-started`   | `turn.started`                                           |
 * | `status-note`    | `item.completed` (itemType `unknown`, informational)     |
 * | `blocked`        | `item.completed` (unknown) — turn stays open (founder)   |
 * | `turn-completed` | `item.completed` (assistant_message) + `turn.completed`  |
 * | `error`          | `runtime.error`                                          |
 */
export type MegazordThreadEvent =
  | { readonly kind: "session-started"; readonly text: string }
  | { readonly kind: "turn-started" }
  | { readonly kind: "status-note"; readonly text: string }
  | { readonly kind: "blocked"; readonly text: string }
  | {
      readonly kind: "turn-completed";
      readonly state: "completed" | "failed";
      readonly text: string;
    }
  | { readonly kind: "error"; readonly message: string };

/** Contextual detail attached to human-readable event text. */
export interface MegazordProgressContext {
  /** Paperclip issue human ident (e.g. `PAP-123`), when known. */
  readonly issueIdent?: string;
  /** Paperclip issue URL, when known. */
  readonly issueUrl?: string;
  /** The raw upstream status string that produced the transition, for detail. */
  readonly rawStatus?: string;
}

function issueSuffix(ctx: MegazordProgressContext | undefined): string {
  if (ctx?.issueIdent !== undefined && ctx.issueIdent !== "") return ` (issue ${ctx.issueIdent})`;
  if (ctx?.issueUrl !== undefined && ctx.issueUrl !== "") return ` (${ctx.issueUrl})`;
  return "";
}

/**
 * Events to emit when a thread first submits its task (before polling). The
 * driver calls this from `startSession`/`sendTurn` right after `submit()`.
 */
export function megazordSubmitEvents(
  ctx?: MegazordProgressContext,
): ReadonlyArray<MegazordThreadEvent> {
  return [
    { kind: "session-started", text: `Task routed to the capiva-factory org${issueSuffix(ctx)}.` },
    { kind: "turn-started" },
  ];
}

/**
 * Project a factory task-state transition onto zero or more thread events.
 *
 * Only *changes* produce events (`prev === next` ⇒ `[]`), so a poll loop can
 * call this on every tick and forward whatever comes back. `prev === undefined`
 * means "first observed state after submit".
 *
 * Terminal states (`done`, `dropped`) yield a `turn-completed`; `blocked` keeps
 * the turn open (the org escalated to the founder — the thread is waiting, not
 * finished). Unknown/queued churn is reported as at most one informational note.
 */
export function megazordThreadEventsForTransition(
  prev: MegazordTaskState | undefined,
  next: MegazordTaskState,
  ctx?: MegazordProgressContext,
): ReadonlyArray<MegazordThreadEvent> {
  if (prev === next) return [];
  const suffix = issueSuffix(ctx);

  switch (next) {
    case "queued":
      // Only worth a note if we regressed into queued from somewhere else.
      return prev === undefined
        ? []
        : [{ kind: "status-note", text: `Re-queued in the org backlog${suffix}.` }];
    case "dispatched":
      return [{ kind: "status-note", text: `Dispatched — the org is working on it${suffix}.` }];
    case "blocked":
      return [
        {
          kind: "blocked",
          text: `Blocked — escalated to the founder for a decision${suffix}. Waiting on approval.`,
        },
      ];
    case "done":
      return [
        {
          kind: "turn-completed",
          state: "completed",
          text: `Done — the org resolved this task${suffix}.`,
        },
      ];
    case "dropped":
      return [
        {
          kind: "turn-completed",
          state: "failed",
          text: `Dropped — the org will not act on this task${suffix}.`,
        },
      ];
    case "unknown":
      return [
        { kind: "status-note", text: `Status unknown${suffix} (raw: ${ctx?.rawStatus ?? "n/a"}).` },
      ];
  }
}

/** Whether a poll loop can stop after observing `state`. */
export function megazordPollShouldStop(state: MegazordTaskState): boolean {
  return isTerminalTaskState(state);
}
