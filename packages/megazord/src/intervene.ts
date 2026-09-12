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
 * ## Why every intervention is a VISIBLE issue comment (not a hidden control RPC)
 *
 * The whole point of Build 3 (DISTRIBUTION-PLAN, "Plano de CONTROLE") is that
 * work stops being a shadow subagent and becomes a **visible Paperclip thread**.
 * Intervention must obey the same rule: it lands as a comment on the issue that
 * everyone (T3, Paperclip UI, the org agent) can see, carrying a machine-readable
 * marker (`mz:...`) the org honours. That keeps the audit trail honest and avoids
 * inventing speculative hidden control endpoints on the factory. The only Paperclip
 * write surface this needs is the one already proven by intake: an issue exists
 * under `/api/companies/:companyId/issues/:issueId`, and comments hang off it.
 *
 * ## Fail-closed by construction
 *
 * A control action with no live thread/issue, no company scope, or an empty
 * payload is REFUSED before any network call ({@link MegazordInterveneError}).
 * You can never "intervene" into the void, and you can never inject an empty
 * redirect. The pure {@link planIntervention} enforces this and is unit-tested
 * without I/O; {@link MegazordInterveneClient} just executes a validated plan.
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

/** Where an intervention lands: the thread's factory/Paperclip coordinates. */
export interface MegazordThreadCoords {
  /** Paperclip issue id (required — no issue, no intervention). */
  readonly issueId?: string;
  /** Paperclip company scope for the issue path (required). */
  readonly companyId?: string;
  /** Human issue ident (e.g. `PAP-42`), used only for messages. */
  readonly issueIdent?: string;
  /** Local actionable id, echoed into the marker for correlation. */
  readonly actionableId?: string;
}

/** A validated, ready-to-send HTTP request (relative to the `/api` base). */
export interface InterveneHttpRequest {
  readonly method: "POST" | "PATCH" | "PUT";
  /** Path under `/api`, e.g. `/companies/<co>/issues/<id>/comments`. */
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Result of a successful intervention. */
export interface MegazordInterveneResult {
  readonly action: MegazordInterveneAction["kind"];
  readonly issueId: string;
  /** The comment body actually posted (the visible marker + text). */
  readonly posted: string;
  /** Whatever the factory returned (comment id, etc.), for callers that need it. */
  readonly raw: unknown;
}

/** Options overriding the (Paperclip-shaped) endpoint templates. */
export interface InterveneEndpoints {
  /** Comment-create path under `/api`. Default Paperclip shape. */
  readonly commentPath?: (companyId: string, issueId: string) => string;
  /** JSON key the comment body goes under. Default `"body"`. */
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

function defaultCommentPath(companyId: string, issueId: string): string {
  return `/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/comments`;
}

/** The machine-readable control marker prefix the org agent honours. */
export const MEGAZORD_MARKER_PREFIX = "mz";

/** Build the visible comment body for an action: a marker line + optional text. */
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
 * request, or REFUSE (fail-closed) with a {@link MegazordInterveneError}.
 *
 * Refusals (never hit the network):
 *  - no `issueId` / `companyId`      → no live thread to intervene on;
 *  - `inject` with empty message     → nothing to redirect with.
 */
export function planIntervention(
  action: MegazordInterveneAction,
  coords: MegazordThreadCoords,
  endpoints?: InterveneEndpoints,
): InterveneHttpRequest {
  const issueId = (coords.issueId ?? "").trim();
  const companyId = (coords.companyId ?? "").trim();
  if (issueId === "" || companyId === "") {
    throw new MegazordInterveneError(
      "refused: no live thread to intervene on (missing issueId/companyId)",
      { refusal: true },
    );
  }
  if (action.kind === "inject" && action.message.trim() === "") {
    throw new MegazordInterveneError("refused: cannot inject an empty message", {
      refusal: true,
    });
  }
  const commentPath = endpoints?.commentPath ?? defaultCommentPath;
  const bodyKey = endpoints?.commentBodyKey ?? "body";
  return {
    method: "POST",
    path: commentPath(companyId, issueId),
    body: { [bodyKey]: interveneCommentBody(action, coords) },
  };
}

export interface MegazordInterveneClientOptions {
  /** Paperclip org server base URL. Defaults to `http://127.0.0.1:3100`. */
  readonly paperclipBaseUrl?: string;
  /** Company scope, when not supplied per-call on the coords. */
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
   * network) when there is no live issue/company or nothing to say.
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
    const bodyKey = this.endpoints?.commentBodyKey ?? "body";
    return {
      action: action.kind,
      issueId: (resolved.issueId ?? "").trim(),
      posted: String(plan.body[bodyKey] ?? ""),
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
