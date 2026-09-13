#!/usr/bin/env node
/**
 * t3-session-import — adopt a live coding-agent session as a T3-owner thread.
 *
 * The import primitive the wa-orchestrator cutover uses to hand its persistent
 * `claude` session to the running T3 server. It calls the WS RPC
 * `agentSessionsImport` (apps/server/src/ws.ts -> importRecentAgentThreads) for a
 * PROJECT, which is:
 *   * project-scoped and READ-ONLY on the session .jsonl,
 *   * idempotent — already-imported sources are skipped, a re-run re-verifies,
 *   * seeds a provider_session_runtime binding with
 *       resumeCursor = { threadId, resume: <providerSessionId> }   (status "stopped")
 *     so a later turn resumes the SAME session id, appending to the SAME .jsonl
 *     (there is no cross-process lock — single-writer discipline is the caller's job),
 *   * produces the DETERMINISTIC thread id  import:<driver>:<sessionId>.
 *
 * GOTCHA (enforced upstream, noted here): the import SKIPS a session that is still
 * live/active (hasImportBlockingActivity). The bridge must be quiesced (release the
 * session) BEFORE calling this — the same quiesce that guarantees single-writer.
 *
 * Transport: agentSessionsImport is exposed ONLY over the /ws RpcServer (there is no
 * HTTP route), so this uses the Effect RpcClient over a WebSocket, authenticated with
 * a Bearer token minted at runtime (the same token the megazord dispatch CLI mints;
 * NEVER written to disk). The /ws upgrade falls back to bearer auth when no wsTicket
 * query param is present (EnvironmentAuth.authenticateWebSocketUpgrade).
 *
 * Usage:
 *   node scripts/t3-session-import.mjs --session <id> [--project <projectId>] \
 *        [--driver claudeAgent|codex] [--expected-workspace-root <path>] \
 *        [--base-dir <dir>] [--timeout-seconds <n>] [--json]
 *
 * Prints { threadId, messages, resume, importedCount, skippedCount } (add --json for
 * machine output). Exit 0 = imported/already-present, 1 = error, 2 = usage.
 *
 * @module apps/server/scripts/t3-session-import
 */
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import { MegazordT3DispatchClient } from "../../../packages/megazord/src/dispatch.ts";

// The Obsidian Vault project the wa-orchestrator session belongs to. Overridable
// with --project so this stays a general primitive, not a one-off.
const DEFAULT_PROJECT_ID = "9957b78d-7785-4dc9-9788-32bdcf68b3b3";
const DEFAULT_DRIVER = "claudeAgent";
const DEFAULT_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const out = { project: DEFAULT_PROJECT_ID, driver: DEFAULT_DRIVER, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--session":
        out.session = next();
        break;
      case "--project":
        out.project = next();
        break;
      case "--driver":
        out.driver = next();
        break;
      case "--expected-workspace-root":
        out.expectedWorkspaceRoot = next();
        break;
      case "--base-dir":
        out.baseDir = next();
        break;
      case "--timeout-seconds":
        out.timeoutSeconds = Number(next());
        break;
      case "--json":
        out.json = true;
        break;
      case "--require-history":
        out.requireHistory = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return out;
}

const HELP = `t3-session-import — adopt a coding-agent session as a T3-owner thread

  --session <id>                 the provider session id to import (required)
  --project <projectId>          target project (default: the Obsidian Vault project)
  --driver claudeAgent|codex     provider harness for the deterministic thread id
                                 (default: claudeAgent)
  --expected-workspace-root <p>  guard: fail if the project moved off this root
  --base-dir <dir>               T3 base dir (default: ~/.t3)
  --timeout-seconds <n>          WS round-trip ceiling (default: 30)
  --require-history              exit 1 unless the imported thread exists WITH history
                                 (use as the cutover's verify step — idempotent)
  --json                         machine-readable output

Prints { threadId, messages, resume, importedCount, skippedCount }.
Import is project-scoped and idempotent; a still-active session is skipped upstream.
`;

/** Open a Bearer-authenticated WS RpcClient to <origin>/ws and run one call. */
function withWsRpc(origin, token, timeoutMs, f) {
  const wsUrl = `${origin.replace(/^http/, "ws").replace(/\/+$/, "")}/ws`;
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(socketUrl, protocols, {
        headers: { authorization: `Bearer ${token}` },
      }),
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(wsUrl).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
  return RpcClient.make(WsRpcGroup).pipe(
    Effect.flatMap(f),
    Effect.scoped,
    Effect.provide(protocol),
    Effect.timeout(timeoutMs),
  );
}

/** GET one thread's snapshot over HTTP — the same read the UI/dispatch client does. */
async function readThreadMessages(origin, token, threadId) {
  const url = `${origin.replace(/\/+$/, "")}/api/orchestration/threads/${encodeURIComponent(threadId)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!res.ok) return { exists: false, messages: 0 };
  const body = await res.json().catch(() => ({}));
  const thread = body?.thread;
  if (!thread || typeof thread !== "object") return { exists: false, messages: 0 };
  const messages = Array.isArray(thread.messages) ? thread.messages.length : 0;
  return { exists: true, messages };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.session || String(args.session).trim() === "") {
    console.error("--session is required");
    process.exit(2);
  }
  const timeoutMs = Number.isFinite(args.timeoutSeconds)
    ? Math.max(1, args.timeoutSeconds) * 1000
    : DEFAULT_TIMEOUT_MS;

  const client = new MegazordT3DispatchClient({
    ...(args.baseDir ? { baseDir: args.baseDir } : {}),
  });
  const [origin, token] = await Promise.all([client.origin(), client.token()]);

  // Deterministic owner-thread id (matches AgentSessionImporter.ts:167-168).
  const threadId = `import:${args.driver}:${args.session}`;

  const importResult = await Effect.runPromise(
    withWsRpc(origin, token, timeoutMs, (c) =>
      c[WS_METHODS.agentSessionsImport]({
        projectId: args.project,
        ...(args.expectedWorkspaceRoot
          ? { expectedWorkspaceRoot: args.expectedWorkspaceRoot }
          : {}),
      }),
    ),
  ).catch((e) => {
    console.error(`t3-session-import: import RPC failed: ${e?.message ?? String(e)}`);
    process.exit(1);
  });

  // Ground the history + prove the deterministic thread now exists.
  const back = await readThreadMessages(origin, token, threadId);

  const out = {
    threadId,
    project: args.project,
    importedCount: importResult.importedCount,
    skippedCount: importResult.skippedCount,
    messages: back.messages,
    // The resume cursor stored by the importer is { threadId, resume: <sessionId> }
    // (AgentSessionImporter.ts:236); a later turn resumes exactly this session id.
    resume: args.session,
    resumeCursor: { threadId, resume: args.session },
    threadExists: back.exists,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write(
      `imported into project ${out.project}\n` +
        `thread:   ${out.threadId}${out.threadExists ? "" : "  (not yet visible — history projecting)"}\n` +
        `messages: ${out.messages}\n` +
        `resume:   ${out.resume}\n` +
        `counts:   imported=${out.importedCount} skipped=${out.skippedCount}\n`,
    );
  }

  // Verify mode (the cutover's history-check step): fail loudly if the owner thread
  // is not present WITH imported history. Idempotent — safe to run right after import.
  if (args.requireHistory && !(out.threadExists && out.messages > 0)) {
    console.error(
      `t3-session-import: history check FAILED — threadExists=${out.threadExists} messages=${out.messages}`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
