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
- **Verified (unit tests):** `runtimeEvents.test.ts` + `worktree.test.ts` →
  **17 passing** (`vitest run`), covering the state→event projection and the
  worktree branch/path derivation + PR-url parsing.
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

## Worktree-per-thread guardrail (control-plane over Paperclip)

`WorktreeManager` (`src/worktree.ts`) gives each thread its own git worktree +
branch (`megazord/thread-<slug>`) forked from `baseBranch`, in a sibling dir so
the base checkout stays clean. It is **PR-only by construction**: `commitAll`
and `pushBranch` refuse to run on the base branch (`WorktreeGuardrailError`),
`pushBranch` pins the refspec to the thread branch, and `openPullRequest` always
targets `baseBranch` via `gh pr create` and **never merges** — matching the hard
"branch → PR → the human clicks merge" rule. The driver provisions the worktree
on `startSession`; `openPullRequest` is the 1-button-PR affordance.
