#!/usr/bin/env node
/**
 * t3-thread-turn — append ONE turn to an existing T3 thread and print its answer,
 * in a single call.
 *
 * The atomic round-trip a thin CLIENT makes against the single OWNER-hosted
 * session: where `t3-dispatch.mjs --thread <id>` starts a turn and returns as
 * soon as it is STARTED (leaving the caller to run `t3-thread-wait.mjs` and
 * compute its own `since`), this does both — send the turn and wait for the
 * assistant reply — so a chat channel gets the answer from one process and can
 * never latch onto the previous turn's text (the `since` instant is captured
 * before the turn is sent). Every surface (WhatsApp bridge, T3 GUI, another
 * machine) appends to the SAME thread, so memory carries across turns.
 *
 * A turn blocked on an approval/question never terminates, so the wait ends at its
 * own ceiling with `state: "running"|"awaiting-input", timedOut: true` rather than
 * hanging — the caller relays the link (or the question) and the human takes over.
 *
 * Usage:
 *   node bin/t3-thread-turn.mjs --thread <threadId> --task "<prompt>" \
 *        --scope ssb|general [--driver codex|claudeAgent] [--model <id>] \
 *        [--runtime <mode>] [--interaction default|plan] \
 *        [--timeout-seconds 900] [--poll-seconds 2] [--base-dir <dir>] [--json]
 *
 * The token is minted at runtime and NEVER written to disk.
 *
 * @module megazord/bin/t3-thread-turn
 */
import { MegazordDispatchError, MegazordT3DispatchClient } from "../src/dispatch.ts";

function parseArgs(argv) {
  const out = { scope: "general", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--thread":
        out.threadId = next();
        break;
      case "--task":
        out.task = next();
        break;
      case "--scope":
        out.scope = next();
        break;
      case "--driver":
        out.driver = next();
        break;
      case "--model":
        out.model = next();
        break;
      case "--runtime":
        out.runtimeMode = next();
        break;
      case "--interaction":
        out.interactionMode = next();
        break;
      case "--timeout-seconds":
        out.timeoutSeconds = Number(next());
        break;
      case "--poll-seconds":
        out.pollSeconds = Number(next());
        break;
      case "--base-dir":
        out.baseDir = next();
        break;
      case "--json":
        out.json = true;
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

const HELP = `t3-thread-turn — append a turn to an existing thread and print its answer

  --thread <threadId>          the existing thread to append to (required)
  --task "<prompt>"            the turn text (required)
  --scope ssb|general          NDA/quota scope, SAME the thread was created under
  --driver codex|claudeAgent   require a specific harness (match the thread's)
  --model <id>                 pin the model (validated per harness)
  --runtime <mode>             runtime mode (default: the client's approval-required)
  --interaction default|plan   interaction mode
  --timeout-seconds <n>        give up waiting after this long (default 900)
  --poll-seconds <n>           poll interval (default 2)
  --base-dir <dir>             T3 base dir (default: ~/.t3)
  --json                       machine-readable output
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.threadId || !args.task) {
    console.error("--thread and --task are required");
    process.exit(2);
  }
  if (args.scope !== "ssb" && args.scope !== "general") {
    console.error("--scope must be 'ssb' or 'general'");
    process.exit(2);
  }

  const client = new MegazordT3DispatchClient({
    ...(args.baseDir ? { baseDir: args.baseDir } : {}),
  });

  try {
    const out = await client.sendTurnAndAwait({
      threadId: args.threadId,
      task: args.task,
      scope: args.scope,
      ...(args.driver ? { driver: args.driver } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.runtimeMode ? { runtimeMode: args.runtimeMode } : {}),
      ...(args.interactionMode ? { interactionMode: args.interactionMode } : {}),
      ...(Number.isFinite(args.timeoutSeconds)
        ? { timeoutMs: Math.max(1, args.timeoutSeconds) * 1000 }
        : {}),
      ...(Number.isFinite(args.pollSeconds)
        ? { pollMs: Math.max(1, args.pollSeconds) * 1000 }
        : {}),
    });
    if (args.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      `route:  ${out.instanceId} (${out.driver}, model ${out.model})\n` +
        `state:  ${out.state}${out.timedOut ? " (timed out)" : ""}\n` +
        `thread: ${out.url}\n`,
    );
    if (out.text !== "") process.stdout.write(`\n${out.text}\n`);
  } catch (e) {
    if (e instanceof MegazordDispatchError) {
      console.error(`t3-thread-turn: ${e.message}`);
      if (e.detail?.responseText) console.error(`  server: ${e.detail.responseText}`);
      process.exit(e.refusal ? 3 : 1);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
