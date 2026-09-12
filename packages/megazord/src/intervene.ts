/**
 * Intervene — the BIDIRECTIONAL half of the control-plane (T3 → running thread).
 *
 * ## What this closes
 *
 * `runtimeEvents.ts` gives the OBSERVE leg (factory state → T3 thread). This
 * module gives the RETURN, control leg the DISTRIBUTION-PLAN calls "intervir":
 * from the T3 cockpit, reach back into a thread the org is actively running and
 *
 *   (a) INJECT a message  — redirect the agent mid-flight;
 *   (b) PAUSE / RESUME / KILL the run;
 *   (c) APPROVE / REJECT a gate the org escalated.
 *
 * ## Wire-format: the REAL Paperclip primitives (live-verified against :3100)
 *
 * The first cut of this module assumed a single write surface —
 * `POST /companies/:co/issues/:id/comments`. That company-scoped comment route
 * **does not exist** on Paperclip. Live testing against the running org server
 * (v0.3.1, `local_trusted`) mapped every intervention onto the primitives the
 * factory actually exposes (all under `/api`, none company-scoped):
 *
 *  - INJECT   → `POST /issues/:id/comments` with `{ body, interrupt: true }`.
 *               Posts a VISIBLE comment carrying the machine-readable `mz:` marker
 *               AND, because the caller is the board actor (implicit in
 *               `local_trusted`), cancels the issue's active run — a real
 *               mid-flight redirect. `interrupt` is a no-op when nothing is
 *               running, so the comment still lands as an audit marker.
 *  - PAUSE    → `POST /issues/:id/tree-holds` with `{ mode: "pause", reason }`.
 *  - RESUME   → `POST /issues/:id/tree-holds` with `{ mode: "resume", reason }`.
 *  - KILL     → `POST /issues/:id/tree-holds` with `{ mode: "cancel", reason }`.
 *  - APPROVE  → `POST /approvals/:approvalId/approve` with `{ decisionNote }`.
 *  - REJECT   → `POST /approvals/:approvalId/reject`  with `{ decisionNote }`.
 *
 * The `mz:` marker (see {@link interveneCommentBody}) rides in the comment
 * `body` / hold `reason` / approval `decisionNote` so the audit trail is honest
 * and correlatable across T3, the Paperclip UI, and the org agent — the same
 * "visible, not hidden RPC" intent, now expressed with the endpoints that exist.
 *
 * ## Fail-closed by construction
 *
 * A control action with no target is REFUSED before any network call
 * ({@link MegazordInterveneError}): the issue-family actions (inject / pause /
 * resume / kill) need a live `issueId`; the gate actions (approve / reject) need
 * an `approvalId`; `inject` additionally needs a non-empty message. The pure
 * {@link planIntervention} enforces this and is unit-tested without I/O;
 * {@link MegazordInterveneClient} just executes a validated plan.
 *
 * Framework-agnostic plain Node (like `MegazordIntakeClient`) so it typechecks in
 * this leaf package and is reused verbatim by the in-tree `MegazordDriver`.
 *
 * @module megazord/intervene
 */

/** A single control action the cockpit can push into a running thread. */
export type MegazordInterveneAction =
  | { readonly kind: "inject"; readonly message: string }
  | { readonly kind: "pause"; readonly note?: string }
  | { readonly kind: "resume"; readonly note?: string }
  | { readonly kind: "kill"; readonly note?: string }
  | { readonly kind: "approve"; readonly note?: string }
  | { readonly kind: "reject"; readonly note?: string };

/** Every action kind, for exhaustive callers/tests. */
export const MEGAZORD_INTERVENE_KINDS = [
  "inject",
  "pause",
  "resume",
  "kill",
  "approve",
  "reject",
] as const;

/** Action kinds routed through the issue tree-hold primitive, and their mode. */
const TREE_HOLD_MODE: Readonly<Record<"pause" | "resume" | "kill", "pause" | "resume" | "cancel">> =
  {
    pause: "pause",
    resume: "resume",
    kill: "cancel",
  };

/** Where an intervention lands: the thread's factory/Paperclip coordinates. */
export interface MegazordThreadCoords {
  /**
   * Paperclip issue id — the target of the issue-family actions (inject / pause
   * / resume / kill). Without it those actions refuse (no live thread).
   */
  readonly issueId?: string;
  /**
   * Paperclip approval id — the target of the gate actions (approve / reject).
   * The org escalates a gate as an approval; without this id a gate refuses.
   */
  readonly approvalId?: string;
  /**
   * Paperclip company scope. Not part of any intervene path (the real endpoints
   * are not company-scoped) — retained for correlation/observe parity only.
   */
  readonly companyId?: string;
  /** Human issue ident (e.g. `CAPA-86`), used only for messages. */
  readonly issueIdent?: string;
  /** Local actionable id, echoed into the marker for correlation. */
  readonly actionableId?: string;
}

/** A validated, ready-to-send HTTP request (relative to the `/api` base). */
export interface InterveneHttpRequest {
  readonly method: "POST" | "PATCH" | "PUT";
  /** Path under `/api`, e.g. `/issues/<id>/comments` or `/approvals/<id>/approve`. */
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Result of a successful intervention. */
export interface MegazordInterveneResult {
  readonly action: MegazordInterveneAction["kind"];
  /** The issue id targeted (issue-family actions), or `""` for gate actions. */
  readonly issueId: string;
  /** The approval id targeted (gate actions), or `""` otherwise. */
  readonly approvalId: string;
  /** The visible marker text actually sent (comment body / reason / decisionNote). */
  readonly posted: string;
  /** Whatever the factory returned (comment/hold/approval object), for callers that need it. */
  readonly raw: unknown;
}

/** Options overriding the (Paperclip-shaped) endpoint templates. */
export interface InterveneEndpoints {
  /** Issue-comment create path under `/api`. Default `/issues/:id/comments`. */
  readonly commentPath?: (issueId: string) => string;
  /** Issue tree-hold create path under `/api`. Default `/issues/:id/tree-holds`. */
  readonly treeHoldPath?: (issueId: string) => string;
  /**
   * Approval decision path under `/api`. Default `/approvals/:id/approve` or
   * `/approvals/:id/reject` depending on `decision`.
   */
  readonly approvalDecisionPath?: (approvalId: string, decision: "approve" | "reject") => string;
  /** JSON key the injected comment text goes under. Default `"body"`. */
  readonly commentBodyKey?: string;
}

export interface MegazordInterveneErrorDetail {
  readonly status?: number;
  readonly responseText?: string;
}

/**
 * Thrown when an intervention is refused (fail-closed) or the factory rejects it.
 * A `refusal` error never touched the network.
 */
export class MegazordInterveneError extends Error {
  override readonly name = "MegazordInterveneError";
  readonly refusal: boolean;
  readonly detail: MegazordInterveneErrorDetail | undefined;
  constructor(
    message: string,
    opts?: { refusal?: boolean; detail?: MegazordInterveneErrorDetail },
  ) {
    super(message);
    this.refusal = opts?.refusal ?? false;
    this.detail = opts?.detail;
  }
}

function defaultCommentPath(issueId: string): string {
  return `/issues/${encodeURIComponent(issueId)}/comments`;
}

function defaultTreeHoldPath(issueId: string): string {
  return `/issues/${encodeURIComponent(issueId)}/tree-holds`;
}

function defaultApprovalDecisionPath(approvalId: string, decision: "approve" | "reject"): string {
  return `/approvals/${encodeURIComponent(approvalId)}/${decision}`;
}

/** The machine-readable control marker prefix the org agent honours. */
export const MEGAZORD_MARKER_PREFIX = "mz";

/** Build the visible marker text for an action: a marker line + optional text. */
export function interveneCommentBody(
  action: MegazordInterveneAction,
  coords: MegazordThreadCoords,
): string {
  const tags: string[] = [];
  if (action.kind === "inject") tags.push(`${MEGAZORD_MARKER_PREFIX}:redirect=1`);
  else if (action.kind === "approve" || action.kind === "reject") {
    tags.push(`${MEGAZORD_MARKER_PREFIX}:gate=${action.kind}`);
  } else tags.push(`${MEGAZORD_MARKER_PREFIX}:control=${action.kind}`);
  if (coords.actionableId !== undefined && coords.actionableId !== "") {
    tags.push(`${MEGAZORD_MARKER_PREFIX}:actionable=${coords.actionableId}`);
  }
  const marker = `[T3-COCKPIT ${tags.join(" ")}]`;
  const text = action.kind === "inject" ? action.message.trim() : (action.note ?? "").trim();
  return text === "" ? marker : `${marker} ${text}`;
}

/**
 * Pure planner: turn a control action + thread coordinates into a validated HTTP
 * request against the REAL Paperclip primitive, or REFUSE (fail-closed) with a
 * {@link MegazordInterveneError}.
 *
 * Refusals (never hit the network):
 *  - issue-family action (inject/pause/resume/kill) with no `issueId`;
 *  - gate action (approve/reject) with no `approvalId`;
 *  - `inject` with an empty message.
 */
export function planIntervention(
  action: MegazordInterveneAction,
  coords: MegazordThreadCoords,
  endpoints?: InterveneEndpoints,
): InterveneHttpRequest {
  const bodyKey = endpoints?.commentBodyKey ?? "body";
  const markerText = interveneCommentBody(action, coords);

  if (action.kind === "approve" || action.kind === "reject") {
    const approvalId = (coords.approvalId ?? "").trim();
    if (approvalId === "") {
      throw new MegazordInterveneError("refused: no gate to decide on (missing approvalId)", {
        refusal: true,
      });
    }
    const approvalPath = endpoints?.approvalDecisionPath ?? defaultApprovalDecisionPath;
    return {
      method: "POST",
      path: approvalPath(approvalId, action.kind),
      body: { decisionNote: markerText },
    };
  }

  // Issue-family actions: inject / pause / resume / kill.
  const issueId = (coords.issueId ?? "").trim();
  if (issueId === "") {
    throw new MegazordInterveneError("refused: no live thread to intervene on (missing issueId)", {
      refusal: true,
    });
  }
  if (action.kind === "inject") {
    if (action.message.trim() === "") {
      throw new MegazordInterveneError("refused: cannot inject an empty message", {
        refusal: true,
      });
    }
    const commentPath = endpoints?.commentPath ?? defaultCommentPath;
    return {
      method: "POST",
      path: commentPath(issueId),
      body: { [bodyKey]: markerText, interrupt: true },
    };
  }

  // pause / resume / kill → issue tree-hold with the mapped mode.
  const treeHoldPath = endpoints?.treeHoldPath ?? defaultTreeHoldPath;
  return {
    method: "POST",
    path: treeHoldPath(issueId),
    body: { mode: TREE_HOLD_MODE[action.kind], reason: markerText },
  };
}

export interface MegazordInterveneClientOptions {
  /** Paperclip org server base URL. Defaults to `http://127.0.0.1:3100`. */
  readonly paperclipBaseUrl?: string;
  /** Company scope, when not supplied per-call on the coords (correlation only). */
  readonly companyId?: string;
  /** Endpoint template overrides. */
  readonly endpoints?: InterveneEndpoints;
  /** Max ms for the intervene HTTP call. Default 15000. */
  readonly timeoutMs?: number;
  /**
   * Injectable fetch, for tests. Defaults to the global `fetch`. Keeping this a
   * seam is what lets the whole intervene path be unit-verified WITHOUT touching
   * the live factory on `:3100`.
   */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Executes a validated intervention against the running Paperclip org server.
 * Construct once per configured factory/machine; methods are stateless.
 */
export class MegazordInterveneClient {
  private readonly baseUrl: string;
  private readonly companyId: string | undefined;
  private readonly endpoints: InterveneEndpoints | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MegazordInterveneClientOptions = {}) {
    this.baseUrl = (options.paperclipBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.companyId = options.companyId;
    this.endpoints = options.endpoints;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Push a control action into a running thread. Fail-closed: refuses (no
   * network) when there is no live target (issueId / approvalId) or nothing to say.
   */
  async intervene(
    coords: MegazordThreadCoords,
    action: MegazordInterveneAction,
  ): Promise<MegazordInterveneResult> {
    const companyId =
      coords.companyId !== undefined && coords.companyId !== "" ? coords.companyId : this.companyId;
    const resolved: MegazordThreadCoords = {
      ...coords,
      ...(companyId !== undefined ? { companyId } : {}),
    };
    const plan = planIntervention(action, resolved, this.endpoints);
    const url = `${this.baseUrl}/api${plan.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: plan.method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(plan.body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new MegazordInterveneError(
        `intervene ${action.kind} failed to reach Paperclip: ${String((cause as Error)?.message ?? cause)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const responseText = await safeText(res);
      throw new MegazordInterveneError(
        `intervene ${action.kind} rejected: ${res.status} ${res.statusText}`,
        { detail: { status: res.status, responseText } },
      );
    }
    const raw = await safeJson(res);
    return {
      action: action.kind,
      issueId: (resolved.issueId ?? "").trim(),
      approvalId: (resolved.approvalId ?? "").trim(),
      posted: interveneCommentBody(action, resolved),
      raw,
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Map a T3 `ProviderApprovalDecision` onto a gate intervene action. */
export function approvalDecisionToIntervene(
  decision: string,
  note?: string,
): { readonly kind: "approve" | "reject"; readonly note?: string } {
  // accept / acceptForSession / acceptAlways → approve; decline / cancel → reject.
  const approve =
    decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
  return approve
    ? { kind: "approve", ...(note !== undefined ? { note } : {}) }
    : { kind: "reject", ...(note !== undefined ? { note } : {}) };
}
