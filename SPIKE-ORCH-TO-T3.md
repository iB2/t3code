# SPIKE — Orchestrator → T3 live threads

**Goal:** make the work an external orchestrator dispatches show up as a **live thread
inside the T3 desktop the user already has open**, by talking to the running T3 server's
HTTP API — instead of spawning a shadow subagent in a separate Claude session that T3
never sees.

**Status:** **VIABLE — proven end to end against the live desktop server.** A demo thread
was created and a turn started on the user's running T3 instance via the HTTP API, with no
GUI interaction and no server restart.

**Method:** headless, read-only source review + live HTTP calls against the already-running
server. The Electron GUI was never opened; no second desktop/server was started.

---

## 1. Reaching the running server (mechanism + evidence)

### How the desktop exposes its server

The desktop-managed server binds **HTTP over loopback TCP** and writes a runtime-state file
on startup. There is no named pipe and no unix socket — it is a plain `127.0.0.1:<port>`
HTTP server.

- Bind: `NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port })`
  (see `apps/server/src/bin.test.ts` live-server harness and `apps/server/src/server.ts`).
- Port discovery file: `deriveServerPaths()` →
  `serverRuntimeStatePath = <baseDir>/userdata/server-runtime.json`
  (`apps/server/src/config.ts:139`).
- File schema `PersistedServerRuntimeState` (`apps/server/src/serverRuntimeState.ts:11`):
  `{ version, pid, host, port, origin, startedAt }`. `origin` is the ready-to-use base URL.
- Default `baseDir` is `~/.t3` (`resolveBaseDir` in `apps/server/src/os-jank.ts`; confirmed
  on this machine).

**Live evidence** (`~/.t3/userdata/server-runtime.json`):

```json
{
  "version": 1,
  "pid": 21048,
  "host": "127.0.0.1",
  "port": 3773,
  "origin": "http://127.0.0.1:3773",
  "startedAt": "..."
}
```

Unauthenticated liveness probe (`GET /.well-known/t3/environment`) returned HTTP 200:

```json
{"environmentId":"...","label":"...","platform":{"os":"windows","arch":"x64"},"serverVersion":"0.0.40", ...}
```

So the orchestrator finds the live server by: read `~/.t3/userdata/server-runtime.json` →
use `.origin`. (Optionally confirm `pid` is alive via `process.kill(pid, 0)` — see
`isProcessAlive`, `serverRuntimeState.ts:113`.)

### Auth (local, no user action required)

The orchestration endpoints use the `EnvironmentAuthenticatedAuth` middleware and accept a
**plain `Authorization: Bearer <token>`** (a `dpop` header exists but is **optional** — DPoP
is only enforced for DPoP-bound tokens; see `apps/server/src/auth/EnvironmentAuth.ts` and
`OptionalBearerHeaders` in `packages/contracts/src/environmentHttp.ts:57`).

Session tokens are HMAC-signed **and** must have a row in the shared `state.sqlite`
(`SessionStore.verify` checks both signature and DB row — `SessionStore.ts:718`). So a token
must be **issued**, not hand-forged. Issuance both signs the token and writes the session row
(`SessionStore.issue`, `SessionStore.ts:619`). This is a cross-process pattern the product
already relies on: the `t3 project` CLI mints a token in its own process and calls the live
server with it (`apps/server/src/cli/project.ts:209` `withProjectCliSessionToken` →
`:310` `fetchLiveOrchestrationSnapshot`). SQLite WAL makes the CLI-writer / server-reader
concurrency safe.

**Reproduced headlessly:**

```
node apps/server/src/bin.ts auth session issue --base-dir <baseDir> --json
```

returns a token whose scopes include `orchestration:operate` (the scope the dispatch
endpoint requires). The token verified against the **live** server: `GET
/api/orchestration/snapshot` with that Bearer returned HTTP 200 and the real project list.

> Because issuance requires read access to `<baseDir>/userdata/secrets/server-signing-key.bin`
> and the shared DB, **anything running as the user on this machine** can mint a working token
> for the running server. No pairing, OAuth, or user click is needed for a local orchestrator.

---

## 2. Command shape (`thread.create` + first prompt)

Endpoint: **`POST /api/orchestration/dispatch`**, `Authorization: Bearer <token>`,
`Content-Type: application/json`. Body is one `ClientOrchestrationCommand`
(`packages/contracts/src/orchestration.ts:1335`). Response is
`DispatchResult` = `{ "sequence": <int> }` (`orchestration.ts:2077`).

### `thread.create` (`orchestration.ts:1013`)

```jsonc
{
  "type": "thread.create",
  "commandId": "<uuid>",        // any non-empty string; use a uuid
  "threadId": "<uuid>",         // client-chosen id; reuse it for the turn
  "projectId": "<projectId>",   // from GET /api/orchestration/snapshot
  "title": "…",
  "modelSelection": { "instanceId": "<instance>", "model": "<model>", "options": [ … ] },
  "runtimeMode": "approval-required", // | auto-accept-edits | auto | full-access
  "interactionMode": "default",       // | plan
  "branch": null,
  "worktreePath": null,
  "createdAt": "<ISO-8601>"
}
```

### First prompt — `thread.turn.start` (client variant, `orchestration.ts:1225`)

This is what spawns the harness/session (the actual agent run). It can create the thread in
one shot via `bootstrap.createThread`, or run on a thread you already created.

```jsonc
{
  "type": "thread.turn.start",
  "commandId": "<uuid>",
  "threadId": "<same threadId>",
  "message": {
    "messageId": "<uuid>",
    "role": "user",
    "text": "…the prompt…",
    "attachments": []
  },
  "modelSelection": { … },   // optional; inherits the thread's if omitted
  "runtimeMode": "approval-required",
  "interactionMode": "default",
  "createdAt": "<ISO-8601>"
}
```

`runtimeMode: "approval-required"` is the safe default for a spawned turn: the agent pauses
at the first tool use and waits for the user's approval in T3 — nothing executes unattended.

---

## 3. Demo — thread created + turn started on the LIVE T3 (Gain A + B proven)

All three calls hit `http://127.0.0.1:3773` (the user's open desktop) with an issued Bearer.

1. **`GET /api/orchestration/snapshot`** → HTTP 200, returned the real project list
   (used it to pick a valid `projectId` — a local dev project).

2. **`POST /api/orchestration/dispatch`** `thread.create`, title `"[wa-orch demo] spike thread"`
   → **HTTP 200, `{"sequence":8635}`**. Thread id `b2edde7f-d744-4c51-a9d7-ddb8feb4b0c6`.
   Re-reading the snapshot confirmed the thread is present (`FOUND: true`, matching title,
   `deletedAt: null`) — i.e. **it shows up in the open T3.**

3. **`POST /api/orchestration/dispatch`** `thread.turn.start`, prompt
   `"demo: liste 3 arquivos deste diretorio (spike wa-orch -> T3)"`
   → **HTTP 200, `{"sequence":8637}`**. Thread detail
   (`GET /api/orchestration/threads/<id>`) then showed a **live session**:

```json
{
  "session": {
    "status": "starting",
    "providerName": "codex",
    "providerInstanceId": "codex",
    "runtimeMode": "approval-required",
    "activeTurnId": null
  },
  "messages": 1 // the user prompt, queued
}
```

**Gain A (thread appears in the user's open T3): PROVEN.**
**Gain B (a real harness/session spawns and runs, visible & expandable): PROVEN** — the
session went to `starting` under the `codex` harness, awaiting approval (nothing executed).

> Cleanup: the demo thread is left in place as visible proof; because it is
> `approval-required` it will sit at the approval gate. It can be archived/deleted from T3, or
> via a `thread.session.stop` + `thread.delete` dispatch.

---

## 4. Account + Harness routing (multi-account NDA/quota routing)

The user runs **multiple connected provider instances** (a mix of two harnesses). Routing a
conversation to the right **(account, harness)** is a first-class concept in the contract.

### The selector

The routing key is **`modelSelection.instanceId`** on `thread.create` / `thread.turn.start`
(plus `model` and `options`). Design (`packages/contracts/src/providerInstance.ts`):

- **`ProviderDriverKind`** = the **harness** implementation (`codex`, `claudeAgent`, …).
  Picks the protocol/adapter/probe.
- **`ProviderInstanceId`** = the **account/routing slug**, user-defined. Threads, sessions and
  bindings reference the **instance id, never the driver** — precisely so several instances of
  the _same_ harness can coexist, each with its own config and its own **authenticated
  account**.

**Account isolation = per-instance home dir.** Each instance carries a `homePath`
(and codex a `shadowHomePath`). The driver spawns the CLI with that home as its config dir —
e.g. Claude uses `CLAUDE_CONFIG_DIR=<homePath>` so each instance reads a **different set of
OAuth credentials** (`apps/server/src/provider/Drivers/ClaudeHome.ts:12,36`;
codex equivalent in `CodexHomeLayout.ts`). Different home ⇒ different logged-in account
⇒ different quota bucket. This is the hard boundary the NDA rule needs.

### Where the connected accounts live / how to list them

- **Authoritative config list:** `ServerSettings.providerInstances` — persisted at
  `~/.t3/userdata/settings.json` (local, gitignored). Each entry:
  `{ driver, displayName?, enabled, accentColor?, config: { homePath, shadowHomePath?, binaryPath?, … } }`.
  The orchestrator should read this file (or the settings RPC) to enumerate accounts — do
  **not** hardcode them.
- **Live availability / quota:** `UsageLimitsReport` /
  `UsageLimitSourceSnapshot` (`packages/contracts/src/providerUsageLimits.ts`), keyed by
  `instanceId` + `driver`, with `usedPercent` and `resetsAt` per window
  (`ServerProviderUsageWindow`). Served over the RPC channel (`packages/contracts/src/rpc.ts`),
  and it is what feeds the app's `/usage-limits` panel. This is the signal for
  spreading load across accounts.

### The account inventory on this machine (roles redacted for NDA)

Four enabled instances, two harnesses × two account sets. Slugs are the real routing keys;
client identity behind the display names is intentionally not reproduced here (it lives only
in the local, gitignored `settings.json`).

Real slugs are redacted (they encode org names and live only in the local, gitignored
`settings.json`); the illustrative slugs below preserve the _structure_ the orchestrator sees.

| `instanceId` (routing key) | harness (`driver`) | account isolation           | role                        |
| -------------------------- | ------------------ | --------------------------- | --------------------------- |
| `codex`                    | `codex`            | default home                | primary client-work account |
| `claudeAgent`              | `claudeAgent`      | default home                | primary client-work account |
| `codex_orgB`               | `codex`            | `shadowHomePath` (separate) | secondary-org account       |
| `claudeAgent_orgB`         | `claudeAgent`      | separate `homePath`         | secondary-org account       |

### How the orchestrator chooses (account, harness) per request

1. **NDA/client boundary (hard rule, decided first):** map the request's context to an
   **allowed account set**. Client work → only that client's account instances; other-org work
   → only that org's instances. Never dispatch a client's work on another account. Because the
   boundary is enforced by _which OAuth home the CLI logs into_, sending the wrong `instanceId`
   would run on the wrong login — so this check gates instance selection, not just a label.
2. **Capability:** within the allowed set, filter by harness needed for the task
   (Codex vs Claude) via `driver`.
3. **Quota:** among the survivors, pick the least-loaded via the `UsageLimitsReport`
   `usedPercent` (and avoid ones near reset). This is how work is spread across the accounts
   instead of exhausting one.
4. Dispatch `thread.create` (+ `thread.turn.start`) with the chosen
   `modelSelection.instanceId` / `model`.

---

## 5. Integration design — orchestrator → T3 (replacing the shadow subagent)

Today the external orchestrator spawns a subagent inside a separate Claude session (a
"shadow" run T3 cannot see). The change: **the orchestrator becomes a T3 client** and creates
the thread through the server, so the run is a first-class T3 thread the user can watch and
steer.

**Minimal client (mirrors the existing `MegazordInterveneClient` fetch pattern in
`packages/megazord/src/intervene.ts`):**

```
1. resolve origin  ← read ~/.t3/userdata/server-runtime.json .origin   (verify pid alive)
2. mint token      ← `t3 auth session issue --base-dir ~/.t3 --json`   (scopes incl. orchestration:operate)
                     (or call SessionStore.issue in-process against the same baseDir)
3. list accounts   ← settings.json providerInstances  +  UsageLimitsReport (quota)
4. choose (account, harness) ← §4 routing (NDA set → capability → quota)
5. POST /api/orchestration/dispatch  thread.create      { projectId, title, modelSelection, … }
6. POST /api/orchestration/dispatch  thread.turn.start  { threadId, message.text, runtimeMode:"approval-required", … }
```

This is a natural fit for `@t3tools/megazord`: add a `MegazordThreadCreateClient` alongside
the existing intake/observe/intervene clients — a dependency-free `fetch` client with an
injectable `fetchImpl` for tests, pointed at the T3 `origin` instead of the Paperclip
`:3100` server. `projectId` comes from `GET /api/orchestration/snapshot`; a project can be
created first with a `project.create` dispatch if needed. Follow-on control (pause/resume/
inject) already has a home in `intervene.ts` and can move to the same T3 dispatch commands
(`thread.turn.interrupt`, `thread.session.stop`, another `thread.turn.start` to inject).

### Constraints / caveats surfaced by the spike

- **Token needs a real issuance** (signature **and** DB row); a forged token fails
  `SessionStore.verify`. Issue via the CLI/`SessionStore.issue` against the same `baseDir`.
- **Same `baseDir`** as the desktop (`~/.t3`) or the token is signed by a different key and the
  server rejects it.
- **A started turn consumes the chosen account's real quota** — this is exactly why §4 quota
  routing matters; `approval-required` keeps tool side-effects gated on the user.
- **Loopback only** — reachable from processes on the same machine. A remote orchestrator
  would need the existing T3 Connect / relay path, out of scope for this spike.

---

## 6. What the user needs to do

**Nothing to enable the mechanism** — it already works against the running desktop with a
locally-issued token. The remaining decisions are ours to build, not his to configure:

- Confirm the routing policy in §4 (NDA account sets, quota thresholds) before wiring the
  orchestrator to dispatch on his live accounts.
- Decide whether the orchestrator issues tokens via the `t3` CLI or in-process.

He can archive/delete the `[wa-orch demo]` thread whenever; it is parked at the approval gate.
