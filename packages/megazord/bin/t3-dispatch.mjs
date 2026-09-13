#!/usr/bin/env node
/**
 * t3-dispatch — the CLI the wa-orchestrator calls to hand work to the running
 * T3 desktop as a routed thread (ORCH → T3), replacing the shadow subagent.
 *
 * It resolves the live server origin, mints a scoped token, reads the account
 * inventory + best-effort quota, applies the routing policy (SSB-exclusive /
 * general pool), and dispatches `thread.create` (+ `thread.turn.start`).
 *
 * Usage:
 *   node bin/t3-dispatch.mjs --task "<prompt>" --scope ssb|general \
 *        [--driver codex|claudeAgent] [--model <id>] [--needs <connector>] \
 *        [--project <projectId>] [--project-title "<title>"] \
 *        [--mode select|create|full] [--runtime approval-required|auto|...] \
 *        [--base-dir <dir>] [--json]
 *
 * Prints the thread link (or, for --mode select, only the routing decision).
 * The token is minted at runtime and NEVER written to disk.
 *
 * @module megazord/bin/t3-dispatch
 */
import { MegazordDispatchError, MegazordT3DispatchClient } from "../src/dispatch.ts";

function parseArgs(argv) {
  const out = { mode: "full", scope: "general", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
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
      case "--needs":
        out.needs = next();
        break;
      case "--project":
        out.projectId = next();
        break;
      case "--project-title":
        out.projectTitle = next();
        break;
      case "--title":
        out.title = next();
        break;
      case "--mode":
        out.mode = next();
        break;
      case "--runtime":
        out.runtimeMode = next();
        break;
      case "--interaction":
        out.interactionMode = next();
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

const HELP = `t3-dispatch — dispatch orchestrator work as a routed T3 thread

  --task "<prompt>"            the first-turn prompt (required for create/full)
  --scope ssb|general          NDA/quota scope (default: general)
  --driver codex|claudeAgent   require a specific harness
  --model <id>                 pin the thread's model (validated per harness)
  --needs <connector>          require an exclusive connector/MCP
  --project <projectId>        target project id
  --project-title "<title>"    resolve project id by exact title
  --mode select|create|full    select = route only (no dispatch, safe for SSB);
                               create = thread.create only (no harness/quota);
                               full = create + first turn (default)
  --runtime <mode>             runtime mode (default: approval-required)
  --base-dir <dir>             T3 base dir (default: ~/.t3)
  --json                       machine-readable output
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.scope !== "ssb" && args.scope !== "general") {
    console.error("--scope must be 'ssb' or 'general'");
    process.exit(2);
  }
  if (args.mode !== "select" && !args.task) {
    console.error("--task is required for --mode create|full");
    process.exit(2);
  }

  const client = new MegazordT3DispatchClient({
    ...(args.baseDir ? { baseDir: args.baseDir } : {}),
  });

  try {
    const out = await client.dispatch({
      task: args.task ?? "",
      scope: args.scope,
      mode: args.mode,
      ...(args.driver ? { driver: args.driver } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.needs ? { needs: args.needs } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.projectTitle ? { projectTitle: args.projectTitle } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.runtimeMode ? { runtimeMode: args.runtimeMode } : {}),
      ...(args.interactionMode ? { interactionMode: args.interactionMode } : {}),
    });

    if (args.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }
    if (out.mode === "select") {
      process.stdout.write(
        `route: ${out.instanceId} (${out.driver}, model ${out.model})\n` +
          `why:   ${out.decision.reason}\n`,
      );
      return;
    }
    process.stdout.write(
      `dispatched to ${out.instanceId} (${out.driver}, model ${out.model})\n` +
        `why:    ${out.decision.reason}\n` +
        `thread: ${out.threadId}\n` +
        `link:   ${out.url}\n`,
    );
  } catch (e) {
    if (e instanceof MegazordDispatchError) {
      console.error(`t3-dispatch: ${e.message}`);
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
