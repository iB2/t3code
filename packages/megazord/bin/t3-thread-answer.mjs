#!/usr/bin/env node
/**
 * t3-thread-answer — answer the question a T3 turn is blocked on.
 *
 * The other half of `t3-thread-wait.mjs`: when a turn stops on an interactive
 * question, the human is usually not at the T3 window — they are in the chat the
 * turn was dispatched from. This sends their reply back as the answer, so the turn
 * continues instead of waiting for someone to open the UI.
 *
 * The reply is free text (the channel has one reply box, not a form). Typing an
 * option's label matches that option exactly.
 *
 * Usage:
 *   node bin/t3-thread-answer.mjs --thread <threadId> --request <requestId> \
 *        --answer "<text>" [--base-dir <dir>] [--json]
 *
 * @module megazord/bin/t3-thread-answer
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
      case "--request":
        out.requestId = next();
        break;
      case "--answer":
        out.answer = next();
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

const HELP = `t3-thread-answer — answer a blocked turn's question

  --thread <threadId>          the blocked thread (required)
  --request <requestId>        the open question id, from t3-thread-wait (required)
  --answer "<text>"            the reply; an option label matches that option
  --base-dir <dir>             T3 base dir (default: ~/.t3)
  --json                       machine-readable output
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.threadId || !args.requestId || !args.answer) {
    console.error("--thread, --request and --answer are required");
    process.exit(2);
  }

  const client = new MegazordT3DispatchClient({
    ...(args.baseDir ? { baseDir: args.baseDir } : {}),
  });

  try {
    const sequence = await client.respondUserInput({
      threadId: args.threadId,
      requestId: args.requestId,
      answer: args.answer,
    });
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, sequence }, null, 2) + "\n");
      return;
    }
    process.stdout.write(`answered (sequence ${sequence})\n`);
  } catch (e) {
    if (e instanceof MegazordDispatchError) {
      console.error(`t3-thread-answer: ${e.message}`);
      process.exit(e.refusal ? 3 : 1);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
