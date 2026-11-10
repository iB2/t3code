import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ChairRefusal, effortLevelsFor, parsePolicy } from "../src/chair.ts";
import { VERBS } from "./t3-chair.mjs";

// T3's MCP clips a queued message to 1,000 characters in t3_queue_list and to
// 16,000 in t3_queue_read, flagging `truncated` (server.asar, queueEntry). The
// fake below does the same, so a test text longer than 1,000 only comes back
// whole if the chair reads each message on its own.
const LIST_CHARS = 1000;
const READ_CHARS = 16000;

interface Queued {
  readonly queuedRunId: string;
  readonly text: string;
  readonly requestedAt: string;
}

function entry(q: Queued, limit: number) {
  const chars = Array.from(q.text);
  return {
    queuedRunId: q.queuedRunId,
    text: chars.slice(0, limit).join(""),
    truncated: chars.length > limit,
  };
}

/** A thread whose last turn failed while messages sat in its queue (the #15 case). */
function fakeSession(baseDir: string, queue: ReadonlyArray<Queued>) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; filesThen: boolean }> = [];
  const thread = {
    threadId: "thread-1",
    projectId: "own-project",
    status: "queued",
    latestRunId: queue.at(-1)?.queuedRunId ?? "run:1",
    activeRunId: null,
    pendingRequestCount: 0,
    itemCount: 12,
    settled: false,
  };
  const recentRuns = [
    ...queue.map((q, i) => ({
      runId: q.queuedRunId,
      ordinal: i + 2,
      status: "queued",
      requestedAt: q.requestedAt,
      startedAt: null,
      completedAt: null,
    })),
    {
      runId: "run:1",
      ordinal: 1,
      status: "failed",
      requestedAt: "2026-10-18T15:40:00.000Z",
      startedAt: "2026-10-18T15:40:11.413Z",
      completedAt: "2026-10-18T16:56:17.762Z",
    },
  ].toReversed();
  const dropped = NodePath.join(baseDir, "chair", "dropped");
  const mcp = {
    async call(tool: string, args: Record<string, unknown> = {}) {
      calls.push({ tool, args, filesThen: NodeFS.existsSync(dropped) });
      switch (tool) {
        case "t3_thread_read":
          return { thread, recentRuns, items: [], nextPosition: null, hasMore: false };
        case "t3_queue_list":
          return { items: queue.map((q) => entry(q, LIST_CHARS)), nextCursor: null };
        case "t3_queue_read": {
          const q = queue.find((x) => x.queuedRunId === args["queuedRunId"]);
          if (q === undefined) throw new Error("The queued message was not found.");
          return entry(q, READ_CHARS);
        }
        case "t3_queue_cancel":
        case "t3_thread_organize":
          return { sequence: 1 };
        default:
          throw new Error(`unexpected tool ${tool}`);
      }
    },
  };
  const session = {
    baseDir,
    env: { name: "local", mcpUrl: "http://127.0.0.1:1/mcp" },
    mcp,
    getThread: async (id: string) => ({
      id,
      projectId: "own-project",
      mcp: { ...thread, recentRuns },
    }),
    url: async (id: string) => `http://127.0.0.1:1/env/${id}`,
  };
  return { session, calls };
}

const writes = (calls: ReadonlyArray<{ tool: string }>) =>
  calls.filter((c) => c.tool === "t3_queue_cancel" || c.tool === "t3_thread_organize");

/** A long brief: 3,000 characters with a line that only appears at the end. */
const LONG = `${"Revise o PR e rode a suíte inteira. ".repeat(83)}\nÚLTIMA LINHA: não faça merge.`;

let baseDir: string;

afterEach(async () => {
  if (baseDir !== undefined) await NodeFSP.rm(baseDir, { recursive: true, force: true });
});

async function freshBaseDir() {
  baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chair-test-"));
  return baseDir;
}

const settleArgs = {
  verb: "settle",
  thread: "thread-1",
  why: "work finished; the queued follow-up is stale",
  "drop-queued": true,
};

describe("settle --drop-queued", () => {
  it("saves each queued message whole, under ~/.t3/chair/dropped, before cancelling it", async () => {
    const { session, calls } = fakeSession(await freshBaseDir(), [
      { queuedRunId: "run:2", text: LONG, requestedAt: "2026-10-18T16:50:02.000Z" },
    ]);

    const out = await VERBS.settle(session, { ...settleArgs });

    const file = NodePath.join(baseDir, "chair", "dropped", "thread-1", "run_2.md");
    const saved = await NodeFSP.readFile(file, "utf8");
    expect(saved).toContain(LONG);
    expect(saved).toContain("ÚLTIMA LINHA: não faça merge.");
    expect(saved).toContain("thread-1");
    expect(saved).toContain("run:2");
    expect(saved).toContain("2026-10-18T16:50:02.000Z");

    // The file existed before the first cancel went out.
    const cancel = calls.find((c) => c.tool === "t3_queue_cancel");
    expect(cancel?.args).toEqual({ threadId: "thread-1", queuedRunId: "run:2" });
    expect(cancel?.filesThen).toBe(true);

    expect(out.settled).toBe(true);
    expect(out.droppedQueued).toEqual([{ queuedRunId: "run:2", file }]);

    const log = (await NodeFSP.readFile(NodePath.join(baseDir, "chair", "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(log[0].phase).toBe("intent");
    expect(log[0].droppedQueued).toEqual([
      expect.objectContaining({
        queuedRunId: "run:2",
        queuedAt: "2026-10-18T16:50:02.000Z",
        chars: Array.from(LONG).length,
        file,
      }),
    ]);
  });

  it("refuses, cancelling nothing, when the text cannot be saved", async () => {
    const { session, calls } = fakeSession(await freshBaseDir(), [
      { queuedRunId: "run:2", text: LONG, requestedAt: "2026-10-18T16:50:02.000Z" },
    ]);
    // A file where the folder must go: the save fails.
    await NodeFSP.mkdir(NodePath.join(baseDir, "chair"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(baseDir, "chair", "dropped"), "not a folder", "utf8");

    await expect(VERBS.settle(session, { ...settleArgs })).rejects.toThrow(ChairRefusal);
    await expect(VERBS.settle(session, { ...settleArgs })).rejects.toThrow(/could not save/);
    expect(writes(calls)).toEqual([]);
  });

  it("refuses, cancelling nothing, when T3 hands back only part of the text", async () => {
    const huge = "x".repeat(READ_CHARS + 500);
    const { session, calls } = fakeSession(await freshBaseDir(), [
      { queuedRunId: "run:2", text: "short and whole", requestedAt: "2026-10-18T16:50:02.000Z" },
      { queuedRunId: "run:3", text: huge, requestedAt: "2026-10-18T16:51:00.000Z" },
    ]);

    await expect(VERBS.settle(session, { ...settleArgs })).rejects.toThrow(/run:3.*truncated/);
    expect(writes(calls)).toEqual([]);
  });

  it("refuses, cancelling nothing, when a queued message comes back empty", async () => {
    const { session, calls } = fakeSession(await freshBaseDir(), [
      { queuedRunId: "run:2", text: "  ", requestedAt: "2026-10-18T16:50:02.000Z" },
    ]);

    await expect(VERBS.settle(session, { ...settleArgs })).rejects.toThrow(/run:2.*empty/);
    expect(writes(calls)).toEqual([]);
  });
});

describe("queue", () => {
  it("lists every queued message with its id, date and whole text, and writes nothing", async () => {
    const { session, calls } = fakeSession(await freshBaseDir(), [
      { queuedRunId: "run:2", text: LONG, requestedAt: "2026-10-18T16:50:02.000Z" },
      { queuedRunId: "run:3", text: "second", requestedAt: "2026-10-18T16:51:00.000Z" },
    ]);

    const out = await VERBS.queue(session, { verb: "queue", thread: "thread-1" });

    expect(out.threadId).toBe("thread-1");
    expect(out.items).toEqual([
      {
        queuedRunId: "run:2",
        queuedAt: "2026-10-18T16:50:02.000Z",
        chars: Array.from(LONG).length,
        complete: true,
        text: LONG,
      },
      {
        queuedRunId: "run:3",
        queuedAt: "2026-10-18T16:51:00.000Z",
        chars: 6,
        complete: true,
        text: "second",
      },
    ]);
    expect(out.items[0].text.length).toBeGreaterThan(200);
    expect(writes(calls)).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(baseDir, "chair"))).toBe(false);
  });
});

const OPEN_POLICY = parsePolicy({
  blockedProjectIds: ["client-project"],
  blockedInstanceIds: ["client-account"],
});

function capabilityProviders(effort: Record<string, unknown>) {
  return [
    {
      providerInstanceId: "own-account",
      models: [{ id: "opus", options: [{ id: "effort", ...effort }] }],
    },
  ];
}

function openHarness(dir: string, providers: ReadonlyArray<unknown>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const session = {
    baseDir: dir,
    env: { name: "local", mcpUrl: "http://127.0.0.1:9/mcp" },
    policy: OPEN_POLICY,
    projects: [{ id: "own-project", title: "Own" }],
    accounts: async () => [{ account: "Claude", instanceId: "own-account", models: ["opus"] }],
    effortLevels: async (instanceId: string, model: string) =>
      effortLevelsFor(providers, instanceId, model),
    accountName: async () => "Claude",
    url: async (id: string) => `http://127.0.0.1:9/env/${id}`,
    mcp: {
      async call(tool: string, args: Record<string, unknown> = {}) {
        calls.push({ tool, args });
        if (tool === "t3_thread_launch") return { threadId: "thread-new" };
        if (tool === "t3_thread_read") {
          return {
            thread: {
              threadId: "thread-new",
              providerInstanceId: "own-account",
              model: "opus",
              projectId: "own-project",
            },
          };
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    },
  };
  return { session, calls };
}

const openArgs = {
  verb: "open",
  project: "own-project",
  title: "effort pilot",
  task: "Reply with the single word pong.",
  why: "require effort high",
  account: "Claude",
  "no-start": true,
};

function launched(calls: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>) {
  return calls.find((call) => call.tool === "t3_thread_launch");
}

describe("open effort", () => {
  it("sends effort high by default when v0.1.7 lists it in values", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ values: ["low", "medium", "high", false] }),
    );
    const out = await VERBS.open(session, { ...openArgs });
    expect(launched(calls)?.args["modelSelection"]).toEqual({
      instanceId: "own-account",
      model: "opus",
      options: [{ id: "effort", value: "high" }],
    });
    expect(out.effort).toBe("high");
  });

  it("sends an explicit high", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ values: ["low", "medium", "high"] }),
    );
    const out = await VERBS.open(session, { ...openArgs, effort: "high" });
    expect(launched(calls)?.args["modelSelection"]).toEqual({
      instanceId: "own-account",
      model: "opus",
      options: [{ id: "effort", value: "high" }],
    });
    expect(out.effort).toBe("high");
  });

  it("sends effort high from the older nested options shape", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ options: [{ id: "low" }, { id: "high" }] }),
    );
    const out = await VERBS.open(session, { ...openArgs });
    expect(launched(calls)?.args["modelSelection"]).toEqual({
      instanceId: "own-account",
      model: "opus",
      options: [{ id: "effort", value: "high" }],
    });
    expect(out.effort).toBe("high");
  });

  it("refuses an effort the model does not offer and does not launch", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ values: ["low", "medium"] }),
    );
    await expect(VERBS.open(session, { ...openArgs, effort: "high" })).rejects.toThrow(/opus/);
    expect(launched(calls)).toBeUndefined();
  });

  it("refuses the default open when high is not offered and does not launch", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ values: ["low", "medium"] }),
    );
    await expect(VERBS.open(session, { ...openArgs })).rejects.toThrow(ChairRefusal);
    await expect(VERBS.open(session, { ...openArgs })).rejects.toThrow(/requires effort 'high'/);
    expect(launched(calls)).toBeUndefined();
  });
});

describe("continue --effort", () => {
  it("reads and sets effort with t3_thread_configure", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const providers = capabilityProviders({ values: ["low", "high"] });
    let selection: {
      instanceId: string;
      model: string;
      options: Array<{ id: string; value: string }>;
    } = { instanceId: "own-account", model: "opus", options: [] };
    const session = {
      baseDir: await freshBaseDir(),
      env: { name: "local", mcpUrl: "http://127.0.0.1:9/mcp" },
      effortLevels: async (instanceId: string, model: string) =>
        effortLevelsFor(providers, instanceId, model),
      url: async (id: string) => `http://127.0.0.1:9/env/${id}`,
      getThread: async () => ({
        id: "thread-1",
        modelSelection: { instanceId: "own-account", model: "opus" },
      }),
      mcp: {
        async call(tool: string, args: Record<string, unknown> = {}) {
          calls.push({ tool, args });
          if (tool === "t3_thread_configure" && args["modelSelection"] === undefined) {
            return {
              threadId: "thread-1",
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
            };
          }
          if (tool === "t3_thread_configure") {
            selection = args["modelSelection"] as typeof selection;
            return { sequence: 1 };
          }
          if (tool === "t3_thread_send") return { runId: "run-9" };
          throw new Error(`unexpected tool ${tool}`);
        },
      },
    };
    const out = await VERBS.continue(session, {
      verb: "continue",
      thread: "thread-1",
      task: "Reply with the single word pong.",
      why: "set effort",
      effort: "high",
    });
    expect(out.effort).toBe("high");
    const configured = calls.filter(
      (call) => call.tool === "t3_thread_configure" && call.args["modelSelection"] !== undefined,
    );
    expect(configured).toHaveLength(1);
    expect(configured[0]?.args["modelSelection"]).toEqual({
      instanceId: "own-account",
      model: "opus",
      options: [{ id: "effort", value: "high" }],
    });
    expect(calls.some((call) => call.tool === "t3_thread_configuration")).toBe(false);
    expect(calls.some((call) => call.tool === "t3_thread_send")).toBe(true);
  });
});
