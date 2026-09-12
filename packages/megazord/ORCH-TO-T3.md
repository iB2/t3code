# ORCH → T3 — dispatch orchestrator work as a routed T3 thread

The wa-orchestrator no longer spawns a shadow subagent in a separate Claude
session T3 can't see. It becomes a **T3 client**: it talks to the running
desktop's loopback HTTP API and creates a **first-class thread** the user can
watch, steer, and approve — routed to the right **(account, harness)** under a
hard NDA/quota policy.

Viability was proven end-to-end against the live desktop (see
`../../SPIKE-ORCH-TO-T3.md`). This package ships the client that operationalises
it: `src/dispatch.ts` (routing policy + fetch client) and `bin/t3-dispatch.mjs`
(the CLI the wa-orchestrator calls).

---

## How the wa-orchestrator dispatches

One command per request. The CLI resolves the live server origin, mints a
scoped token, reads the account inventory + best-effort quota, applies the
routing policy, and dispatches.

```bash
# General work → the pool of three (never SSB). Full run (thread + first turn):
node packages/megazord/bin/t3-dispatch.mjs \
  --task "refactor the podkst intake worker" \
  --scope general \
  --project-title "podkst"

# SSB work → the SSB-exclusive account only:
node packages/megazord/bin/t3-dispatch.mjs \
  --task "update the CoE usecase board sync" \
  --scope ssb \
  --project-title "<your SSB project>"

# Require a specific harness / an exclusive connector:
node packages/megazord/bin/t3-dispatch.mjs --task "…" --scope general --driver codex
node packages/megazord/bin/t3-dispatch.mjs --task "…" --scope general --needs teams
```

Output (human): the chosen instance, the reason, the thread id, and a link.
`--json` emits the full `DispatchOutcome`.

### `--mode` — how far to go (and what it costs)

| mode             | what happens                                           | harness spawned? | quota spent? |
| ---------------- | ------------------------------------------------------ | ---------------- | ------------ |
| `select`         | run the routing policy only — **no network dispatch**  | no               | no           |
| `create`         | `thread.create` — the thread appears in T3             | no               | no           |
| `full` (default) | `thread.create` + `thread.turn.start` — the agent runs | yes              | **yes**      |

`select` is the safe way to prove a route (including SSB) without touching the
account. `create` makes the thread visible without starting the agent. `full`
starts the agent under `--runtime` (default `approval-required`: the agent
pauses at the first tool use and waits for the user's approval in T3 — nothing
executes unattended).

### In-process (instead of the CLI)

```ts
import { MegazordT3DispatchClient } from "@t3tools/megazord";

const client = new MegazordT3DispatchClient(); // reads ~/.t3 live
const out = await client.dispatch({
  task: "…",
  scope: "general",
  projectTitle: "podkst",
});
// → { threadId, instanceId, driver, model, url, mode, decision }
```

---

## The routing policy (hard rule — Bruno, 2026-09-12)

Implemented as the pure, fail-closed `selectInstance()` (fully unit-tested, no
I/O). Three gates, in order:

1. **NDA/client boundary (decided first).**
   - `scope: "ssb"` → **only** the SSB account (the enabled `claudeAgent`
     instance marked "SSB"). If it is missing/disabled → **ERROR** (never a
     fallback). If more than one instance matches → **ERROR** (ambiguous —
     refuse rather than guess which login is the client's).
   - `scope: "general"` → the pool of **every enabled account EXCEPT the SSB
     one**. SSB work never leaks out; general work never lands on SSB.
     The boundary is real because it selects **which OAuth home the CLI logs
     into** — sending the wrong `instanceId` would run on the wrong account.

2. **Capability.** Within the allowed set:
   - `--driver <codex|claudeAgent>` filters to that harness; none eligible →
     **ERROR**.
   - `--needs <connector>` filters to instances whose capability inventory
     lists that connector; none eligible → **ERROR** (with no inventory, a
     `needs` request refuses rather than guessing).

3. **Quota (spread).** Among the survivors, pick the **least-loaded** by
   `usedPercent` (worst window per instance). Saturated instances (≥ 95% used)
   sort last; instances with unknown quota sort after known ones. Ties break by
   **config order**, so the choice is deterministic. Quota is an optimization,
   never a gate: a failing/absent quota source degrades to deterministic order
   and never blocks a dispatch.

### The account → scope → capability table

Read **live** from `~/.t3/userdata/settings.json` `providerInstances` on every
call — never hardcoded, so add/rename/disable of an account is picked up next
run. The current inventory on this machine:

| `instanceId`                | harness (`driver`) | displayName    | scope it serves            |
| --------------------------- | ------------------ | -------------- | -------------------------- |
| `claudeAgent`               | `claudeAgent`      | **Claude SSB** | **`ssb` only** (exclusive) |
| `codex`                     | `codex`            | —              | `general` pool             |
| `codex_codex_capiva`        | `codex`            | Codex Capiva   | `general` pool             |
| `claudeAgent_claude_capiva` | `claudeAgent`      | Claude Capiva  | `general` pool             |

The SSB account is identified by `defaultSsbMatcher` — an enabled `claudeAgent`
whose displayName contains the word "SSB" (case-insensitive). Override via the
`ssbMatcher` option if the marking convention changes.

**Capability inventory (`--needs`)** is an **injectable seam**, not fragile
home-scraping: the four instances store MCP config in inconsistent layouts
(some have no `homePath`, one uses `config.toml`, one's home does not yet
exist), so a robust default reader is not possible. Provide the map via the
`capabilities` client option, e.g.
`{ codex_codex_capiva: ["teams"], claudeAgent: ["m365", "teams"] }`. Until a
map is supplied, `--needs` fail-closes.

---

## Mechanism (how the client reaches the live server)

- **Origin.** Read `~/.t3/userdata/server-runtime.json` → `.origin`
  (loopback `http://127.0.0.1:<port>`). No config, no discovery protocol.
- **Token.** Minted at runtime by spawning the server CLI
  `node apps/server/src/bin.ts auth session issue --base-dir ~/.t3 --json`
  (scopes include `orchestration:operate`). The token is **never written to
  disk** and never committed. Override with the `token` option (reuse) or
  `mintTokenCommand` (alternate runtime).
- **Accounts.** Read live from `settings.json` `providerInstances`.
- **Quota.** No HTTP endpoint exists — live usage is pushed over the RPC
  channel only. So quota is an **injectable `usageSource`** (returns
  `{ instanceId, usedPercent, resetsAt? }[]`, the distilled `UsageLimitsReport`
  shape). With no source, routing degrades to deterministic config order (see
  gate 3). Wiring a real reader (RPC subscription, or per-account provider
  usage probe) is a drop-in behind that seam.
- **Dispatch.** `POST /api/orchestration/dispatch` with a `thread.create`
  command, then a `thread.turn.start` command (client variant), both carrying
  `modelSelection: { instanceId, model }` for the chosen account.

Loopback only — a remote orchestrator would use the T3 Connect / relay path
(out of scope here, same as the spike).

---

## What is proven vs. what is wired

- **Live-verified** (against the running desktop, `origin http://127.0.0.1:3773`):
  origin resolution, headless token mint, live account read from settings.json,
  the SSB gate (`scope: ssb` → `claudeAgent`), the general pool
  (`scope: general` → one of the three, never SSB), driver-pin
  (`general --driver claudeAgent` → `claudeAgent_claude_capiva`), and a real
  `thread.create` that appears on the server with `session: null` (no harness,
  no quota).
- **Build-verified** (unit tests, injected fetch — no live server): the full
  `thread.create` + `thread.turn.start` sequence, projectId-by-title
  resolution, quota-based least-loaded selection, and all fail-closed refusals.
- **Wired as a seam (not yet fed live):** the `usageSource` (quota) and the
  `capabilities` map (`--needs`). Both degrade safely until supplied.
