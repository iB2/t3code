/**
 * Megazord MCP client — how the chair reaches a T3 environment since T3 0.1.0,
 * which removed the `/api/orchestration/*` routes the chair used to call.
 *
 * `/mcp` is the surface T3 documents for agents it did not start, so it is the
 * one expected to survive app updates. It only accepts sessions issued through
 * its OAuth flow, never a CLI-minted bearer token, which also ends the old
 * habit of minting a fresh session on every call:
 *
 *  - `login` runs the flow once per environment (dynamic registration, PKCE,
 *    loopback redirect). A person approves it in the browser and picks the
 *    access level; the credential lasts 30 days and has no refresh token.
 *  - The credential is kept by the OS: DPAPI on Windows, the login keychain on
 *    macOS. Elsewhere it falls back to a file only this user can read.
 *  - Every later call reuses it. An expired or revoked credential surfaces as
 *    {@link McpAuthError} with the command that renews it.
 *
 * An environment is any T3 server the chair may drive: `local` is the one on
 * this machine, found through its runtime file; more (another computer, over
 * LAN, Tailscale or T3 Connect) are named in `<base-dir>/chair/environments.json`.
 *
 * Framework-agnostic plain Node, like `dispatch.ts`.
 *
 * @module megazord/mcp
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import * as nodePath from "node:path";

import { serverRuntimeStatePath } from "./dispatch.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "t3-chair";
const LOCAL_ENVIRONMENT = "local";

// ── environments ────────────────────────────────────────────────────────────

export interface ChairEnvironment {
  readonly name: string;
  /** Full MCP endpoint, e.g. `http://127.0.0.1:3773/mcp`. */
  readonly mcpUrl: string;
}

/** The credential `login` stores for one environment. */
export interface StoredCredential {
  readonly mcpUrl: string;
  readonly token: string;
  /** ISO time the server said the token stops working, if it said. */
  readonly expiresAt: string | null;
}

/** Raised when an environment has no usable credential. The message says how to renew it. */
export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

/** Raised when a tool call reaches the server and the server reports it failed. */
export class McpToolError extends Error {
  readonly tool: string;

  constructor(tool: string, message: string) {
    super(`${tool}: ${message}`);
    this.name = "McpToolError";
    this.tool = tool;
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function mcpUrlOf(raw: unknown, name: string): string {
  if (typeof raw !== "string") throw new Error(`environment '${name}' has no mcpUrl`);
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`environment '${name}' mcpUrl must be http(s)`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The server on this machine, from the runtime file the desktop app writes. */
async function localEnvironment(baseDir: string): Promise<ChairEnvironment> {
  const file = serverRuntimeStatePath(baseDir);
  let origin: unknown;
  try {
    origin = (JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>)["origin"];
  } catch {
    throw new Error(`no running T3 server on this machine (cannot read ${file})`);
  }
  if (typeof origin !== "string" || origin === "") {
    throw new Error(`${file} names no server origin`);
  }
  return {
    name: LOCAL_ENVIRONMENT,
    mcpUrl: mcpUrlOf(`${origin.replace(/\/+$/, "")}/mcp`, "local"),
  };
}

/** Every environment the chair knows, `local` first. */
export async function loadEnvironments(baseDir: string): Promise<ReadonlyArray<ChairEnvironment>> {
  const file = nodePath.join(baseDir, "chair", "environments.json");
  let raw: unknown = { environments: [] };
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new Error(`${file} is not valid JSON`);
    }
  }
  const list = (raw as Record<string, unknown>)?.["environments"];
  if (!Array.isArray(list)) throw new Error(`${file} must hold {"environments": [...]}`);
  const configured = list.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const name = String(e["name"] ?? "");
    if (!NAME_PATTERN.test(name)) throw new Error(`${file}: invalid environment name '${name}'`);
    return { name, mcpUrl: mcpUrlOf(e["mcpUrl"], name) };
  });
  const local =
    configured.find((e) => e.name === LOCAL_ENVIRONMENT) ?? (await localEnvironment(baseDir));
  return [local, ...configured.filter((e) => e.name !== LOCAL_ENVIRONMENT)];
}

export async function resolveEnvironment(
  baseDir: string,
  name: string = LOCAL_ENVIRONMENT,
): Promise<ChairEnvironment> {
  const all = await loadEnvironments(baseDir);
  const found = all.find((e) => e.name === name);
  if (found === undefined) {
    throw new Error(`unknown environment '${name}'; known: ${all.map((e) => e.name).join(", ")}`);
  }
  return found;
}

/** The app origin of an environment, for deep links (`<origin>/<environmentId>/<threadId>`). */
export function appOrigin(env: ChairEnvironment): string {
  return new URL(env.mcpUrl).origin;
}

// ── credential store ────────────────────────────────────────────────────────

function run(cmd: string, args: ReadonlyArray<string>, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      [...args],
      { windowsHide: true, maxBuffer: 1 << 20, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${String(stderr || err.message).trim()}`));
        else resolve(String(stdout));
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

const POWERSHELL = ["-NoProfile", "-NonInteractive", "-Command"];
// DPAPI, current user: the file is useless to another account or machine.
const PS_PROTECT =
  "$t=[Console]::In.ReadToEnd(); (ConvertTo-SecureString -String $t -AsPlainText -Force) | ConvertFrom-SecureString";
const PS_UNPROTECT =
  "$e=[Console]::In.ReadToEnd().Trim(); $s=ConvertTo-SecureString -String $e; " +
  "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

function credentialFile(baseDir: string, env: string, ext: string): string {
  return nodePath.join(baseDir, "chair", "credentials", `${env}.${ext}`);
}

const KEYCHAIN_SERVICE = "t3-chair";

export async function saveCredential(
  baseDir: string,
  env: string,
  credential: StoredCredential,
): Promise<void> {
  const json = JSON.stringify(credential);
  if (process.platform === "darwin") {
    await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      env,
      "-w",
      json,
    ]);
    return;
  }
  const dir = nodePath.join(baseDir, "chair", "credentials");
  await mkdir(dir, { recursive: true });
  if (process.platform === "win32") {
    const sealed = (await run("powershell.exe", [...POWERSHELL, PS_PROTECT], json)).trim();
    await writeFile(credentialFile(baseDir, env, "dpapi"), sealed, "utf8");
    return;
  }
  const file = credentialFile(baseDir, env, "json");
  await writeFile(file, json, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function loadCredential(
  baseDir: string,
  env: string,
): Promise<StoredCredential | undefined> {
  let json: string;
  try {
    if (process.platform === "darwin") {
      json = await run("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        env,
        "-w",
      ]);
    } else if (process.platform === "win32") {
      const sealed = await readFile(credentialFile(baseDir, env, "dpapi"), "utf8");
      json = await run("powershell.exe", [...POWERSHELL, PS_UNPROTECT], sealed);
    } else {
      json = await readFile(credentialFile(baseDir, env, "json"), "utf8");
    }
  } catch {
    return undefined;
  }
  try {
    const c = JSON.parse(json.trim()) as Record<string, unknown>;
    if (typeof c["token"] !== "string" || typeof c["mcpUrl"] !== "string") return undefined;
    return {
      mcpUrl: c["mcpUrl"],
      token: c["token"],
      expiresAt: typeof c["expiresAt"] === "string" ? c["expiresAt"] : null,
    };
  } catch {
    return undefined;
  }
}

function loginHint(env: string): string {
  return `run \`t3-chair login${env === LOCAL_ENVIRONMENT ? "" : ` --env ${env}`}\``;
}

/** The stored credential for an environment, or an {@link McpAuthError} saying how to get one. */
export async function credentialFor(baseDir: string, env: ChairEnvironment): Promise<string> {
  const c = await loadCredential(baseDir, env.name);
  if (c === undefined) {
    throw new McpAuthError(
      `no T3 credential for environment '${env.name}'; ${loginHint(env.name)}`,
    );
  }
  // The local server may come back on another port; a remote one must be the
  // address the credential was issued for, so it is never sent elsewhere.
  if (env.name !== LOCAL_ENVIRONMENT && c.mcpUrl !== env.mcpUrl) {
    throw new McpAuthError(
      `the credential for '${env.name}' was issued by ${c.mcpUrl}, not ${env.mcpUrl}; ${loginHint(env.name)}`,
    );
  }
  if (c.expiresAt !== null && Date.parse(c.expiresAt) <= Date.now()) {
    throw new McpAuthError(
      `the T3 credential for '${env.name}' expired at ${c.expiresAt}; ${loginHint(env.name)}`,
    );
  }
  return c.token;
}

// ── MCP over streamable HTTP ────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Pull the JSON-RPC reply with `id` out of a JSON or SSE response body. */
function replyFrom(body: string, contentType: string, id: number): Json | undefined {
  const messages: Array<unknown> = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data !== "") messages.push(JSON.parse(data));
    }
  } else if (body.trim() !== "") {
    const parsed = JSON.parse(body) as unknown;
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return messages.find((m): m is Json => (m as Json | null)?.["id"] === id);
}

function toolText(result: Json): string {
  const content = Array.isArray(result["content"]) ? (result["content"] as Array<Json>) : [];
  return content
    .filter((c) => c?.["type"] === "text")
    .map((c) => String(c["text"] ?? ""))
    .join("\n");
}

/** One MCP session against one environment, reusing one stored credential. */
export class T3McpClient {
  readonly env: ChairEnvironment;
  private readonly token: string;
  private sessionId: string | undefined;
  private initialized = false;
  private nextId = 1;

  constructor(env: ChairEnvironment, token: string) {
    this.env = env;
    this.token = token;
  }

  private async post(payload: Json, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.initialized) headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    if (this.sessionId !== undefined) headers["Mcp-Session-Id"] = this.sessionId;
    const res = await fetch(this.env.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      throw new McpAuthError(
        `environment '${this.env.name}' rejected the stored credential (expired or revoked); ${loginHint(this.env.name)}`,
      );
    }
    return res;
  }

  private async request(method: string, params: Json, timeoutMs = 60_000): Promise<Json> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    const body = await res.text();
    if (!res.ok) throw new Error(`${method} failed: ${res.status} ${body.slice(0, 300)}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid !== null) this.sessionId = sid;
    const reply = replyFrom(body, res.headers.get("content-type") ?? "", id);
    if (reply === undefined) throw new Error(`${method}: the server sent no reply`);
    const error = reply["error"] as Json | undefined;
    if (error !== undefined) throw new Error(`${method}: ${String(error["message"] ?? "error")}`);
    return (reply["result"] ?? {}) as Json;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: "1" },
    });
    this.initialized = true;
    const res = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, 30_000);
    await res.text();
  }

  /** Call one T3 tool and return its structured result. */
  async call(tool: string, args: Json = {}, timeoutMs = 60_000): Promise<Json> {
    await this.init();
    const result = await this.request("tools/call", { name: tool, arguments: args }, timeoutMs);
    if (result["isError"] === true) throw new McpToolError(tool, toolText(result) || "failed");
    const structured = result["structuredContent"];
    if (structured !== null && typeof structured === "object") return structured as Json;
    const text = toolText(result);
    try {
      return JSON.parse(text) as Json;
    } catch {
      return { text };
    }
  }
}

export async function connect(baseDir: string, env: ChairEnvironment): Promise<T3McpClient> {
  return new T3McpClient(env, await credentialFor(baseDir, env));
}

// ── OAuth login ─────────────────────────────────────────────────────────────

const b64url = (buf: Buffer) => buf.toString("base64url");

async function getJson(url: string): Promise<Json> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return (await res.json()) as Json;
}

/** RFC 9728 / RFC 8414 discovery, starting from the 401 the endpoint answers. */
async function discover(mcpUrl: string): Promise<{ resource: string; as: Json }> {
  const probe = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  await probe.text();
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const url = new URL(mcpUrl);
  const prmUrl =
    /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ??
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  const prm = await getJson(prmUrl);
  const issuer = (prm["authorization_servers"] as Array<string> | undefined)?.[0];
  if (issuer === undefined) throw new Error(`${prmUrl} names no authorization server`);
  const iss = new URL(issuer);
  const path = iss.pathname.replace(/\/+$/, "");
  const as = await getJson(`${iss.origin}/.well-known/oauth-authorization-server${path}`);
  return { resource: String(prm["resource"] ?? mcpUrl), as };
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  execFile(cmd as string, args as Array<string>, { windowsHide: true }, () => {});
}

const PAGE = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>t3-chair</title><p style="font:16px system-ui;margin:3rem">${text}</p>`;

/** Wait for the browser to come back to the loopback redirect with a code. */
function awaitRedirect(expectedState: string, timeoutMs: number) {
  const server = createServer();
  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("no approval arrived in time; run login again"));
    }, timeoutMs);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, text: string, outcome: () => void) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE(text));
        clearTimeout(timer);
        server.close();
        outcome();
      };
      const error = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      if (url.searchParams.get("state") !== expectedState) {
        finish(400, "This sign-in does not match the one t3-chair started.", () =>
          reject(new Error("approval came back with an unexpected state")),
        );
      } else if (error !== null) {
        finish(200, `Sign-in was not approved (${error}). You can close this tab.`, () =>
          reject(new Error(`sign-in not approved: ${error}`)),
        );
      } else if (got === null) {
        finish(400, "The sign-in came back without a code.", () =>
          reject(new Error("approval came back without a code")),
        );
      } else {
        finish(200, "t3-chair is signed in. You can close this tab.", () => resolve(got));
      }
    });
  });
  return { ready, code };
}

export interface LoginResult {
  readonly env: string;
  readonly mcpUrl: string;
  readonly expiresAt: string | null;
}

/**
 * Sign the chair in to one environment and store the credential.
 * `announce` gets the approval URL, for when no browser can be opened here.
 */
export async function login(
  baseDir: string,
  env: ChairEnvironment,
  options: { announce: (url: string) => void; openBrowser?: boolean; timeoutMs?: number },
): Promise<LoginResult> {
  const { resource, as } = await discover(env.mcpUrl);
  const registration = await fetch(String(as["registration_endpoint"]), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      // Loopback redirects match on everything but the port (RFC 8252 §7.3).
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const client = (await registration.json()) as Json;
  if (!registration.ok || typeof client["client_id"] !== "string") {
    throw new Error(`client registration failed: ${registration.status} ${JSON.stringify(client)}`);
  }
  const clientId = client["client_id"];

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const redirect = awaitRedirect(state, options.timeoutMs ?? 10 * 60_000);
  const redirectUri = `http://127.0.0.1:${await redirect.ready}/callback`;

  const authorize = new URL(String(as["authorization_endpoint"]));
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
    scope: "orchestration:read orchestration:operate",
  })) {
    authorize.searchParams.set(k, v);
  }
  options.announce(authorize.toString());
  if (options.openBrowser !== false) openInBrowser(authorize.toString());
  const code = await redirect.code;

  const tokenRes = await fetch(String(as["token_endpoint"]), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const token = (await tokenRes.json()) as Json;
  if (!tokenRes.ok || typeof token["access_token"] !== "string") {
    throw new Error(`token exchange failed: ${tokenRes.status} ${JSON.stringify(token)}`);
  }
  const expiresIn = Number(token["expires_in"]);
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;
  await saveCredential(baseDir, env.name, {
    mcpUrl: env.mcpUrl,
    token: token["access_token"],
    expiresAt,
  });
  return { env: env.name, mcpUrl: env.mcpUrl, expiresAt };
}
