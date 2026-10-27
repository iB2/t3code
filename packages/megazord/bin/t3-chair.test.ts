import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ChairRefusal } from "../src/chair.ts";
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
