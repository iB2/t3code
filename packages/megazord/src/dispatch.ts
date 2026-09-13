/**
 * Dispatch — ORCH → T3: make the work an external orchestrator (wa-orchestrator)
 * hands off show up as a FIRST-CLASS THREAD inside the running T3 desktop,
 * routed to the right (account, harness), instead of a shadow subagent T3 never
 * sees.
 *
 * ## What this closes
 *
 * `MegazordIntakeClient` submits to the capiva-factory; `intervene.ts` steers a
 * running thread. This module is the MISSING FRONT DOOR: it talks to the live T3
 * server's HTTP API (`POST /api/orchestration/dispatch`) to `thread.create` +
 * `thread.turn.start`, so the run is a thread the user can watch and approve in
 * the desktop they already have open. Viability was proven end-to-end against
 * the live desktop (see `SPIKE-ORCH-TO-T3.md`).
 *
 * ## The flow (mirrors the spike's minimal client)
 *
 * ```
 * 1. resolve origin  ← ~/.t3/userdata/server-runtime.json .origin  (pid liveness optional)
 * 2. mint token      ← `t3 auth session issue --base-dir <baseDir> --json` (scope orchestration:operate)
 * 3. read accounts   ← ~/.t3/userdata/settings.json providerInstances  (LIVE, never hardcoded)
 * 4. read quota      ← injectable usage source (UsageLimitsReport shape); best-effort
 * 5. choose (account, harness) ← {@link selectInstance} routing policy
 * 6. POST dispatch thread.create      { projectId, title, modelSelection: { instanceId, model } }
 * 7. POST dispatch thread.turn.start  { threadId, message.text, runtimeMode }
 * ```
 *
 * ## Routing policy (Bruno, 2026-09-12 — hard rule; see {@link selectInstance})
 *
 *  1. **SSB = EXCLUSIVE.** The SSB account (harness `claudeAgent`, displayName
 *     "Claude SSB") receives ONLY `scope: "ssb"` work; `scope: "general"` work
 *     NEVER lands on it. Because the boundary is which OAuth home the CLI logs
 *     into, sending the wrong `instanceId` would run on the wrong login — so
 *     this gates instance selection, not a label.
 *  2. **Everything else = the pool of the other three** (`codex`,
 *     `codex_codex_capiva`, `claudeAgent_claude_capiva`), chosen by (a)
 *     CAPABILITY — a required `driver` or an exclusive `connector` pins the
 *     instance — else (b) least-loaded by QUOTA (`usedPercent`).
 *  3. **Fail-closed.** `scope: "ssb"` with no available SSB account is an ERROR,
 *     never a fallback to another account. A required driver/connector with no
 *     eligible instance is an ERROR, never a silent wrong-account dispatch.
 *
 * Framework-agnostic plain Node (like `MegazordIntakeClient` /
 * `MegazordInterveneClient`): no Effect/T3 imports, an injectable `fetchImpl`
 * seam, so the whole path is unit-verifiable without the live server.
 *
 * @module megazord/dispatch
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import * as os from "node:os";

// ── Wire vocabulary (kept in sync with @t3tools/contracts, inlined so this
//    leaf package stays dependency-free) ────────────────────────────────────

/** The two harnesses in play. Mirrors `ProviderDriverKind` values used here. */
export type ProviderDriver = "codex" | "claudeAgent";

/** The NDA/quota routing scope of a request. */
export type DispatchScope = "ssb" | "general";

/** T3 runtime mode. `approval-required` = agent pauses at first tool use. */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

/** T3 interaction mode. */
export type InteractionMode = "default" | "plan";

/**
 * Canonical default model per harness (mirror of
 * `DEFAULT_MODEL_BY_PROVIDER` in `@t3tools/contracts/model.ts`, inlined). Used
 * only when the caller does not pin a model and the instance config carries
 * none. Override via {@link MegazordT3DispatchClientOptions.modelByDriver}.
 */
export const DEFAULT_MODEL_BY_DRIVER: Readonly<Record<ProviderDriver, string>> = {
  codex: "gpt-5.6-sol",
  claudeAgent: "claude-sonnet-5",
};

/**
 * One connected provider instance, read live from `settings.json`
 * `providerInstances`. `instanceId` is the routing key; `driver` is the harness.
 */
export interface ProviderInstanceAccount {
  readonly instanceId: string;
  readonly driver: ProviderDriver | string;
  readonly displayName?: string;
  /** `false` disables the instance; absent/`true` = enabled. */
  readonly enabled?: boolean;
  /** Per-instance config home (the OAuth-account boundary). Correlation only. */
  readonly homePath?: string;
  /** A model the instance config prefers, if any (from customModels/defaults). */
  readonly preferredModel?: string;
}

/**
 * Best-effort quota for one instance. Shape distilled from the T3
 * `UsageLimitsReport` / `ServerProviderUsageWindow` contract (`usedPercent`
 * 0–100, `resetsAt` ISO). `load` is the worst (max) window `usedPercent`; a
 * caller that already has a report should pass the per-instance max.
 */
export interface InstanceUsage {
  readonly instanceId: string;
  /** Worst-window used percent, 0–100. Higher = more loaded. */
  readonly usedPercent: number;
  /** ISO reset time of that window, if known (carried for future reset-aware routing). */
  readonly resetsAt?: string;
}

/** Connectors/MCP servers an instance exposes, keyed by `instanceId`. */
export type InstanceCapabilities = Readonly<Record<string, ReadonlyArray<string>>>;

/** A source of live quota. Returns per-instance usage; `[]` = unknown for all. */
export type UsageSource = () =>
  | Promise<ReadonlyArray<InstanceUsage>>
  | ReadonlyArray<InstanceUsage>;

/** Decide whether an account is THE SSB (exclusive) account. */
export type SsbMatcher = (account: ProviderInstanceAccount) => boolean;

/**
 * Default SSB matcher: an enabled `claudeAgent` instance whose displayName
 * marks it as SSB (word "SSB", case-insensitive). Reads live — survives an
 * instanceId rename as long as the displayName still says SSB. Override when the
 * marking convention differs.
 */
export const defaultSsbMatcher: SsbMatcher = (account) =>
  account.driver === "claudeAgent" && /\bssb\b/i.test(account.displayName ?? "");

// ── Errors ──────────────────────────────────────────────────────────────────

export interface MegazordDispatchErrorDetail {
  readonly status?: number;
  readonly responseText?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

/**
 * Thrown when routing refuses (fail-closed) or the live server rejects a call.
 * A `refusal` error never touched the network: the routing policy refused.
 */
export class MegazordDispatchError extends Error {
  override readonly name = "MegazordDispatchError";
  readonly refusal: boolean;
  readonly detail: MegazordDispatchErrorDetail | undefined;
  constructor(message: string, opts?: { refusal?: boolean; detail?: MegazordDispatchErrorDetail }) {
    super(message);
    this.refusal = opts?.refusal ?? false;
    this.detail = opts?.detail;
  }
}

// ── Pure routing policy (fully unit-tested, no I/O) ───────────────────────────

/** Everything {@link selectInstance} needs to choose one (account, harness). */
export interface SelectInstanceInput {
  /** Live account inventory (from settings.json). */
  readonly accounts: ReadonlyArray<ProviderInstanceAccount>;
  /** NDA/quota scope of the request. */
  readonly scope: DispatchScope;
  /** Required harness, when the task can only run on one. */
  readonly driver?: ProviderDriver;
  /** Required exclusive connector/MCP the task needs. */
  readonly needs?: string;
  /** Live quota, best-effort. Absent/empty = unknown → deterministic tie-break. */
  readonly usage?: ReadonlyArray<InstanceUsage>;
  /** Connector inventory per instance, for `needs` routing. */
  readonly capabilities?: InstanceCapabilities;
  /** SSB-account predicate. Defaults to {@link defaultSsbMatcher}. */
  readonly ssbMatcher?: SsbMatcher;
  /** Model overrides per harness. Defaults to {@link DEFAULT_MODEL_BY_DRIVER}. */
  readonly modelByDriver?: Readonly<Record<string, string>>;
  /** Pin ONE model for this request, beating the instance/driver defaults. */
  readonly model?: string;
  /** Valid model ids per harness, for validating {@link model}. Unknown = no gate. */
  readonly modelsByDriver?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Used-percent at/above which an instance is treated as saturated (sorted last). Default 95. */
  readonly saturationPercent?: number;
}

/** The routing decision: which instance/harness/model, and why. */
export interface DispatchDecision {
  readonly instanceId: string;
  readonly driver: ProviderDriver | string;
  readonly model: string;
  readonly scope: DispatchScope;
  /** Human-readable justification (audit trail). */
  readonly reason: string;
  /** Worst-window used percent that drove the pick, when quota was known. */
  readonly load?: number;
  /** InstanceIds that survived every gate and were ranked. */
  readonly consideredInstanceIds: ReadonlyArray<string>;
}

function isEnabled(account: ProviderInstanceAccount): boolean {
  return account.enabled !== false;
}

function resolveModel(
  account: ProviderInstanceAccount,
  modelByDriver: Readonly<Record<string, string>>,
  requested?: string,
  modelsByDriver?: Readonly<Record<string, ReadonlyArray<string>>>,
): string {
  const pinned = (requested ?? "").trim();
  if (pinned !== "") {
    // Validate when the manifest is known: a bad id would otherwise produce a thread
    // that fails on its first turn, far from the caller who typed it.
    const valid = modelsByDriver?.[account.driver];
    if (valid !== undefined && valid.length > 0 && !valid.includes(pinned)) {
      throw new MegazordDispatchError(
        `refused: model '${pinned}' is not available for harness '${account.driver}' ` +
          `(valid: ${valid.join(", ")})`,
        { refusal: true },
      );
    }
    return pinned;
  }
  const preferred = (account.preferredModel ?? "").trim();
  if (preferred !== "") return preferred;
  const byDriver = modelByDriver[account.driver];
  if (byDriver !== undefined && byDriver.trim() !== "") return byDriver;
  throw new MegazordDispatchError(
    `no model resolvable for instance '${account.instanceId}' (driver '${account.driver}'): ` +
      `pass a model override or set the instance's preferred model`,
    { refusal: true },
  );
}

/**
 * The question a turn is currently blocked on, or undefined when it is not blocked.
 *
 * The thread's activity log is the source: `user-input.requested` opens a question and
 * any later `user-input.*` activity on the same request closes it, so the LAST
 * user-input activity of the turn decides.
 */
export function pendingUserInput(
  activities: ReadonlyArray<Record<string, unknown>>,
  turnId: string,
): PendingUserInput | undefined {
  const forTurn = activities.filter(
    (a) =>
      (turnId === "" || a["turnId"] === turnId) &&
      String(a["kind"] ?? "").startsWith("user-input."),
  );
  const last = forTurn[forTurn.length - 1];
  if (last === undefined || last["kind"] !== "user-input.requested") return undefined;
  const payload = last["payload"];
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const requestId = String(p["requestId"] ?? "");
  if (requestId === "") return undefined;
  const rawQuestions = Array.isArray(p["questions"]) ? p["questions"] : [];
  const questions = rawQuestions
    .filter((q): q is Record<string, unknown> => q !== null && typeof q === "object")
    .map((q) => ({
      id: String(q["id"] ?? q["question"] ?? ""),
      question: String(q["question"] ?? ""),
      header: String(q["header"] ?? ""),
      options: (Array.isArray(q["options"]) ? q["options"] : [])
        .filter((o): o is Record<string, unknown> => o !== null && typeof o === "object")
        .map((o) => String(o["value"] ?? o["label"] ?? ""))
        .filter((label) => label !== ""),
      multiSelect: q["multiSelect"] === true,
    }))
    .filter((q) => q.id !== "");
  return { requestId, questions };
}

/**
 * Join the assistant text a given turn produced. Streaming placeholders are skipped:
 * a half-written message relayed to a chat reads as a bug.
 */
export function assistantTextForTurn(
  messages: ReadonlyArray<Record<string, unknown>>,
  turnId: string,
): string {
  return messages
    .filter((m) => m["role"] === "assistant" && m["turnId"] === turnId && m["streaming"] !== true)
    .map((m) => String(m["text"] ?? "").trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

/** Max window used-percent for an instance, or `undefined` when quota unknown. */
function loadFor(
  instanceId: string,
  usage: ReadonlyArray<InstanceUsage> | undefined,
): number | undefined {
  if (usage === undefined) return undefined;
  const entries = usage.filter((u) => u.instanceId === instanceId);
  if (entries.length === 0) return undefined;
  return entries.reduce((max, u) => Math.max(max, u.usedPercent), 0);
}

/**
 * Rank eligible candidates and pick the winner: least-loaded by quota, with
 * unknown-quota candidates ranked after known ones (in config order), and
 * saturated candidates ranked last. Deterministic: config order breaks every tie.
 */
function pickLeastLoaded(
  candidates: ReadonlyArray<ProviderInstanceAccount>,
  usage: ReadonlyArray<InstanceUsage> | undefined,
  saturationPercent: number,
): { readonly account: ProviderInstanceAccount; readonly load: number | undefined } {
  const ranked = candidates
    .map((account, index) => ({ account, index, load: loadFor(account.instanceId, usage) }))
    .toSorted((a, b) => {
      const aSat = a.load !== undefined && a.load >= saturationPercent;
      const bSat = b.load !== undefined && b.load >= saturationPercent;
      if (aSat !== bSat) return aSat ? 1 : -1; // saturated last
      const aKnown = a.load !== undefined;
      const bKnown = b.load !== undefined;
      if (aKnown !== bKnown) return aKnown ? -1 : 1; // known load before unknown
      if (aKnown && bKnown && a.load !== b.load) return a.load! - b.load!; // lower load first
      return a.index - b.index; // config order breaks ties
    });
  const winner = ranked[0]!;
  return { account: winner.account, load: winner.load };
}

/**
 * The routing policy. PURE and fail-closed — no I/O. Given the live account
 * inventory, the request scope, and best-effort quota/capability, returns the
 * one (instance, harness, model) to dispatch on, or throws a refusal.
 *
 * Refusals (never dispatched):
 *  - `scope: "ssb"` with no enabled SSB account (matched by `ssbMatcher`);
 *  - `scope: "ssb"` matching more than one SSB account (ambiguous — refuse
 *    rather than guess which login is the client's);
 *  - a required `driver` or `needs` connector with no eligible instance in the
 *    allowed set.
 */
export function selectInstance(input: SelectInstanceInput): DispatchDecision {
  const ssbMatcher = input.ssbMatcher ?? defaultSsbMatcher;
  const modelByDriver = input.modelByDriver ?? DEFAULT_MODEL_BY_DRIVER;
  const saturationPercent = input.saturationPercent ?? 95;
  const enabled = input.accounts.filter(isEnabled);
  const ssbAccounts = enabled.filter(ssbMatcher);

  // ── Gate 1: NDA/client boundary (decided first, hard) ──────────────────────
  let allowed: ReadonlyArray<ProviderInstanceAccount>;
  if (input.scope === "ssb") {
    if (ssbAccounts.length === 0) {
      throw new MegazordDispatchError(
        "refused: scope 'ssb' requires the SSB account (enabled claudeAgent marked 'SSB'), " +
          "which is not available — never falling back to another account",
        { refusal: true },
      );
    }
    if (ssbAccounts.length > 1) {
      throw new MegazordDispatchError(
        `refused: scope 'ssb' is ambiguous — ${ssbAccounts.length} accounts match the SSB ` +
          `predicate (${ssbAccounts.map((a) => a.instanceId).join(", ")}); refuse rather than guess`,
        { refusal: true },
      );
    }
    allowed = ssbAccounts;
  } else {
    // general: the pool is everything EXCEPT the SSB account(s).
    allowed = enabled.filter((a) => !ssbMatcher(a));
    if (allowed.length === 0) {
      throw new MegazordDispatchError(
        "refused: scope 'general' has no non-SSB account to route to",
        { refusal: true },
      );
    }
  }

  // ── Gate 2: capability (required harness) ──────────────────────────────────
  let candidates = allowed;
  if (input.driver !== undefined) {
    candidates = candidates.filter((a) => a.driver === input.driver);
    if (candidates.length === 0) {
      throw new MegazordDispatchError(
        `refused: no ${input.scope} account with harness '${input.driver}' available`,
        { refusal: true },
      );
    }
  }

  // ── Gate 2b: capability (required exclusive connector) ─────────────────────
  if (input.needs !== undefined && input.needs.trim() !== "") {
    const need = input.needs.trim();
    const caps = input.capabilities ?? {};
    candidates = candidates.filter((a) => (caps[a.instanceId] ?? []).includes(need));
    if (candidates.length === 0) {
      throw new MegazordDispatchError(
        `refused: no ${input.scope} account exposes the required connector '${need}' ` +
          `(capability inventory ${input.capabilities ? "did not list it" : "was not provided"})`,
        { refusal: true },
      );
    }
  }

  // ── Gate 3: quota (least-loaded, deterministic tie-break) ──────────────────
  const { account, load } = pickLeastLoaded(candidates, input.usage, saturationPercent);
  const model = resolveModel(account, modelByDriver, input.model, input.modelsByDriver);

  const reasonParts: string[] = [`scope=${input.scope}`];
  if (input.scope === "ssb") reasonParts.push("SSB-exclusive account");
  if ((input.model ?? "").trim() !== "") reasonParts.push(`model pinned=${input.model}`);
  if (input.driver !== undefined) reasonParts.push(`driver=${input.driver}`);
  if (input.needs) reasonParts.push(`needs=${input.needs}`);
  reasonParts.push(
    load !== undefined
      ? `least-loaded (${load}% used)`
      : candidates.length === 1
        ? "sole eligible instance"
        : "deterministic order (quota unknown)",
  );

  return {
    instanceId: account.instanceId,
    driver: account.driver,
    model,
    scope: input.scope,
    reason: reasonParts.join(", "),
    ...(load !== undefined ? { load } : {}),
    consideredInstanceIds: candidates.map((a) => a.instanceId),
  };
}

// ── Live readers (origin / accounts) ──────────────────────────────────────────

/** Default T3 base dir. */
export function defaultBaseDir(): string {
  return nodePath.join(os.homedir(), ".t3");
}

/** Path to the desktop-written server runtime state under a base dir. */
export function serverRuntimeStatePath(baseDir: string): string {
  return nodePath.join(baseDir, "userdata", "server-runtime.json");
}

/** Path to the desktop settings under a base dir. */
export function settingsPath(baseDir: string): string {
  return nodePath.join(baseDir, "userdata", "settings.json");
}

/** Path to the cached provider model manifest under a base dir. */
export function modelManifestPath(baseDir: string): string {
  return nodePath.join(baseDir, "userdata", "model-manifest.json");
}

/** Path to the server-written environment id under a base dir. */
export function environmentIdPath(baseDir: string): string {
  return nodePath.join(baseDir, "userdata", "environment-id");
}

/**
 * Read the running server's `origin` from `server-runtime.json`. This is how the
 * orchestrator finds the desktop's loopback HTTP server without any config.
 */
export async function resolveOrigin(baseDir: string = defaultBaseDir()): Promise<string> {
  const file = serverRuntimeStatePath(baseDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new MegazordDispatchError(
      `cannot read T3 server runtime state at ${file} — is the desktop running? ` +
        `(${String((cause as Error)?.message ?? cause)})`,
      { refusal: true },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MegazordDispatchError(`server runtime state is not valid JSON: ${file}`, {
      refusal: true,
    });
  }
  const origin = (parsed as { origin?: unknown })?.origin;
  if (typeof origin !== "string" || origin.trim() === "") {
    throw new MegazordDispatchError(`server runtime state has no usable origin: ${file}`, {
      refusal: true,
    });
  }
  return origin.replace(/\/+$/, "");
}

/**
 * Read the valid model ids per harness from the desktop's cached manifest. This is
 * purely an input to validation, so an unreadable manifest returns `{}` (no gate)
 * rather than blocking a dispatch that would otherwise work.
 */
export async function readDriverModels(
  baseDir: string = defaultBaseDir(),
): Promise<Readonly<Record<string, ReadonlyArray<string>>>> {
  try {
    const parsed = JSON.parse(await readFile(modelManifestPath(baseDir), "utf8")) as {
      manifest?: { currentModels?: unknown };
    };
    const current = parsed?.manifest?.currentModels;
    if (current === null || typeof current !== "object") return {};
    const out: Record<string, ReadonlyArray<string>> = {};
    for (const [driver, ids] of Object.entries(current as Record<string, unknown>)) {
      if (Array.isArray(ids)) {
        out[driver] = ids.filter((id): id is string => typeof id === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read this machine's environment id, written by the server into the same state
 * dir as `server-runtime.json`. A thread link is `<origin>/<environmentId>/<threadId>`
 * — the id is half the address, so a link built without it is not openable.
 */
export async function resolveEnvironmentId(baseDir: string = defaultBaseDir()): Promise<string> {
  const file = environmentIdPath(baseDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new MegazordDispatchError(
      `cannot read T3 environment id at ${file} — is the desktop running? ` +
        `(${String((cause as Error)?.message ?? cause)})`,
      { refusal: true },
    );
  }
  const id = text.trim();
  if (id === "") {
    throw new MegazordDispatchError(`environment id file is empty: ${file}`, { refusal: true });
  }
  return id;
}

/**
 * Read the connected provider instances from `settings.json`. LIVE by design —
 * add/rename/disable of an account is picked up next call, never hardcoded.
 */
export async function readAccounts(
  baseDir: string = defaultBaseDir(),
): Promise<ReadonlyArray<ProviderInstanceAccount>> {
  const file = settingsPath(baseDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new MegazordDispatchError(
      `cannot read T3 settings at ${file}: ${String((cause as Error)?.message ?? cause)}`,
      { refusal: true },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MegazordDispatchError(`T3 settings is not valid JSON: ${file}`, { refusal: true });
  }
  return parseAccounts(parsed);
}

/** Extract the account inventory from a parsed settings object. Exposed for tests. */
export function parseAccounts(settings: unknown): ReadonlyArray<ProviderInstanceAccount> {
  const providerInstances = (settings as { providerInstances?: unknown })?.providerInstances;
  if (providerInstances === null || typeof providerInstances !== "object") return [];
  const out: ProviderInstanceAccount[] = [];
  for (const [instanceId, raw] of Object.entries(providerInstances as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const driver = typeof entry["driver"] === "string" ? (entry["driver"] as string) : "";
    if (driver === "") continue;
    const config = (entry["config"] ?? {}) as Record<string, unknown>;
    const customModels = Array.isArray(config["customModels"])
      ? (config["customModels"] as unknown[])
      : [];
    const firstCustom = customModels.find(
      (m): m is { id?: string } => m !== null && typeof m === "object",
    );
    out.push({
      instanceId,
      driver,
      ...(typeof entry["displayName"] === "string"
        ? { displayName: entry["displayName"] as string }
        : {}),
      ...(typeof entry["enabled"] === "boolean" ? { enabled: entry["enabled"] as boolean } : {}),
      ...(typeof config["homePath"] === "string" ? { homePath: config["homePath"] as string } : {}),
      ...(firstCustom && typeof firstCustom.id === "string"
        ? { preferredModel: firstCustom.id }
        : {}),
    });
  }
  return out;
}

// ── The client ───────────────────────────────────────────────────────────────

/** How to mint a session token headlessly. Overridable for tests / alt runtimes. */
export interface MintTokenCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface MegazordT3DispatchClientOptions {
  /** T3 base dir. Defaults to `~/.t3`. */
  readonly baseDir?: string;
  /** Skip discovery: use this origin instead of reading server-runtime.json. */
  readonly origin?: string;
  /** Skip minting: use this bearer token (scope `orchestration:operate`). */
  readonly token?: string;
  /** Skip discovery: use this environment id instead of reading `environment-id`. */
  readonly environmentId?: string;
  /** Override the token-mint command. Defaults to `node <server>/bin.ts auth session issue`. */
  readonly mintTokenCommand?: MintTokenCommand;
  /** Node executable used to mint. Defaults to `process.execPath`. */
  readonly nodeBin?: string;
  /** Absolute path to the server CLI entrypoint (`apps/server/src/bin.ts`). */
  readonly serverBinPath?: string;
  /** Live quota source. Defaults to none (quota unknown → deterministic order). */
  readonly usageSource?: UsageSource;
  /** Connector inventory per instance, for `needs` routing. */
  readonly capabilities?: InstanceCapabilities;
  /** SSB-account predicate. Defaults to {@link defaultSsbMatcher}. */
  readonly ssbMatcher?: SsbMatcher;
  /** Model overrides per harness. */
  readonly modelByDriver?: Readonly<Record<string, string>>;
  /** Inject valid model ids per harness (skips reading the manifest). For tests. */
  readonly modelsByDriver?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Inject the account inventory (skips reading settings.json). For tests. */
  readonly accounts?: ReadonlyArray<ProviderInstanceAccount>;
  /** Default runtime mode for spawned turns. Defaults to `approval-required` (safe). */
  readonly runtimeMode?: RuntimeMode;
  /** Max ms for the mint subprocess. Default 60000. */
  readonly mintTimeoutMs?: number;
  /** Max ms per dispatch HTTP call. Default 15000. */
  readonly timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable uuid generator (tests). Defaults to `crypto.randomUUID`. */
  readonly uuid?: () => string;
  /** Injectable clock (tests). Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
}

/** Where the thread lives, for the caller to open / correlate. */
export interface DispatchOutcome {
  readonly threadId: string;
  readonly instanceId: string;
  readonly driver: ProviderDriver | string;
  readonly model: string;
  /** Deep link to the thread in the T3 UI (`<origin>/<environmentId>/<threadId>`). */
  readonly url: string;
  /** What ran: `select` (no dispatch), `create` (thread only), or `full` (thread + first turn). */
  readonly mode: "select" | "create" | "full";
  /** True when the turn continued an existing thread instead of creating one. */
  readonly reusedThread?: boolean;
  /** Dispatch sequence of the last command, when a dispatch happened. */
  readonly sequence?: number;
  readonly decision: DispatchDecision;
}

/** A dispatch request from the wa-orchestrator. */
export interface DispatchRequest {
  /** The prompt/task text to run as the thread's first turn. */
  readonly task: string;
  /** NDA/quota scope. `ssb` = SSB-exclusive; `general` = the pool of three. */
  readonly scope: DispatchScope;
  /** Target project id (from the snapshot). Required for `create`/`full`. */
  readonly projectId?: string;
  /** Resolve the project id by exact title match against the live snapshot. */
  readonly projectTitle?: string;
  /** Require a specific harness. */
  readonly driver?: ProviderDriver;
  /** Require an exclusive connector. */
  readonly needs?: string;
  /** Pin the model for this thread (validated against the harness's manifest). */
  readonly model?: string;
  /**
   * Continue an EXISTING thread instead of creating one: skips `thread.create` and
   * only starts a turn. This is what makes a chat channel one conversation rather
   * than a new thread per message. Refused if the thread is gone or deleted.
   */
  readonly threadId?: string;
  /** Thread title. Defaults to a truncated task. */
  readonly title?: string;
  /** Runtime mode override for this turn. */
  readonly runtimeMode?: RuntimeMode;
  /** Interaction mode. `plan` keeps the agent in planning (no edits). */
  readonly interactionMode?: InteractionMode;
  /**
   * How far to go:
   *  - `"select"`: run the policy only, NO network dispatch (prove the choice
   *    without touching the account — the safe SSB dry-run);
   *  - `"create"`: `thread.create` only (thread appears; NO harness spawns, NO
   *    quota spent);
   *  - `"full"` (default): `thread.create` + `thread.turn.start` (spawns the
   *    harness under `runtimeMode`).
   */
  readonly mode?: "select" | "create" | "full";
}

/** How a turn ended, from the caller's point of view. */
export type TurnWaitState =
  | "completed"
  | "error"
  | "interrupted"
  | "running"
  /** The agent asked the human a question and is blocked until it is answered. */
  | "awaiting-input";

/** One question the agent is blocked on, flattened for a text channel. */
export interface PendingQuestion {
  readonly id: string;
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<string>;
  readonly multiSelect: boolean;
}

/** The agent's open question, with the id needed to answer it. */
export interface PendingUserInput {
  readonly requestId: string;
  readonly questions: ReadonlyArray<PendingQuestion>;
}

/** The result of waiting on a dispatched turn. */
export interface TurnWaitOutcome {
  readonly threadId: string;
  readonly turnId: string;
  /** `running` means the wait timed out with the turn still going (or blocked on an approval). */
  readonly state: TurnWaitState;
  /** Assistant text produced by that turn, joined. Empty when the turn produced none. */
  readonly text: string;
  /** Deep link to the thread in the T3 UI. */
  readonly url: string;
  /** True when the wait hit its own ceiling rather than a terminal state. */
  readonly timedOut: boolean;
  /** Set when `state` is `awaiting-input`: what the agent asked, and how to answer. */
  readonly pendingInput?: PendingUserInput;
}

/**
 * The result of a full round-trip: append one turn to an existing thread AND read
 * that turn's answer back. It is the {@link TurnWaitOutcome} plus which
 * (instance, harness, model) the owner ran the turn on and the dispatch sequence
 * of the `thread.turn.start` that opened it.
 */
export interface TurnRoundTripOutcome extends TurnWaitOutcome {
  readonly instanceId: string;
  readonly driver: ProviderDriver | string;
  readonly model: string;
  /** Dispatch sequence of the `thread.turn.start` that opened the round-trip. */
  readonly sequence: number;
}

const TERMINAL_TURN_STATES: ReadonlyArray<string> = ["completed", "error", "interrupted"];
const DEFAULT_WAIT_TIMEOUT_MS = 900_000;
const DEFAULT_WAIT_POLL_MS = 2_000;

const DEFAULT_MINT_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Talks to the live T3 server to dispatch orchestrator work as a routed thread.
 * Construct once per machine; call {@link dispatch} per request.
 */
export class MegazordT3DispatchClient {
  private readonly baseDir: string;
  private readonly originOverride: string | undefined;
  private readonly tokenOverride: string | undefined;
  private readonly environmentIdOverride: string | undefined;
  private readonly mintTokenCommand: MintTokenCommand | undefined;
  private readonly nodeBin: string;
  private readonly serverBinPath: string;
  private readonly usageSource: UsageSource | undefined;
  private readonly capabilities: InstanceCapabilities | undefined;
  private readonly ssbMatcher: SsbMatcher;
  private readonly modelByDriver: Readonly<Record<string, string>>;
  private readonly accountsOverride: ReadonlyArray<ProviderInstanceAccount> | undefined;
  private readonly modelsByDriverOverride:
    | Readonly<Record<string, ReadonlyArray<string>>>
    | undefined;
  private readonly runtimeMode: RuntimeMode;
  private readonly mintTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly uuid: () => string;
  private readonly now: () => string;

  private cachedOrigin: string | undefined;
  private cachedToken: string | undefined;
  private cachedEnvironmentId: string | undefined;

  constructor(options: MegazordT3DispatchClientOptions = {}) {
    this.baseDir = options.baseDir ?? defaultBaseDir();
    this.originOverride = options.origin;
    this.tokenOverride = options.token;
    this.environmentIdOverride = options.environmentId;
    this.mintTokenCommand = options.mintTokenCommand;
    this.nodeBin = options.nodeBin ?? process.execPath;
    this.serverBinPath = options.serverBinPath ?? defaultServerBinPath();
    this.usageSource = options.usageSource;
    this.capabilities = options.capabilities;
    this.ssbMatcher = options.ssbMatcher ?? defaultSsbMatcher;
    this.modelByDriver = options.modelByDriver ?? DEFAULT_MODEL_BY_DRIVER;
    this.accountsOverride = options.accounts;
    this.modelsByDriverOverride = options.modelsByDriver;
    this.runtimeMode = options.runtimeMode ?? "approval-required";
    this.mintTimeoutMs = options.mintTimeoutMs ?? DEFAULT_MINT_TIMEOUT_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Resolve the live server origin (cached). */
  async origin(): Promise<string> {
    if (this.originOverride !== undefined) return this.originOverride.replace(/\/+$/, "");
    if (this.cachedOrigin !== undefined) return this.cachedOrigin;
    this.cachedOrigin = await resolveOrigin(this.baseDir);
    return this.cachedOrigin;
  }

  /** Resolve this machine's environment id (cached). */
  async environmentId(): Promise<string> {
    if (this.environmentIdOverride !== undefined) return this.environmentIdOverride;
    if (this.cachedEnvironmentId !== undefined) return this.cachedEnvironmentId;
    this.cachedEnvironmentId = await resolveEnvironmentId(this.baseDir);
    return this.cachedEnvironmentId;
  }

  /** Mint (or reuse) a bearer token with `orchestration:operate` scope (cached). */
  async token(): Promise<string> {
    if (this.tokenOverride !== undefined) return this.tokenOverride;
    if (this.cachedToken !== undefined) return this.cachedToken;
    this.cachedToken = await this.mintToken();
    return this.cachedToken;
  }

  /** Read the live account inventory (or the injected override). */
  async accounts(): Promise<ReadonlyArray<ProviderInstanceAccount>> {
    if (this.accountsOverride !== undefined) return this.accountsOverride;
    return readAccounts(this.baseDir);
  }

  /** Valid model ids per harness (or the injected override). */
  async driverModels(): Promise<Readonly<Record<string, ReadonlyArray<string>>>> {
    if (this.modelsByDriverOverride !== undefined) return this.modelsByDriverOverride;
    return readDriverModels(this.baseDir);
  }

  /** Read best-effort quota (empty when no source configured). */
  async usage(): Promise<ReadonlyArray<InstanceUsage>> {
    if (this.usageSource === undefined) return [];
    try {
      return await this.usageSource();
    } catch {
      // Quota is an optimization, never a gate: a failing source must not block.
      return [];
    }
  }

  /**
   * Run the routing policy against the LIVE inventory + quota, without any
   * dispatch. This is the cheap "prove the selection" path — safe for SSB.
   */
  async select(
    request: Pick<DispatchRequest, "scope" | "driver" | "needs" | "model">,
  ): Promise<DispatchDecision> {
    const pinned = (request.model ?? "").trim();
    const [accounts, usage, modelsByDriver] = await Promise.all([
      this.accounts(),
      this.usage(),
      pinned === "" ? Promise.resolve({}) : this.driverModels(),
    ]);
    return selectInstance({
      accounts,
      scope: request.scope,
      usage,
      ssbMatcher: this.ssbMatcher,
      modelByDriver: this.modelByDriver,
      ...(pinned !== "" ? { model: pinned, modelsByDriver } : {}),
      ...(request.driver !== undefined ? { driver: request.driver } : {}),
      ...(request.needs !== undefined ? { needs: request.needs } : {}),
      ...(this.capabilities !== undefined ? { capabilities: this.capabilities } : {}),
    });
  }

  /**
   * Dispatch a request: resolve origin → token → accounts → quota → route →
   * (optionally) `thread.create` + `thread.turn.start`.
   */
  async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    if (request.task.trim() === "" && (request.mode ?? "full") !== "select") {
      throw new MegazordDispatchError("refused: task text is required for create/full dispatch", {
        refusal: true,
      });
    }
    const mode = request.mode ?? "full";
    const decision = await this.select(request);

    if (mode === "select") {
      return {
        threadId: "",
        instanceId: decision.instanceId,
        driver: decision.driver,
        model: decision.model,
        url: "",
        mode: "select",
        decision,
      };
    }

    // The environment id is resolved UP FRONT (not after create) so a machine that
    // cannot produce an openable link fails before a thread exists, not after.
    const [origin, token, environmentId] = await Promise.all([
      this.origin(),
      this.token(),
      this.environmentId(),
    ]);
    const continuing = (request.threadId ?? "").trim();
    const runtimeMode = request.runtimeMode ?? this.runtimeMode;
    const interactionMode = request.interactionMode ?? "default";

    if (continuing !== "") {
      // Continue the conversation: the thread already carries the history, the
      // provider session and its own runtime mode (the decider ignores a runtime
      // override on an existing thread), so only the turn is sent.
      if (!(await this.threadIsOpen(origin, token, continuing))) {
        throw new MegazordDispatchError(
          `refused: thread '${continuing}' is not open on this machine (gone or deleted)`,
          { refusal: true },
        );
      }
      const seq = await this.startTurn(origin, token, {
        threadId: continuing,
        task: request.task,
        decision,
        runtimeMode,
        interactionMode,
      });
      return {
        threadId: continuing,
        instanceId: decision.instanceId,
        driver: decision.driver,
        model: decision.model,
        url: `${origin}/${environmentId}/${continuing}`,
        mode: "full",
        sequence: seq,
        reusedThread: true,
        decision,
      };
    }

    const projectId = await this.resolveProjectId(origin, token, request);
    const threadId = this.uuid();
    const title = (request.title ?? request.task).trim().slice(0, 80) || "orchestrated thread";

    const createSeq = await this.postDispatch(origin, token, {
      type: "thread.create",
      commandId: this.uuid(),
      threadId,
      projectId,
      title,
      modelSelection: { instanceId: decision.instanceId, model: decision.model },
      runtimeMode,
      interactionMode,
      branch: null,
      worktreePath: null,
      createdAt: this.now(),
    });

    // The UI route (`/$environmentId/$threadId`), NOT the API endpoint: this url is
    // relayed to humans (WhatsApp), and /api/orchestration/threads/<id> answers 401
    // JSON in a browser instead of opening the thread.
    const url = `${origin}/${environmentId}/${threadId}`;
    if (mode === "create") {
      return {
        threadId,
        instanceId: decision.instanceId,
        driver: decision.driver,
        model: decision.model,
        url,
        mode: "create",
        sequence: createSeq,
        decision,
      };
    }

    const turnSeq = await this.startTurn(origin, token, {
      threadId,
      task: request.task,
      decision,
      runtimeMode,
      interactionMode,
    });

    return {
      threadId,
      instanceId: decision.instanceId,
      driver: decision.driver,
      model: decision.model,
      url,
      mode: "full",
      sequence: turnSeq,
      decision,
    };
  }

  /** Send one user turn to a thread (new or continuing). */
  private async startTurn(
    origin: string,
    token: string,
    input: {
      readonly threadId: string;
      readonly task: string;
      readonly decision: DispatchDecision;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: InteractionMode;
    },
  ): Promise<number> {
    return this.postDispatch(origin, token, {
      type: "thread.turn.start",
      commandId: this.uuid(),
      threadId: input.threadId,
      message: {
        messageId: this.uuid(),
        role: "user",
        text: input.task,
        attachments: [],
      },
      modelSelection: {
        instanceId: input.decision.instanceId,
        model: input.decision.model,
      },
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: this.now(),
    });
  }

  /**
   * Is this thread still a place a turn can land? A caller holding a remembered
   * thread id needs to tell "keep the conversation" from "it is gone, start over".
   */
  async threadIsOpen(origin: string, token: string, threadId: string): Promise<boolean> {
    try {
      const thread = await this.readThread(origin, token, threadId);
      return thread.deletedAt === null && thread.archivedAt === null;
    } catch {
      return false;
    }
  }

  /** Resolve the project id from the request (explicit id, or exact-title match). */
  private async resolveProjectId(
    origin: string,
    token: string,
    request: DispatchRequest,
  ): Promise<string> {
    const explicit = (request.projectId ?? "").trim();
    if (explicit !== "") return explicit;
    const wantedTitle = (request.projectTitle ?? "").trim();
    if (wantedTitle === "") {
      throw new MegazordDispatchError(
        "refused: dispatch needs a projectId or projectTitle to place the thread",
        { refusal: true },
      );
    }
    const projects = await this.listProjects(origin, token);
    const match = projects.find((p) => p.title === wantedTitle && p.deletedAt === null);
    if (match === undefined) {
      throw new MegazordDispatchError(
        `refused: no active project titled '${wantedTitle}' in the live snapshot`,
        { refusal: true },
      );
    }
    return match.id;
  }

  /**
   * Poll a dispatched thread until its latest turn reaches a terminal state, then
   * return that turn's assistant text.
   *
   * This is what turns a fire-and-forget dispatch into an answer a chat channel can
   * relay. It polls rather than streams on purpose: the caller is a short-lived CLI
   * invocation, and the thread snapshot endpoint is the same read the UI does.
   *
   * A turn blocked on an approval never reaches a terminal state, so the wait ends
   * with `state: "running", timedOut: true` instead of hanging forever — the caller
   * relays the link and the human takes over.
   */
  async awaitTurn(input: {
    readonly threadId: string;
    /** Ignore turns requested before this ISO instant (guards against a stale turn). */
    readonly since?: string;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
  }): Promise<TurnWaitOutcome> {
    const [origin, token, environmentId] = await Promise.all([
      this.origin(),
      this.token(),
      this.environmentId(),
    ]);
    const url = `${origin}/${environmentId}/${input.threadId}`;
    const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollMs = input.pollMs ?? DEFAULT_WAIT_POLL_MS;
    const sinceMs = input.since === undefined ? undefined : Date.parse(input.since);
    const deadline = Date.now() + timeoutMs;

    let lastTurnId = "";
    let lastState: TurnWaitState = "running";
    for (;;) {
      const thread = await this.readThread(origin, token, input.threadId);
      const turn = thread.latestTurn;
      // A turn that asked the human a question never terminates on its own. Report it
      // at once: waiting out the ceiling would leave the human staring at silence
      // while the agent stares at an unanswered question.
      const pending = pendingUserInput(thread.activities, turn?.turnId ?? "");
      if (pending !== undefined && turn !== undefined) {
        return {
          threadId: input.threadId,
          turnId: turn.turnId,
          state: "awaiting-input",
          text: assistantTextForTurn(thread.messages, turn.turnId),
          url,
          timedOut: false,
          pendingInput: pending,
        };
      }
      const fresh =
        turn !== undefined &&
        (sinceMs === undefined ||
          Number.isNaN(sinceMs) ||
          Date.parse(turn.requestedAt) >= sinceMs - 1000);
      if (turn !== undefined && fresh) {
        lastTurnId = turn.turnId;
        lastState = TERMINAL_TURN_STATES.includes(turn.state)
          ? (turn.state as TurnWaitState)
          : "running";
        if (TERMINAL_TURN_STATES.includes(turn.state)) {
          return {
            threadId: input.threadId,
            turnId: turn.turnId,
            state: lastState,
            text: assistantTextForTurn(thread.messages, turn.turnId),
            url,
            timedOut: false,
          };
        }
      }
      if (Date.now() >= deadline) {
        return {
          threadId: input.threadId,
          turnId: lastTurnId,
          state: lastState,
          text: lastTurnId === "" ? "" : assistantTextForTurn(thread.messages, lastTurnId),
          url,
          timedOut: true,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Append one turn to an EXISTING thread and return that turn's answer — the
   * atomic round-trip a thin CLIENT (the WhatsApp bridge, the T3 GUI, another
   * machine) makes against the single OWNER-hosted session. Exactly one thread is
   * the orchestrator's persistent conversation; every surface's turn appends to
   * it, so memory carries across turns and the reply flows back to whoever asked.
   *
   * It composes {@link dispatch} (continue the thread — `thread.turn.start`, no
   * `thread.create`) with {@link awaitTurn} (poll the snapshot for the assistant
   * reply). The `since` instant is captured BEFORE the turn is sent, so the wait
   * can never latch onto the PREVIOUS turn's answer — the race that would make a
   * continuity proof lie.
   *
   * Refused (never dispatched) if the thread is gone/deleted: a remembered id that
   * no longer accepts turns is an error, not a silent new thread. Pass the SAME
   * `scope`/`driver` the thread was created under — routing still runs to resolve
   * the model selection, and a mismatched scope would resolve a wrong account.
   */
  async sendTurnAndAwait(input: {
    /** The existing owner-hosted thread every surface appends to. */
    readonly threadId: string;
    /** The user turn text to append. */
    readonly task: string;
    /** NDA/quota scope — the SAME the thread was created under. */
    readonly scope: DispatchScope;
    /** Require a specific harness (match the thread's). */
    readonly driver?: ProviderDriver;
    /** Pin the model for this turn (validated against the harness's manifest). */
    readonly model?: string;
    /** Runtime mode override for this turn. */
    readonly runtimeMode?: RuntimeMode;
    /** Interaction mode. `plan` keeps the agent in planning (no edits). */
    readonly interactionMode?: InteractionMode;
    /** Wait ceiling. Default {@link DEFAULT_WAIT_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
    /** Poll interval. Default {@link DEFAULT_WAIT_POLL_MS}. */
    readonly pollMs?: number;
  }): Promise<TurnRoundTripOutcome> {
    const threadId = input.threadId.trim();
    if (threadId === "") {
      throw new MegazordDispatchError(
        "refused: sendTurnAndAwait needs an existing threadId to append the turn to",
        { refusal: true },
      );
    }
    if (input.task.trim() === "") {
      throw new MegazordDispatchError("refused: task text is required for a round-trip turn", {
        refusal: true,
      });
    }
    // Captured BEFORE the turn is sent: awaitTurn ignores any turn requested
    // before this instant, so it cannot return the prior turn's answer.
    const since = this.now();
    const out = await this.dispatch({
      task: input.task,
      scope: input.scope,
      threadId,
      ...(input.driver !== undefined ? { driver: input.driver } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });
    const wait = await this.awaitTurn({
      threadId,
      since,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
    });
    return {
      ...wait,
      instanceId: out.instanceId,
      driver: out.driver,
      model: out.model,
      sequence: out.sequence ?? -1,
    };
  }

  /** GET one thread's snapshot (the same read the UI does). */
  private async readThread(
    origin: string,
    token: string,
    threadId: string,
  ): Promise<{
    readonly latestTurn?: { turnId: string; state: string; requestedAt: string };
    readonly messages: ReadonlyArray<Record<string, unknown>>;
    readonly activities: ReadonlyArray<Record<string, unknown>>;
    readonly deletedAt: string | null;
    readonly archivedAt: string | null;
  }> {
    const res = await this.httpGet(
      `${origin}/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      token,
    );
    const body = (await safeJson(res)) as { thread?: Record<string, unknown> };
    const thread = body?.thread;
    if (thread === null || typeof thread !== "object") {
      throw new MegazordDispatchError(`thread ${threadId} not found on the live server`, {
        refusal: true,
      });
    }
    const rawTurn = thread["latestTurn"];
    const messages = Array.isArray(thread["messages"])
      ? (thread["messages"] as ReadonlyArray<Record<string, unknown>>)
      : [];
    const activities = Array.isArray(thread["activities"])
      ? (thread["activities"] as ReadonlyArray<Record<string, unknown>>)
      : [];
    const deletedAt = (thread["deletedAt"] as string | null | undefined) ?? null;
    const archivedAt = (thread["archivedAt"] as string | null | undefined) ?? null;
    if (rawTurn === null || typeof rawTurn !== "object") {
      return { messages, activities, deletedAt, archivedAt };
    }
    const t = rawTurn as Record<string, unknown>;
    return {
      latestTurn: {
        turnId: String(t["turnId"] ?? ""),
        state: String(t["state"] ?? ""),
        requestedAt: String(t["requestedAt"] ?? ""),
      },
      messages,
      activities,
      deletedAt,
      archivedAt,
    };
  }

  /**
   * Answer the question the agent is blocked on, as a human would in the UI.
   *
   * The same free-text answer is applied to every question in the request: a chat
   * channel has one reply box, not a form, and the agent reads prose fine. Option
   * labels work too — typing a label matches it exactly.
   */
  async respondUserInput(input: {
    readonly threadId: string;
    readonly requestId: string;
    readonly answer: string;
    /** Question ids to answer. Defaults to whatever the thread currently asks. */
    readonly questionIds?: ReadonlyArray<string>;
  }): Promise<number> {
    const [origin, token] = await Promise.all([this.origin(), this.token()]);
    let ids = input.questionIds ?? [];
    if (ids.length === 0) {
      const thread = await this.readThread(origin, token, input.threadId);
      const pending = pendingUserInput(thread.activities, thread.latestTurn?.turnId ?? "");
      if (pending === undefined || pending.requestId !== input.requestId) {
        throw new MegazordDispatchError(
          `refused: thread '${input.threadId}' has no open question '${input.requestId}'`,
          { refusal: true },
        );
      }
      ids = pending.questions.map((q) => q.id);
    }
    const answers: Record<string, string> = {};
    for (const id of ids) answers[id] = input.answer;
    return this.postDispatch(origin, token, {
      type: "thread.user-input.respond",
      commandId: this.uuid(),
      threadId: input.threadId,
      requestId: input.requestId,
      answers,
      createdAt: this.now(),
    });
  }

  /** GET the orchestration snapshot and return its active projects. */
  async listProjects(
    origin?: string,
    token?: string,
  ): Promise<ReadonlyArray<{ id: string; title: string; deletedAt: string | null }>> {
    const o = origin ?? (await this.origin());
    const t = token ?? (await this.token());
    const res = await this.httpGet(`${o}/api/orchestration/snapshot`, t);
    const body = (await safeJson(res)) as { projects?: unknown };
    const projects = Array.isArray(body?.projects) ? body.projects : [];
    return projects
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
      .map((p) => ({
        id: String(p["id"] ?? ""),
        title: String(p["title"] ?? ""),
        deletedAt: (p["deletedAt"] as string | null | undefined) ?? null,
      }))
      .filter((p) => p.id !== "");
  }

  // ── HTTP + subprocess plumbing ──────────────────────────────────────────────

  private async postDispatch(
    origin: string,
    token: string,
    command: Record<string, unknown>,
  ): Promise<number> {
    const url = `${origin}/api/orchestration/dispatch`;
    const res = await this.http(url, token, "POST", command);
    if (!res.ok) {
      const responseText = await safeText(res);
      throw new MegazordDispatchError(
        `dispatch ${String(command["type"])} rejected: ${res.status} ${res.statusText}`,
        { detail: { status: res.status, responseText } },
      );
    }
    const body = (await safeJson(res)) as { sequence?: unknown };
    return typeof body?.sequence === "number" ? body.sequence : -1;
  }

  private httpGet(url: string, token: string): Promise<Response> {
    return this.http(url, token, "GET");
  }

  private async http(
    url: string,
    token: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new MegazordDispatchError(
        `failed to reach T3 server at ${url}: ${String((cause as Error)?.message ?? cause)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Spawn the server CLI to issue a scoped bearer token, and parse it. */
  private async mintToken(): Promise<string> {
    const cmd = this.mintTokenCommand ?? {
      command: this.nodeBin,
      args: [this.serverBinPath, "auth", "session", "issue", "--base-dir", this.baseDir, "--json"],
    };
    const { stdout, stderr, code } = await runProcess(cmd.command, cmd.args, this.mintTimeoutMs);
    if (code !== 0) {
      throw new MegazordDispatchError(`token mint exited with code ${code}`, {
        detail: { stdout, stderr, code },
      });
    }
    const parsed = parseJsonLoose(stdout);
    const token = (parsed as { token?: unknown })?.token;
    if (typeof token !== "string" || token.trim() === "") {
      throw new MegazordDispatchError("token mint produced no token", {
        detail: { stdout, stderr },
      });
    }
    return token;
  }
}

/** Resolve the default server CLI entrypoint from this package's location. */
export function defaultServerBinPath(): string {
  // packages/megazord/src/dispatch.ts → repo root → apps/server/src/bin.ts
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  return nodePath.resolve(here, "../../../apps/server/src/bin.ts");
}

function runProcess(
  cmd: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new MegazordDispatchError(`token mint timed out after ${timeoutMs}ms`, {
          detail: { stdout, stderr },
        }),
      );
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(
        new MegazordDispatchError(`failed to spawn token mint: ${err.message}`, {
          detail: { stdout, stderr },
        }),
      );
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
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
