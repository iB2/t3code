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
  supports forks adding drivers: *"The server hosts forks, ships in PRs that add
  drivers … external fork authors retain reasonable freedom."* So
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

- **Verified (typecheck):** `packages/megazord/src/**` compiles clean under the
  repo's exact strict flags (`strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
  `NodeNext`). Command used (isolated dir, `typescript@5.9.2` + `@types/node@24.12.4`):
  `tsc -p tsconfig.json` → **pass, 0 errors**.
- **NOT verified — driver blueprint:** `blueprint/MegazordDriver.ts` is written
  against the real SPI but has **not** been compiled in-tree (would require a
  full monorepo install).
- **NOT verified — runtime round-trip:** nothing was executed against the live
  factory. Per the spike constraints the T3 GUI/app was never launched and the
  running Megazord on `:3100` was never touched. A real submit→issue→status
  round-trip must be run by a human.

## Why a blueprint (not a live driver file)

Any file under `apps/server/src` is included in that app's typecheck. An
Effect-TS driver imports `@t3tools/contracts`, `effect/*`, and server-internal
modules, so verifying it needs `node_modules` for the whole workspace
(Electron/Expo/native deps + a `prepare` step). This spike deliberately did not
run that install (heavy on Windows; the app must never be launched). Shipping
the driver as a blueprint keeps the repo's typecheck green while still handing
over the complete, wired implementation.

---

## Activating the driver (remaining steps to a full round-trip)

1. **Move the blueprint in:**
   `packages/megazord/blueprint/MegazordDriver.ts` →
   `apps/server/src/provider/Drivers/MegazordDriver.ts`, and fix the import of
   the bridge (`@t3tools/megazord`) — add `@t3tools/megazord` to
   `apps/server/package.json` dependencies (`"@t3tools/megazord": "workspace:*"`).
2. **Register it** in `apps/server/src/provider/builtInDrivers.ts`:
   ```ts
   import { MegazordDriver, type MegazordDriverEnv } from "./Drivers/MegazordDriver.ts";
   // add MegazordDriverEnv to the BuiltInDriversEnv union
   // add MegazordDriver to the BUILT_IN_DRIVERS array
   ```
3. **Fill the TODO seams** using `OpenCodeAdapter`/`OpenCodeProvider` as the
   reference:
   - `startSession`: call `client.submit(...)`, return a real `ProviderSession`,
     and start a poll loop that maps `MegazordTaskState` transitions into
     `ProviderRuntimeEvent`s on `streamEvents`.
   - `sendTurn`: submit a follow-up `pedido` (or reject if the factory model is
     one-shot per issue).
   - `readThread` / `rollbackThread` / `snapshot` / `textGeneration`: implement
     or return a principled "unsupported".
4. **Typecheck the server package:** `pnpm --filter t3 typecheck`
   (do **not** run `pnpm dev` / launch the app).
5. **Configure an instance** in `ServerSettings.providerInstances`:
   ```jsonc
   { "megazord": { "driver": "megazord",
     "config": { "factoryDir": "C:\\Users\\bruno\\Documents\\DevProjects\\capiva-factory" } } }
   ```
6. **Human round-trip test (Bruno):** with capiva-factory already running on
   `:3100`, start T3 yourself, pick the **Megazord** harness for a thread, send a
   task, and confirm a `[INTAKE] …` issue appears in Paperclip and the thread
   reflects the status projection.
