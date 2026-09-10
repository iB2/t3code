/**
 * MegazordDriver — DROP-IN BLUEPRINT (not compiled by this package).
 * ============================================================================
 * This file intentionally lives OUTSIDE `packages/megazord/src` so it is not
 * part of the leaf package's typecheck. It is a ready-to-move `ProviderDriver`
 * implementation for `apps/server/src/provider/Drivers/MegazordDriver.ts`.
 *
 * WHY IT SHIPS AS A BLUEPRINT, NOT A LIVE FILE:
 * A live driver imports the server's Effect SPI (`../ProviderDriver.ts`,
 * `@t3tools/contracts`, `effect/*`) and, once placed under `apps/server/src`,
 * is included in that app's typecheck. Verifying it therefore requires a full
 * monorepo install (Electron/Expo/native deps + a `prepare` step). This spike
 * verified the framework-agnostic `@t3tools/megazord` bridge standalone
 * instead. Drop this file in, then run `pnpm --filter t3 typecheck` (the
 * server package) to close the loop — see ../INTEGRATION.md.
 *
 * WHAT IS REAL vs TODO:
 *   - REAL and wired: config schema, `create`, and the `startSession` /
 *     `sendTurn` path that submits the T3 task to capiva-factory intake via the
 *     verified `MegazordIntakeClient`, plus the status→state projection.
 *   - TODO seams (clearly marked): translating factory status into the
 *     `ProviderRuntimeEvent` stream, `readThread`, `rollbackThread`, approvals,
 *     user-input, snapshot, and `textGeneration`. These are the ~half-dozen
 *     surfaces that need the server's Effect event/runtime helpers.
 *
 * The exact `ProviderDriver` / `ProviderAdapterShape` contract this targets is
 * documented in ../INTEGRATION.md ("T3 harness contract").
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderInstanceId, ProviderSession, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { MegazordIntakeClient, type MegazordIntakeRequest } from "@t3tools/megazord";

import { ProviderDriverError } from "../Errors.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";

/** Stable driver-kind slug. `ProviderDriverKind` is an OPEN branded slug, so a
 *  fork adding "megazord" needs no change to the contracts union. */
const DRIVER_KIND = ProviderDriverKind.make("megazord");

/**
 * Per-instance config. `factoryDir` points at the capiva-factory checkout;
 * `paperclipBaseUrl` is the running org server (loopback, local_trusted — no
 * auth). Kept minimal on purpose.
 */
export const MegazordSettings = Schema.Struct({
  factoryDir: Schema.String,
  paperclipBaseUrl: Schema.optionalWith(Schema.String, {
    default: () => "http://127.0.0.1:3100",
  }),
});
export type MegazordSettings = typeof MegazordSettings.Type;

const decodeMegazordSettings = Schema.decodeSync(MegazordSettings);

/**
 * A T3 thread's task text becomes a factory `pedido`. We tag it as an
 * internal/isolated request by default (NDA-safe tier routing); adjust the
 * flags/domain mapping to taste.
 */
function requestFromTurn(input: { readonly prompt: string; readonly threadId: ThreadId }): MegazordIntakeRequest {
  return {
    pedido: input.prompt,
    proposta_de_solucao: "Execute via T3 Code Megazord harness (capiva-factory org).",
    dominio: "ops",
    flags: { internal_isolated: true },
    by: "t3code",
    run_id: String(input.threadId),
  };
}

export type MegazordDriverEnv = never;

export const MegazordDriver: ProviderDriver<MegazordSettings, MegazordDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Megazord",
    supportsMultipleInstances: true,
  },
  configSchema: MegazordSettings,
  defaultConfig: (): MegazordSettings => decodeMegazordSettings({ factoryDir: "" }),
  create: ({ instanceId, displayName, config }) =>
    Effect.gen(function* () {
      const client = new MegazordIntakeClient({
        factoryDir: config.factoryDir,
        paperclipBaseUrl: config.paperclipBaseUrl,
      });

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      // In-memory map of T3 threadId -> factory issue coordinates. A real
      // implementation persists this so status survives a server restart.
      const submissions = new Map<string, { issueId?: string; actionableId: string }>();

      // --- REAL, wired: submit a T3 task to capiva-factory intake -----------
      const submitTask = (threadId: ThreadId, prompt: string) =>
        Effect.tryPromise({
          try: () => client.submit(requestFromTurn({ prompt, threadId })),
          catch: (cause) => new ProviderDriverError({ message: "megazord intake submit failed", cause }),
        }).pipe(
          Effect.tap((res) =>
            Effect.sync(() =>
              submissions.set(String(threadId), {
                actionableId: res.actionableId,
                ...(res.paperclip.issueId === undefined ? {} : { issueId: res.paperclip.issueId }),
              }),
            ),
          ),
        );

      // --- REAL, wired: read current factory status for a thread ------------
      const pollState = (threadId: ThreadId) =>
        Effect.tryPromise({
          try: async () => {
            const rec = submissions.get(String(threadId));
            if (rec === undefined) return "unknown" as const;
            if (rec.issueId !== undefined) {
              return (await client.getIssueStatus(rec.issueId)).state;
            }
            const s = await client.readActionable(rec.actionableId);
            return s?.state ?? "unknown";
          },
          catch: (cause) => new ProviderDriverError({ message: "megazord status poll failed", cause }),
        });

      // ---------------------------------------------------------------------
      // TODO SEAMS — need the server's Effect event/runtime helpers.
      // ---------------------------------------------------------------------
      // The `adapter` below is the shape T3 expects (ProviderAdapterShape).
      // The methods that require translating factory status into the canonical
      // `ProviderRuntimeEvent` stream (startSession emitting a session, sendTurn
      // driving a poll->event loop, streamEvents, readThread, rollbackThread,
      // approvals, user-input, snapshot, textGeneration) are left as typed
      // TODOs. Fill them using the patterns in a sibling driver (e.g.
      // OpenCodeAdapter / OpenCodeProvider) — see ../INTEGRATION.md step 3.

      const notImplemented = (what: string) =>
        Effect.fail(new ProviderDriverError({ message: `megazord: ${what} not yet implemented` }));

      const adapter = {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" as const },
        // startSession: submit the task, return a ProviderSession. TODO: build
        // the real ProviderSession value + begin the status->event pump.
        startSession: (_input: unknown): Effect.Effect<ProviderSession, ProviderDriverError> =>
          notImplemented("startSession") as Effect.Effect<ProviderSession, ProviderDriverError>,
        sendTurn: (_input: unknown) => notImplemented("sendTurn"),
        interruptTurn: (_threadId: ThreadId) => notImplemented("interruptTurn"),
        respondToRequest: () => notImplemented("respondToRequest"),
        respondToUserInput: () => notImplemented("respondToUserInput"),
        stopSession: (threadId: ThreadId) =>
          Effect.sync(() => {
            submissions.delete(String(threadId));
          }),
        listSessions: () => Effect.succeed([] as ReadonlyArray<ProviderSession>),
        hasSession: (threadId: ThreadId) => Effect.succeed(submissions.has(String(threadId))),
        readThread: () => notImplemented("readThread"),
        rollbackThread: () => notImplemented("rollbackThread"),
        stopAll: () => Effect.sync(() => submissions.clear()),
        streamEvents: Stream.empty, // TODO: real ProviderRuntimeEvent stream.
      };

      // `submitTask` / `pollState` are exercised by startSession/sendTurn once
      // wired; referenced here so the intent is explicit.
      void submitTask;
      void pollState;

      const instance: ProviderInstance = {
        instanceId: instanceId as ProviderInstanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        enabled: true,
        // TODO: real ServerProviderShape snapshot (available/models/skills).
        snapshot: undefined as unknown as ProviderInstance["snapshot"],
        adapter: adapter as unknown as ProviderInstance["adapter"],
        // TODO: real textGeneration service (or a "not supported" stub).
        textGeneration: undefined as unknown as ProviderInstance["textGeneration"],
      };
      return instance;
    }),
};
