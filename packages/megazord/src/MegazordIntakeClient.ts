/**
 * MegazordIntakeClient — the transport primitive that connects a T3 thread to
 * the capiva-factory ("Megazord") agent factory.
 *
 * ## Why a client, and why this shape
 *
 * capiva-factory's intake is NOT its own HTTP server. It is a Node CLI /
 * importable function, `intake/ingest-request.mjs`, whose documented external
 * integration surfaces are (a) shelling out to the CLI, (b) importing
 * `ingestRequest()`, or (c) replicating its two side-effects. Submitting via
 * the CLI is the thinnest *correct* path: it reuses the factory's own tier
 * classification, NDA/isolation gating, dedup, and issue creation instead of
 * re-implementing them here. So {@link MegazordIntakeClient.submit} shells out
 * to that CLI and parses its `--json` result.
 *
 * Reading execution status has no dedicated intake endpoint. The factory
 * itself reads back from (1) the local `actionables/store.ndjson` and (2) the
 * running Paperclip org server at `http://127.0.0.1:3100`. This client mirrors
 * that: {@link MegazordIntakeClient.readActionable} reads the local store, and
 * {@link MegazordIntakeClient.getIssueStatus} does a read-only GET against
 * Paperclip. Neither call mutates the running factory.
 *
 * This module is deliberately framework-agnostic (plain Node, no Effect) so it
 * can be unit-typechecked and reused by the T3 `MegazordDriver`, by a CLI, or
 * by tests, without dragging in the server's Effect runtime.
 *
 * @module megazord/MegazordIntakeClient
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as nodePath from "node:path";

import {
  actionableStatusToTaskState,
  issueStatusToTaskState,
  type MegazordTaskState,
} from "./taskState.ts";

/** Domain routing hint understood by capiva-factory intake. */
export type MegazordDomain =
  | "conteudo"
  | "seo-aeo"
  | "conhecimento"
  | "ops"
  | "cross-cutting";

/**
 * A task submitted to the factory. Mirrors the fields consumed by
 * capiva-factory `intake/ingest-request.mjs` / `actionables/lib.mjs::normalize`.
 * Only `pedido` is strictly required; `proposta_de_solucao` is strongly
 * recommended (the factory auto-derives one if omitted, but supplying it keeps
 * the NO-NAKED-BACKLOG rule satisfied deterministically).
 */
export interface MegazordIntakeRequest {
  /** The request text (what to do). Required. */
  readonly pedido: string;
  /** Proposed solution / approach. Strongly recommended. */
  readonly proposta_de_solucao?: string;
  readonly dominio?: MegazordDomain;
  /** Evidence reference(s) backing the request. */
  readonly evidencia?: string | ReadonlyArray<string>;
  /** Routing/gating flags, e.g. `{ internal_isolated: true }`. */
  readonly flags?: Readonly<Record<string, boolean>>;
  /** External channel (e.g. `"linkedin"`) — forces a higher review tier. */
  readonly channel?: string;
  /** Target repo for a real-merge task — forces a higher review tier. */
  readonly target_repo?: string;
  /** Attribution. Defaults to `"bruno"` inside the factory. */
  readonly by?: string;
  /** Correlation id stored under the actionable's `origem.run_id`. */
  readonly run_id?: string;
}

/** Paperclip issue coordinates returned by intake after it creates the issue. */
export interface MegazordPaperclipRef {
  readonly issueId?: string;
  readonly issueIdent?: string;
  readonly assignee?: string;
  readonly assigneeId?: string;
  readonly url?: string;
}

/** Result of a successful {@link MegazordIntakeClient.submit}. */
export interface MegazordSubmitResult {
  /** Stable id of the persisted actionable (dedup key survives resubmits). */
  readonly actionableId: string;
  /** True when intake matched an existing actionable by dedup key. */
  readonly deduped: boolean;
  /** Review tier assigned by the factory (0/1/2), when present. */
  readonly tier?: number;
  /** Actionable status at submit time, normalized. */
  readonly state: MegazordTaskState;
  /** Paperclip issue coordinates for later status polling. */
  readonly paperclip: MegazordPaperclipRef;
  /** Raw parsed intake JSON, for callers that need factory-specific fields. */
  readonly raw: unknown;
}

/** Status read for a submitted task. */
export interface MegazordStatus {
  readonly state: MegazordTaskState;
  /** The underlying status string reported by the source. */
  readonly rawStatus: string;
  /** Which surface answered: the local actionable store or Paperclip. */
  readonly source: "actionable-store" | "paperclip-issue";
}

export interface MegazordIntakeClientOptions {
  /** Absolute path to the capiva-factory checkout. */
  readonly factoryDir: string;
  /** Paperclip org server base URL. Defaults to `http://127.0.0.1:3100`. */
  readonly paperclipBaseUrl?: string;
  /** Node executable used to run the intake CLI. Defaults to `process.execPath`. */
  readonly nodeBin?: string;
  /** Max ms to wait for the intake CLI before killing it. Defaults to 60000. */
  readonly submitTimeoutMs?: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_SUBMIT_TIMEOUT_MS = 60_000;

export interface MegazordIntakeErrorDetail {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

export class MegazordIntakeError extends Error {
  override readonly name = "MegazordIntakeError";
  readonly detail: MegazordIntakeErrorDetail | undefined;
  constructor(message: string, detail?: MegazordIntakeErrorDetail) {
    super(message);
    this.detail = detail;
  }
}

/**
 * Thin, dependency-free client over the capiva-factory intake. Construct once
 * per configured factory location; methods are stateless and safe to call
 * concurrently.
 */
export class MegazordIntakeClient {
  private readonly factoryDir: string;
  private readonly baseUrl: string;
  private readonly nodeBin: string;
  private readonly submitTimeoutMs: number;

  constructor(options: MegazordIntakeClientOptions) {
    this.factoryDir = options.factoryDir;
    this.baseUrl = (options.paperclipBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.nodeBin = options.nodeBin ?? process.execPath;
    this.submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  }

  /** Absolute path to the intake CLI entrypoint. */
  private intakeScriptPath(): string {
    return nodePath.join(this.factoryDir, "intake", "ingest-request.mjs");
  }

  /**
   * Submit a task to the factory. Shells out to `ingest-request.mjs --request
   * <json> --json`, which creates a Paperclip issue and appends an actionable
   * to the local store, then returns the parsed result.
   */
  async submit(request: MegazordIntakeRequest): Promise<MegazordSubmitResult> {
    if (request.pedido.trim() === "") {
      throw new MegazordIntakeError("`pedido` is required and must be non-empty");
    }
    const args = [this.intakeScriptPath(), "--request", JSON.stringify(request), "--json"];
    const { stdout, stderr, code } = await this.run(this.nodeBin, args, this.submitTimeoutMs);
    if (code !== 0) {
      throw new MegazordIntakeError(`intake CLI exited with code ${code}`, { stdout, stderr, code });
    }
    const parsed = parseJsonLoose(stdout);
    if (parsed === undefined || typeof parsed !== "object") {
      throw new MegazordIntakeError("could not parse intake CLI JSON output", { stdout, stderr });
    }
    return toSubmitResult(parsed as Record<string, unknown>);
  }

  /**
   * Read the current execution status of a submitted task from the running
   * Paperclip org server. Read-only GET; never mutates the factory.
   */
  async getIssueStatus(issueId: string): Promise<MegazordStatus> {
    const url = `${this.baseUrl}/api/issues/${encodeURIComponent(issueId)}`;
    const res = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new MegazordIntakeError(`Paperclip issue GET failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const rawStatus = typeof body["status"] === "string" ? (body["status"] as string) : "";
    return {
      state: issueStatusToTaskState(rawStatus),
      rawStatus,
      source: "paperclip-issue",
    };
  }

  /**
   * Read an actionable's current status from the local `actionables/store.ndjson`.
   * Returns `undefined` when no actionable with that id is present.
   *
   * `storePath` defaults to `<factoryDir>/actionables/store.ndjson`.
   */
  async readActionable(actionableId: string, storePath?: string): Promise<MegazordStatus | undefined> {
    const file = storePath ?? nodePath.join(this.factoryDir, "actionables", "store.ndjson");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    // The store is append-only NDJSON; a later line wins if an id repeats.
    let found: Record<string, unknown> | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const rec = parseJsonLoose(line);
      if (rec !== undefined && typeof rec === "object" && (rec as Record<string, unknown>)["id"] === actionableId) {
        found = rec as Record<string, unknown>;
      }
    }
    if (found === undefined) return undefined;
    const rawStatus = typeof found["status"] === "string" ? (found["status"] as string) : "";
    return {
      state: actionableStatusToTaskState(rawStatus),
      rawStatus,
      source: "actionable-store",
    };
  }

  /** Spawn a process, capture stdout/stderr, enforce a timeout. */
  private run(
    cmd: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, [...args], {
        cwd: this.factoryDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new MegazordIntakeError(`intake CLI timed out after ${timeoutMs}ms`, { stdout, stderr }));
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(new MegazordIntakeError(`failed to spawn intake CLI: ${err.message}`, { stdout, stderr }));
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
  }
}

/** Parse JSON, tolerating leading/trailing non-JSON log noise on stdout. */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to the last {...} block on the stream.
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

/** Shape the raw intake JSON (`{ ok, actionable, paperclip }`) into a result. */
function toSubmitResult(parsed: Record<string, unknown>): MegazordSubmitResult {
  const actionable = asRecord(parsed["actionable"]);
  const paperclip = asRecord(parsed["paperclip"]);
  const actionableId = typeof actionable?.["id"] === "string" ? (actionable["id"] as string) : "";
  if (actionableId === "") {
    throw new MegazordIntakeError("intake result missing actionable.id");
  }
  const status = typeof actionable?.["status"] === "string" ? (actionable["status"] as string) : "";
  const tier = typeof actionable?.["tier"] === "number" ? (actionable["tier"] as number) : undefined;
  const deduped = parsed["deduped"] === true;

  const ref: MegazordPaperclipRef = {
    ...stringField(paperclip, "issueId"),
    ...stringField(paperclip, "issueIdent"),
    ...stringField(paperclip, "assignee"),
    ...stringField(paperclip, "assigneeId"),
    ...stringField(paperclip, "url"),
  };

  return {
    actionableId,
    deduped,
    ...(tier === undefined ? {} : { tier }),
    state: actionableStatusToTaskState(status),
    paperclip: ref,
    raw: parsed,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Build a `{ key: value }` fragment only when the field is a non-empty string. */
function stringField(
  rec: Record<string, unknown> | undefined,
  key: string,
): Record<string, string> {
  const v = rec?.[key];
  return typeof v === "string" && v !== "" ? { [key]: v } : {};
}
