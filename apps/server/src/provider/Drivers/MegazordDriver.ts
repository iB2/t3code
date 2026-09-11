/**
 * MegazordDriver — T3 Code as a control-plane over the capiva-factory
 * ("Megazord") org running on Paperclip.
 * ============================================================================
 * This is the LIVE, in-tree `ProviderDriver` (Build 3). It supersedes the
 * `packages/megazord/blueprint/MegazordDriver.ts` spike, whose adapter seams
 * (`startSession`/`sendTurn`/`streamEvents`/thread management) were left as
 * `notImplemented`. Here they are wired for a real round-trip:
 *
 *   1. a T3 thread starts  → an isolated git **worktree + branch** is provisioned
 *      for it (PR-only; never touches the base branch), via `WorktreeManager`;
 *   2. the thread's turn    → its prompt is submitted to the factory intake
 *      (`MegazordIntakeClient.submit`), creating a `[INTAKE]` Paperclip issue;
 *   3. the org executes     → a background poll loop reads the issue/actionable
 *      status and **projects each `MegazordTaskState` transition back into the
 *      thread** as canonical `ProviderRuntimeEvent`s (`turn.started`,
 *      `item.completed`, `turn.completed`) on the adapter's event queue.
 *
 * ## Division of labour (why the heavy lifting lives in `@t3tools/megazord`)
 *
 * All Node I/O (spawning `git`/`gh`, the intake CLI, HTTP status reads) and the
 * pure state→event decision live in the framework-agnostic `@t3tools/megazord`
 * package, which is verified by its own standalone `tsc` (the repo's Effect
 * language-service plugin forbids raw node builtins in-tree). THIS file stays
 * Effect-clean: it mints ids from a counter, timestamps from `DateTime`, and
 * drives the leaf classes through `Effect.tryPromise`. That keeps the driver
 * inside the plugin's rules while reusing the tested transport/guardrail code.
 *
 * ## What is runtime-untested
 *
 * This compiles against the real SPI, but a live submit→issue→status→thread
 * round-trip must be exercised by a human (Bruno) with the app running — the
 * harness rules forbid launching the Electron GUI here. See ../INTEGRATION.md.
 */
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TextGenerationError,
  TrimmedNonEmptyString,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  MegazordIntakeClient,
  WorktreeManager,
  megazordPollShouldStop,
  megazordSubmitEvents,
  megazordThreadEventsForTransition,
  type MegazordIntakeRequest,
  type MegazordProgressContext,
  type MegazordTaskState,
  type MegazordThreadEvent,
} from "@t3tools/megazord";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
  type ProviderDriverError,
} from "../Errors.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";

/** Stable driver-kind slug. `ProviderDriverKind` is an OPEN branded slug, so a
 *  fork adding "megazord" needs no change to the contracts union. */
const DRIVER_KIND = ProviderDriverKind.make("megazord");

/**
 * Per-instance config. `factoryDir` points at the capiva-factory checkout;
 * `paperclipBaseUrl` is the running org server (loopback, local_trusted — no
 * auth). `repoDir`/`baseBranch` enable the worktree-per-thread control plane;
 * leave `repoDir` empty to disable worktree provisioning.
 */
export const MegazordSettings = Schema.Struct({
  factoryDir: Schema.String,
  paperclipBaseUrl: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:3100")),
  ),
  repoDir: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  baseBranch: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("main"))),
  pollIntervalMs: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(5_000))),
});
export type MegazordSettings = typeof MegazordSettings.Type;

const decodeMegazordSettings = Schema.decodeSync(MegazordSettings);

/** The driver requires no infrastructure services from the runtime R channel. */
export type MegazordDriverEnv = never;

/** A T3 thread's task text becomes a factory `pedido`. */
function requestFromTurn(input: {
  readonly prompt: string;
  readonly threadId: ThreadId;
}): MegazordIntakeRequest {
  return {
    pedido: input.prompt,
    proposta_de_solucao: "Execute via T3 Code Megazord harness (capiva-factory org).",
    dominio: "ops",
    flags: { internal_isolated: true },
    by: "t3code",
    run_id: String(input.threadId),
  };
}

/** Per-thread bookkeeping: the session + its factory coordinates + poll fiber. */
interface SessionRecord {
  session: ProviderSession;
  actionableId?: string;
  issueId?: string;
  issueIdent?: string;
  url?: string;
  turnId?: TurnId;
  pollFiber?: Fiber.Fiber<void, never>;
}

export const MegazordDriver: ProviderDriver<MegazordSettings, MegazordDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Megazord",
    supportsMultipleInstances: true,
  },
  configSchema: MegazordSettings,
  defaultConfig: (): MegazordSettings => decodeMegazordSettings({ factoryDir: "" }),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const client = new MegazordIntakeClient({
        factoryDir: config.factoryDir,
        paperclipBaseUrl: config.paperclipBaseUrl,
      });
      const worktrees =
        config.repoDir === ""
          ? undefined
          : new WorktreeManager({ repoDir: config.repoDir, baseBranch: config.baseBranch });

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      // The adapter's canonical event stream (scoped to this instance).
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Effect.addFinalizer(() => Queue.shutdown(runtimeEvents));

      const emit = (event: ProviderRuntimeEvent) =>
        Effect.asVoid(Queue.offer(runtimeEvents, event));

      // Monotonic id source — avoids the plugin's crypto/global-date bans.
      const seq = yield* Ref.make(0);
      const nextId = (prefix: string) =>
        Ref.getAndUpdate(seq, (n) => n + 1).pipe(
          Effect.map((n) => `${prefix}-${String(instanceId)}-${n}`),
        );
      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

      const buildEventBase = (input: {
        readonly threadId: ThreadId;
        readonly turnId?: TurnId;
        readonly itemId?: string;
      }) =>
        Effect.gen(function* () {
          const eventId = EventId.make(yield* nextId("mz-evt"));
          const createdAt = yield* nowIso;
          return {
            eventId,
            provider: DRIVER_KIND,
            threadId: input.threadId,
            createdAt,
            ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
            ...(input.itemId === undefined ? {} : { itemId: RuntimeItemId.make(input.itemId) }),
          };
        });

      // Identity that forces the returned object literal to be contextually
      // typed by the ProviderRuntimeEvent union, so TS narrows on `type` to the
      // matching member (instead of widening every branch into one wide shape
      // with `?: never` keys, which breaks exactOptionalPropertyTypes).
      const asEvent = (event: ProviderRuntimeEvent): ProviderRuntimeEvent => event;

      // Map a framework-agnostic thread event onto a canonical runtime event.
      const toEvent = (
        descriptor: MegazordThreadEvent,
        threadId: ThreadId,
        turnId: TurnId,
      ): Effect.Effect<ProviderRuntimeEvent> =>
        Effect.gen(function* () {
          switch (descriptor.kind) {
            case "session-started": {
              const base = yield* buildEventBase({ threadId });
              return asEvent({
                ...base,
                type: "session.started",
                payload: { message: TrimmedNonEmptyString.make(descriptor.text) },
              });
            }
            case "turn-started": {
              const base = yield* buildEventBase({ threadId, turnId });
              return asEvent({ ...base, type: "turn.started", payload: {} });
            }
            case "status-note": {
              const base = yield* buildEventBase({
                threadId,
                turnId,
                itemId: yield* nextId("mz-item"),
              });
              return asEvent({
                ...base,
                type: "item.completed",
                payload: {
                  itemType: "unknown",
                  status: "completed",
                  detail: TrimmedNonEmptyString.make(descriptor.text),
                },
              });
            }
            case "blocked": {
              const base = yield* buildEventBase({
                threadId,
                turnId,
                itemId: yield* nextId("mz-item"),
              });
              return asEvent({
                ...base,
                type: "item.completed",
                payload: {
                  itemType: "unknown",
                  status: "completed",
                  title: TrimmedNonEmptyString.make("Blocked — needs founder"),
                  detail: TrimmedNonEmptyString.make(descriptor.text),
                },
              });
            }
            case "turn-completed": {
              const base = yield* buildEventBase({ threadId, turnId });
              return asEvent({
                ...base,
                type: "turn.completed",
                payload: { state: descriptor.state },
              });
            }
            case "error": {
              const base = yield* buildEventBase({ threadId, turnId });
              return asEvent({
                ...base,
                type: "runtime.error",
                payload: { message: TrimmedNonEmptyString.make(descriptor.message) },
              });
            }
          }
        });

      const sessions = new Map<string, SessionRecord>();

      // Read current factory state for a submitted thread (read-only).
      const fetchState = (
        rec: SessionRecord,
      ): Effect.Effect<
        { state: MegazordTaskState; ctx: MegazordProgressContext },
        ProviderAdapterRequestError
      > =>
        Effect.tryPromise({
          try: async () => {
            const ctx: MegazordProgressContext = {
              ...(rec.issueIdent !== undefined ? { issueIdent: rec.issueIdent } : {}),
              ...(rec.url !== undefined ? { issueUrl: rec.url } : {}),
            };
            if (rec.issueId !== undefined) {
              const s = await client.getIssueStatus(rec.issueId);
              return { state: s.state, ctx: { ...ctx, rawStatus: s.rawStatus } };
            }
            if (rec.actionableId !== undefined) {
              const s = await client.readActionable(rec.actionableId);
              return {
                state: s?.state ?? "unknown",
                ctx: { ...ctx, rawStatus: s?.rawStatus ?? "" },
              };
            }
            return { state: "unknown" as MegazordTaskState, ctx };
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: DRIVER_KIND,
              method: "megazord.pollState",
              detail: "failed to read factory status",
              cause,
            }),
        });

      // The RETURN leg of the round-trip: poll factory status and stream the
      // resulting thread events until a terminal state.
      const pollLoop = (threadId: ThreadId, turnId: TurnId): Effect.Effect<void> =>
        Effect.gen(function* () {
          let prev: MegazordTaskState | undefined = undefined;
          for (;;) {
            const rec = sessions.get(String(threadId));
            if (rec === undefined) break;
            const { state, ctx } = yield* fetchState(rec);
            for (const descriptor of megazordThreadEventsForTransition(prev, state, ctx)) {
              yield* emit(yield* toEvent(descriptor, threadId, turnId));
            }
            prev = state;
            if (megazordPollShouldStop(state)) break;
            yield* Effect.sleep(Duration.millis(config.pollIntervalMs));
          }
        }).pipe(
          Effect.catch((error: ProviderAdapterRequestError) =>
            Effect.gen(function* () {
              const base = yield* buildEventBase({ threadId, turnId });
              yield* emit({
                ...base,
                type: "runtime.error",
                payload: { message: TrimmedNonEmptyString.make(error.message) },
              });
            }),
          ),
        );

      const startSession = (
        input: ProviderSessionStartInput,
      ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
        Effect.gen(function* () {
          const threadId = input.threadId;
          // Provision the isolated worktree+branch for this thread (PR-only).
          const cwd =
            worktrees === undefined
              ? input.cwd
              : yield* Effect.tryPromise({
                  try: () => worktrees.ensureThreadWorktree(String(threadId)).then((wt) => wt.path),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: DRIVER_KIND,
                      method: "megazord.ensureWorktree",
                      detail: "failed to provision thread worktree",
                      cause,
                    }),
                });
          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: DRIVER_KIND,
            providerInstanceId: instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId,
            createdAt,
            updatedAt: createdAt,
            ...(cwd !== undefined && cwd !== "" ? { cwd: TrimmedNonEmptyString.make(cwd) } : {}),
          };
          sessions.set(String(threadId), { session });
          for (const descriptor of megazordSubmitEvents()) {
            if (descriptor.kind === "session-started") {
              yield* emit(yield* toEvent(descriptor, threadId, TurnId.make("megazord-pending")));
            }
          }
          return session;
        });

      const sendTurn = (
        input: ProviderSendTurnInput,
      ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
        Effect.gen(function* () {
          const threadId = input.threadId;
          const rec = sessions.get(String(threadId));
          if (rec === undefined) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: DRIVER_KIND,
              threadId,
            });
          }
          const prompt = input.input;
          if (prompt === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER_KIND,
              operation: "sendTurn",
              issue: "megazord requires a task prompt to route to the factory",
            });
          }

          const submitResult = yield* Effect.tryPromise({
            try: () => client.submit(requestFromTurn({ prompt, threadId })),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: DRIVER_KIND,
                method: "megazord.submit",
                detail: "intake submit failed",
                cause,
              }),
          });
          rec.actionableId = submitResult.actionableId;
          if (submitResult.paperclip.issueId !== undefined)
            rec.issueId = submitResult.paperclip.issueId;
          if (submitResult.paperclip.issueIdent !== undefined)
            rec.issueIdent = submitResult.paperclip.issueIdent;
          if (submitResult.paperclip.url !== undefined) rec.url = submitResult.paperclip.url;

          const turnId = TurnId.make(yield* nextId("mz-turn"));
          rec.turnId = turnId;

          const ctx: MegazordProgressContext = {
            ...(rec.issueIdent !== undefined ? { issueIdent: rec.issueIdent } : {}),
            ...(rec.url !== undefined ? { issueUrl: rec.url } : {}),
          };
          for (const descriptor of megazordSubmitEvents(ctx)) {
            if (descriptor.kind === "turn-started") {
              yield* emit(yield* toEvent(descriptor, threadId, turnId));
            }
          }

          // Fork the status→event pump as a daemon so no Scope leaks into the
          // adapter's R channel; it is interrupted on stop and dies when the
          // instance's event queue is shut down.
          const fiber = yield* Effect.forkDetach(pollLoop(threadId, turnId));
          rec.pollFiber = fiber;

          return { threadId, turnId };
        });

      const interruptTurn = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
        Effect.gen(function* () {
          const rec = sessions.get(String(threadId));
          if (rec?.pollFiber !== undefined) yield* Fiber.interrupt(rec.pollFiber);
        });

      const stopSession = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
        Effect.gen(function* () {
          const rec = sessions.get(String(threadId));
          if (rec?.pollFiber !== undefined) yield* Fiber.interrupt(rec.pollFiber);
          sessions.delete(String(threadId));
        });

      const stopAll = (): Effect.Effect<void, ProviderAdapterError> =>
        Effect.gen(function* () {
          for (const rec of sessions.values()) {
            if (rec.pollFiber !== undefined) yield* Fiber.interrupt(rec.pollFiber);
          }
          sessions.clear();
        });

      const unsupported = (operation: string) =>
        new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation,
          issue: `megazord: ${operation} is not supported (org-side execution on Paperclip)`,
        });

      const adapter: ProviderAdapterShape<ProviderAdapterError> = {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: false },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest: () => Effect.fail(unsupported("respondToRequest")),
        respondToUserInput: () => Effect.fail(unsupported("respondToUserInput")),
        stopSession,
        listSessions: () => Effect.sync(() => Array.from(sessions.values(), (r) => r.session)),
        hasSession: (threadId: ThreadId) => Effect.sync(() => sessions.has(String(threadId))),
        readThread: (
          threadId: ThreadId,
        ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
          Effect.succeed({ threadId, turns: [] }),
        rollbackThread: (): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
          Effect.fail(unsupported("rollbackThread")),
        stopAll,
        streamEvents: Stream.fromQueue(runtimeEvents),
      };

      // Minimal, static "available" snapshot. Megazord has no local install to
      // probe — it is available whenever the instance is configured.
      const checkedAt = yield* nowIso;
      const presentedName =
        displayName !== undefined && displayName.trim() !== "" ? displayName : "Megazord";
      const snapshotValue: ServerProvider = {
        ...buildServerProvider({
          driver: DRIVER_KIND,
          presentation: { displayName: TrimmedNonEmptyString.make(presentedName) },
          enabled,
          checkedAt,
          models: [],
          skills: [],
          probe: {
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
          },
        }),
        instanceId,
        driver: DRIVER_KIND,
        availability: "available",
      };

      const snapshot: ServerProviderShape = {
        resolveMaintenance: () =>
          Effect.succeed({ provider: DRIVER_KIND, packageName: null, update: null }),
        getSnapshot: Effect.succeed(snapshotValue),
        refresh: Effect.succeed(snapshotValue),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      };

      // Megazord executes org-side; it has no local text-generation capability.
      const failText = (
        operation:
          | "generateCommitMessage"
          | "generatePrContent"
          | "generateBranchName"
          | "generateThreadTitle",
      ) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "megazord harness does not generate text locally (org-side execution)",
          }),
        );
      const textGeneration: TextGeneration.TextGeneration["Service"] = {
        generateCommitMessage: () => failText("generateCommitMessage"),
        generatePrContent: () => failText("generatePrContent"),
        generateBranchName: () => failText("generateBranchName"),
        generateThreadTitle: () => failText("generateThreadTitle"),
      };

      const instance: ProviderInstance = {
        instanceId: instanceId as ProviderInstanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        ...(accentColor !== undefined ? { accentColor } : {}),
        enabled,
        snapshot,
        adapter,
        textGeneration,
      };
      return instance;
    }),
};
