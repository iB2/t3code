#!/usr/bin/env node
/**
 * t3-thread-wait — wait for a dispatched T3 turn to finish and print its answer.
 *
 * The companion to `t3-dispatch.mjs`: dispatch returns as soon as the turn is
 * STARTED, which is right for the dispatcher but leaves a chat channel with only a
 * link. This polls the thread snapshot until the turn reaches a terminal state and
 * prints the assistant text, so the caller (the WhatsApp orchestrator) can relay the
 * answer back to the human who asked.
 *
 * A turn blocked on an approval never terminates, so the wait ends at its own
 * ceiling with `state: "running", timedOut: true` rather than hanging.
 *
 * Usage:
 *   node bin/t3-thread-wait.mjs --thread <threadId> [--since <iso>] \
 *        [--timeout-seconds 900] [--poll-seconds 2] [--base-dir <dir>] [--json]
 *
 * @module megazord/bin/t3-thread-wait
 */
import { MegazordDispatchError, MegazordT3DispatchClient } from "../src/dispatch.ts";

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--thread":
        out.threadId = next();
        break;
      case "--since":
        out.since = next();
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

const HELP = `t3-thread-wait — wait for a dispatched turn and print its answer

  --thread <threadId>          the thread to watch (required)
  --since <iso>                ignore turns requested before this instant
  --timeout-seconds <n>        give up after this long (default 900)
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
  if (!args.threadId) {
    console.error("--thread is required");
    process.exit(2);
  }

  const client = new MegazordT3DispatchClient({
    ...(args.baseDir ? { baseDir: args.baseDir } : {}),
  });

  try {
    const out = await client.awaitTurn({
      threadId: args.threadId,
      ...(args.since ? { since: args.since } : {}),
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
    process.stdout.write(`state:  ${out.state}${out.timedOut ? " (timed out)" : ""}\n`);
    process.stdout.write(`thread: ${out.url}\n`);
    if (out.text !== "") process.stdout.write(`\n${out.text}\n`);
  } catch (e) {
    if (e instanceof MegazordDispatchError) {
      console.error(`t3-thread-wait: ${e.message}`);
      process.exit(e.refusal ? 3 : 1);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
