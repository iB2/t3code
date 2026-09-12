# `@t3tools/megazord` — T3 Code ↔ capiva-factory (Megazord) integration

This package is the thin bridge that lets a **T3 Code thread submit its task to
the capiva-factory "Megazord" agent factory** instead of driving a bare local
Claude/Codex session, and surface the factory's status back into the thread.

It ships in two parts:

1. **`src/` — the verified bridge** (`MegazordIntakeClient` + status
   projection). Framework-agnostic plain Node, **typecheck-verified** under the
   repo's strict `tsconfig.base.json` settings.
2. **`blueprint/MegazordDriver.ts` — the drop-in T3 harness driver.** A
   ready-to-move `ProviderDriver` for `apps/server`. It lives outside `src/` on
   purpose (see "Why a blueprint" below) and is **not yet compiled in-tree**.

---

## The two contracts this seam bridges

### A. T3 Code harness contract (what a new harness must implement)

T3 registers harnesses as **`ProviderDriver`** values, not Layers
(`apps/server/src/provider/ProviderDriver.ts`). Key facts found during recon:

- **`ProviderDriverKind` is an OPEN branded slug**, not a closed union
  (`packages/contracts/src/providerInstance.ts:18-70`). The design explicitly
  supports forks adding drivers: _"The server hosts forks, ships in PRs that add
  drivers … external fork authors retain reasonable freedom."_ So
  `ProviderDriverKind.make("megazord")` is a first-class extension — **no change
  to the contracts package is required**, and unknown drivers degrade to an
  "unavailable" snapshot rather than crashing.
- A `ProviderDriver<Config, R>` is a plain record with:
  `driverKind`, `metadata`, `configSchema` (an Effect `Schema.Codec`),
  `defaultConfig()`, and `create(input) => Effect<ProviderInstance, …, R | Scope>`.
- `create` returns a **`ProviderInstance`** (three captured closures):
  `snapshot: ServerProviderShape`, `adapter: ProviderAdapterShape`,
  `textGeneration`, plus ids/metadata.
- The **`ProviderAdapterShape`** (`apps/server/src/provider/Services/ProviderAdapter.ts`)
  is the thread/session/streaming surface: `startSession`, `sendTurn`,
  `interruptTurn`, `respondToRequest`, `respondToUserInput`, `stopSession`,
  `listSessions`, `hasSession`, `readThread`, `rollbackThread`, optional
  `compaction`/`uploadFeedback`, `stopAll`, and a canonical
  **`streamEvents: Stream<ProviderRuntimeEvent>`**.
- **Registration** is one array: `apps/server/src/provider/builtInDrivers.ts`
  (`BUILT_IN_DRIVERS`). Adding a driver = implement it, add it to that array,
  ensure the runtime layer satisfies its declared `R`.

Existing harnesses (Claude, Codex, Cursor, Grok, OpenCode, Antigravity) are
mostly **ACP-based** subprocess agents (`apps/server/src/provider/acp/`,
`Drivers/*Driver.ts`, `Layers/*Adapter.ts`). Megazord is a different shape — an
HTTP/CLI bridge to an org server, not a local CLI agent — which is exactly why
its adapter's `streamEvents`/`readThread` are the seams that need real work.

### B. capiva-factory intake contract (how to submit + read status)

Recon of `C:\Users\bruno\Documents\DevProjects\capiva-factory`:

- **Intake is a Node CLI / importable function, not its own HTTP server:**
  `intake/ingest-request.mjs`. Submit via
  `node intake/ingest-request.mjs --request '<json>' --json` (also `--pedido …`
  flags or stdin JSON), or import `ingestRequest(request, opts)`.
- **Submit side-effects:** it POSTs a **visible Paperclip issue** titled
  `[INTAKE] <pedido>` to the running org server at a hardcoded
  `http://127.0.0.1:3100` (company id hardcoded), and appends an actionable to
  the local `actionables/store.ndjson`.
- **Request schema:** `pedido` (**required**), `proposta_de_solucao`
  (recommended — factory auto-derives if omitted to satisfy NO-NAKED-BACKLOG),
  optional `dominio` (`conteudo|seo-aeo|conhecimento|ops|cross-cutting`),
  `evidencia`, `flags` (`internal_isolated`, `external_publish`, …, drive the
  review tier), `channel`, `target_repo`, `by`, `run_id`.
- **Submit result:** `{ actionable, deduped, paperclip:{ issueId, issueIdent,
assignee, assigneeId, url } }`. Idempotent by `dedup_key` (`deduped:true`).
- **Status/read (no dedicated intake endpoint):**
  - Local store `actionables/store.ndjson`, status enum `pending_founder |
dispatched | gate_blocked_escalated | resolved | dropped`.
  - Paperclip live: `GET http://127.0.0.1:3100/api/issues/:issueId` → `.status`
    (and heartbeat-run endpoints for worker execution state).
- **Auth:** none against the local instance — Paperclip runs in
  `deploymentMode = "local_trusted"` (loopback, private). Non-local modes have
  JWT infra but it's inactive here.

`MegazordIntakeClient` implements exactly this: `submit()` shells out to the
intake CLI (reusing the factory's tier/NDA/dedup logic rather than
re-implementing it), `getIssueStatus()` does the read-only Paperclip GET, and
`readActionable()` reads the local store. `taskState.ts` projects both status
vocabularies onto one stable `MegazordTaskState`
(`queued|dispatched|blocked|done|dropped|unknown`).

---

## What is build-verified vs runtime-untested

- **Verified (leaf typecheck, isolated):** `packages/megazord/src/**` compiles
  clean under the repo's exact strict flags (`strict`,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `NodeNext`) via an **isolated
  `tsc`** (no `@effect/language-service` plugin — the plugin bans raw node
  builtins, which the framework-agnostic transport/worktree code uses by
  design, exactly like `MegazordIntakeClient.ts`).
- **Verified (unit tests):** `runtimeEvents.test.ts`, `worktree.test.ts`,
  `taskState.test.ts`, plus Build 4 `intervene.test.ts`, `observe.test.ts`,
  `router.test.ts` → **52 passing** (`vp test run`), covering the state→event
  projection, worktree derivation + PR-url parsing, the fail-closed intervene
  planner/client (mocked fetch), the richer observation extraction, and the
  cockpit machine router.
- **Verified (in-tree, Build 3):** the LIVE driver
  `apps/server/src/provider/Drivers/MegazordDriver.ts` compiles under the FULL
  server package typecheck **with** the Effect language-service plugin active:
  `pnpm --filter t3 typecheck` → **0 errors, 0 warnings**. It is registered in
  `builtInDrivers.ts` (also green).
- **NOT verified — runtime round-trip:** nothing was executed against the live
  factory. Per the harness constraints the T3 GUI/app was never launched and the
  running Megazord on `:3100` was never touched. A real submit→issue→status
  round-trip must be run by a human (Bruno).

## Framework-agnostic bridge + Effect driver (the two-layer split)

Any file under `apps/server/src` is typechecked WITH the
`@effect/language-service` plugin, which forbids raw node builtins
(`nodeBuiltinImport`), `Date`/`setTimeout`/`fetch`/`crypto.randomUUID`, etc. So
the split is deliberate:

- **`packages/megazord/src/**` (framework-agnostic):** all Node I/O — spawning
  the intake CLI, `git`/`gh` for worktrees, HTTP status reads — plus the PURE
  state→event decision (`runtimeEvents.ts`). Verified by isolated `tsc` + unit
  tests. Reused verbatim by the driver.
- **`apps/server/src/provider/Drivers/MegazordDriver.ts` (Effect, in-tree):**
  stays plugin-clean — mints ids from a counter, timestamps via `DateTime`, and
  drives the leaf classes through `Effect.tryPromise`. Owns the adapter, the
  Queue-backed `streamEvents`, the poll→event pump, and the snapshot/text-gen
  stubs.

The old `blueprint/MegazordDriver.ts` (which left the adapter seams as
`notImplemented`) is **superseded and removed** by this live driver.

---

## Activating the driver — DONE in Build 3

Steps 1-4 below are implemented and typecheck-green; only 5-6 remain (human).

1. ~~Move the blueprint in~~ → **done**: live at
   `apps/server/src/provider/Drivers/MegazordDriver.ts`; `@t3tools/megazord`
   added to `apps/server/package.json` (`workspace:*`).
2. ~~Register it~~ → **done** in `builtInDrivers.ts` (`MegazordDriver` +
   `MegazordDriverEnv` = `never`).
3. ~~Fill the seams~~ → **done**:
   - `startSession`: provisions the thread's isolated worktree+branch
     (`WorktreeManager.ensureThreadWorktree`), builds a real `ProviderSession`,
     emits `session.started`.
   - `sendTurn`: `client.submit(...)` → factory `[INTAKE]` issue, emits
     `turn.started`, then forks a **poll loop** that maps each
     `MegazordTaskState` transition into `ProviderRuntimeEvent`s
     (`item.completed`/`turn.completed`) on the Queue-backed `streamEvents`.
   - `readThread`/`rollbackThread`/approvals/user-input: principled
     "unsupported" (org-side execution). `snapshot`: static available snapshot.
     `textGeneration`: fails with `TextGenerationError` (no local text gen).
4. ~~Typecheck the server package~~ → **done**: `pnpm --filter t3 typecheck`
   passes (do **not** run `pnpm dev` / launch the app).
5. **Configure an instance** in `ServerSettings.providerInstances`:
   ```jsonc
   {
     "megazord": {
       "driver": "megazord",
       "config": {
         "factoryDir": "C:\\Users\\bruno\\Documents\\DevProjects\\capiva-factory",
         "repoDir": "C:\\path\\to\\the\\repo\\the\\threads\\work\\on",
         "baseBranch": "main",
         "pollIntervalMs": 5000,
       },
     },
   }
   ```
   Leave `repoDir` empty to disable worktree provisioning (intake round-trip
   still works; the thread's `cwd` falls back to the session input).
6. **Human round-trip test (Bruno):** with capiva-factory already running on
   `:3100`, start T3 yourself, pick the **Megazord** harness for a thread, send a
   task, and confirm a `[INTAKE] …` issue appears in Paperclip and the thread
   reflects the status projection as it advances.

## Build 4 — BIDIRECTIONAL round-trip + T3 cockpit (observe + intervene + route)

Build 3 gave the OBSERVE leg (factory state → thread) and worktree-per-thread.
Build 4 completes the control-plane the DISTRIBUTION-PLAN "Plano de CONTROLE"
asked for: richer observe, a bidirectional intervene channel, and the cockpit
routing model.

### What is build-verified (typecheck + unit tests, no live factory)

- **OBSERVE (richer)** — `observe.ts` + `MegazordIntakeClient.getIssueObservation`
  read a live Paperclip issue into `{ state, rawStatus, phase?, agent?, cost?,
risk? }` (best-effort, never throws on a garbage body). The driver's poll loop
  now uses it, so a dispatched note reads e.g. `Dispatched … — phase: review ·
agent: narrative · cost: $0.42 · risk: tier 2`.
- **INTERVENE (bidirectional)** — `intervene.ts` is the T3→thread control leg:
  - `respondToUserInput` → **inject** a message (redirect the agent mid-flight);
  - `interruptTurn` → **pause** (interrupt the local poll + best-effort upstream);
  - `stopSession` → **kill** (best-effort upstream, then tear down local state);
  - `respondToRequest` → **approve/reject** an escalated gate
    (`accept*`→approve, `decline`/`cancel`→reject).
    Every intervention carries a machine-readable marker
    (`[T3-COCKPIT mz:redirect=1 …]`) in whichever visible field the real endpoint
    exposes (comment body / hold reason / approval decisionNote) — same "make it
    visible, never a shadow subagent" rule as dispatch. **Fail-closed:** the pure
    `planIntervention` refuses (no network) when the issue-family actions have no
    `issueId`, when a gate has no `approvalId`, or on an empty inject; the client
    just executes a validated plan. The whole path is unit-verified with an
    **injected `fetchImpl`**, so the unit tests never touched `:3100`. See the
    **Build 4/5 wire-format** section below for the live-verified endpoints.
- **COCKPIT routing (1 cockpit → N machines)** — `router.ts`
  (`MegazordMachineRouter`) is the "machine + account per request" interface:
  register N targets, `resolve(request)` picks one (explicit id, or the
  default), fail-closed on unknown/none. The driver registers **this** machine
  as a `local` target and dispatches to it (the build-verified ≥1-machine path);
  `requireLocal` fails closed on a `remote` target because the mesh transport
  (Remote Control) is not wired in-process.

### What is runtime-untested (needs Bruno, live, on the Mac test)

- Whether the org agent **honours the `mz:` markers** (redirect / gate / control)
  — that is factory-side behaviour, not verified here.
- **End-to-end gate surfacing.** The approval-decision endpoints are live-verified
  (see Build 4/5), but the OBSERVE leg does not yet surface a Paperclip approval
  into a T3 `ApprovalRequestId`. `respondToRequest` treats the escalation's
  request id AS the Paperclip approval id (the natural contract once observe
  surfaces gates); a mismatched id fails honestly as a non-refusal 404.
- **Multi-machine** dispatch. The router interface + local path are verified; a
  **remote** machine needs the mesh/Remote-Control transport, which Bruno wires
  and validates from the Mac. Until then remote targets fail closed.

### Live validation steps (Bruno, on the Mac test)

1. Configure a `megazord` instance with `factoryDir`, `companyId` (required for
   intervene — the Paperclip company scope), optional `repoDir`/`baseBranch`,
   and `machineId`.
2. With capiva-factory running on `:3100`, start T3 yourself (never launched
   here), pick the **Megazord** harness, send a task → confirm the `[INTAKE] …`
   issue appears and the thread shows the richer observe line.
3. Exercise intervene from the UI: inject a redirect → confirm a `[T3-COCKPIT
mz:redirect=1 …]` comment lands on the issue (and the active run is
   interrupted); pause → confirm a `pause` tree-hold appears; approve/reject a
   surfaced gate. The endpoints are live-verified below; `InterveneEndpoints`
   remains the override seam if a future Paperclip version moves them.
4. For multi-machine: register a second (remote) machine and wire the mesh
   transport; confirm the cockpit routes a request to it.

## Build 4/5 — REAL intervene wire-format (LIVE-verified against `:3100`)

The Build 4 first cut wired every intervention to one assumed surface —
`POST /api/companies/<co>/issues/<id>/comments`. **That company-scoped comment
route does not exist on Paperclip.** Build 4/5 remapped each action onto the
primitives the factory actually exposes and verified them live against the
running org server (v0.3.1, `local_trusted`, company
`47ef245e-ff23-41be-a39d-21e4ac66ed2a`). All paths are under `/api` and are
**not** company-scoped. `local_trusted` gives the caller an implicit **board**
actor, so no auth headers are needed (same as dispatch).

| Action      | Endpoint (before → after)                                               | Body                                             | Live result                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **inject**  | `POST /companies/:co/issues/:id/comments` → `POST /issues/:id/comments` | `{ body: "<mz marker> <msg>", interrupt: true }` | **201** — comment created; `interrupt` cancels the active run when one exists (board-only), no-op otherwise, so the visible marker still lands |
| **pause**   | _(same wrong comment path)_ → `POST /issues/:id/tree-holds`             | `{ mode: "pause", reason: "<mz marker>" }`       | **201** — hold `active`                                                                                                                        |
| **resume**  | → `POST /issues/:id/tree-holds`                                         | `{ mode: "resume", reason }`                     | wire-shape same family as pause (`mode` enum `pause\|resume\|cancel`)                                                                          |
| **kill**    | → `POST /issues/:id/tree-holds`                                         | `{ mode: "cancel", reason }`                     | wire-shape verified via pause; `cancel` is the same route/mode enum                                                                            |
| **approve** | → `POST /approvals/:approvalId/approve`                                 | `{ decisionNote: "<mz marker>" }`                | **200** — status→`approved`                                                                                                                    |
| **reject**  | → `POST /approvals/:approvalId/reject`                                  | `{ decisionNote: "<mz marker>" }`                | **200** — status→`rejected`                                                                                                                    |

Cleanup primitive: a pause/cancel hold is released with
`POST /issues/:id/tree-holds/:holdId/release` `{ reason }` (**200**,
status→`released`) — verified live.

**INJECT is resolved, not fail-closed.** The earlier diagnosis ("no issue
comment exists") was reading the wrong path shape; the **issue-scoped**
`POST /issues/:id/comments` exists and, with `interrupt: true` + the board
actor, is a real mid-flight redirect that also leaves the visible `mz:` marker.

**Types:** `MegazordThreadCoords` now carries both `issueId` (issue-family
targets) and `approvalId` (gate targets). `InterveneEndpoints` exposes
`commentPath(issueId)`, `treeHoldPath(issueId)`,
`approvalDecisionPath(approvalId, "approve"|"reject")`, and `commentBodyKey`.

**Live evidence (demo issue for Bruno to inspect in Paperclip):**
`[T3-COCKPIT DEMO 1789221619]` = issue **CAPA-86**
(`2844c07b-15b7-44ea-a9f0-25856fc92423`). It shows the injected redirect
comment, a pause hold (now released), and two resolved test approvals (one
approved, one rejected). Safe to close.

## Worktree-per-thread guardrail (control-plane over Paperclip)

`WorktreeManager` (`src/worktree.ts`) gives each thread its own git worktree +
branch (`megazord/thread-<slug>`) forked from `baseBranch`, in a sibling dir so
the base checkout stays clean. It is **PR-only by construction**: `commitAll`
and `pushBranch` refuse to run on the base branch (`WorktreeGuardrailError`),
`pushBranch` pins the refspec to the thread branch, and `openPullRequest` always
targets `baseBranch` via `gh pr create` and **never merges** — matching the hard
"branch → PR → the human clicks merge" rule. The driver provisions the worktree
on `startSession`; `openPullRequest` is the 1-button-PR affordance.
