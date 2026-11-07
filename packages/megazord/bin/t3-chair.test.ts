import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ChairRefusal,
  effortLevelsFor,
  parsePolicy,
  projectVisible,
  threadVisible,
} from "../src/chair.ts";
import { piecesFromDetail, reconcileTimeline } from "../src/threadRead.ts";
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

const READ_POLICY = parsePolicy({
  blockedProjectIds: ["client-project"],
  blockedInstanceIds: ["client-account"],
});

function serverItem(over: Record<string, unknown> = {}) {
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "source-1",
    itemId: "item-a",
    runId: "run-1",
    messageId: "msg-a",
    createdBy: "user",
    creationSource: "web",
    senderThreadId: "parent-1",
    type: "user_message",
    status: "completed",
    title: null,
    text: "alpha",
    fullText: undefined as string | undefined,
    textTruncated: false,
    nextTextOffset: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

function presentItem(item: Record<string, unknown>, args: Record<string, unknown>) {
  const copy = { ...item };
  delete copy["fullText"];
  const full = item["fullText"];
  if (typeof full !== "string") return copy;
  const max = Number(args["maxCharsPerItem"] ?? full.length);
  const offset = args["itemId"] === undefined ? 0 : Number(args["textOffset"] ?? 0);
  const text = full.slice(offset, offset + max);
  const cut = full.length > offset + text.length;
  return {
    ...copy,
    text,
    textTruncated: cut,
    nextTextOffset: cut ? offset + text.length : null,
  };
}

function readSession(options: {
  readonly projectId?: string;
  readonly instanceId?: string;
  readonly status?: string;
  readonly pendingRequestCount?: number;
  readonly endpoint?: string;
  items: Array<Record<string, unknown>>;
}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const projectId = options.projectId ?? "own-project";
  const instanceId = options.instanceId ?? "own-account";
  const thread = {
    threadId: "thread-1",
    projectId,
    title: "Pilot",
    updatedAt: "2026-11-01T00:00:00.000Z",
    branch: "main",
    runtimeMode: "full-access",
    providerInstanceId: instanceId,
    model: "opus",
    status: options.status ?? "completed",
    latestRunId: "run-1",
    activeRunId: null,
    pendingRequestCount: options.pendingRequestCount ?? 0,
    itemCount: options.items.length,
    settled: false,
  };
  const mcp = {
    async call(tool: string, args: Record<string, unknown> = {}) {
      calls.push({ tool, args });
      if (tool === "t3_thread_configure") {
        return {
          threadId: thread.threadId,
          modelSelection: {
            instanceId,
            model: "opus",
            options: [{ id: "effort", value: "high" }],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
        };
      }
      if (tool === "t3_pending_request" && args["action"] === "list") {
        return { requestIds: ["req-1"] };
      }
      if (tool === "t3_pending_request" && args["action"] === "read") {
        return {
          requestId: "req-1",
          questions: [
            {
              id: "q1",
              header: "Go",
              question: "Continue?",
              options: [{ label: "Yes", value: "yes" }],
            },
          ],
        };
      }
      if (tool !== "t3_thread_read") throw new Error(`unexpected tool ${tool}`);
      if (args["view"] === undefined) {
        return { thread, recentRuns: [], items: [], nextPosition: null, hasMore: false };
      }
      const view = String(args["view"]);
      let rows = options.items.filter((item) =>
        args["itemId"] !== undefined
          ? item["itemId"] === args["itemId"]
          : view === "activity" ||
            ["user_message", "assistant_message", "proposed_plan"].includes(String(item["type"])),
      );
      if (args["itemId"] === undefined && args["afterPosition"] !== undefined) {
        rows = rows.filter((item) => Number(item["position"]) > Number(args["afterPosition"]));
      }
      const limit = Number(args["limit"] ?? rows.length);
      const page = rows.slice(0, limit).map((item) => presentItem(item, args));
      const last = page[page.length - 1];
      return {
        thread,
        recentRuns: [],
        items: page,
        nextPosition: last === undefined ? null : (last["position"] ?? null),
        hasMore: rows.length > page.length,
      };
    },
  };
  const session = {
    baseDir: "/tmp/t3-chair-read",
    env: { name: "local", mcpUrl: options.endpoint ?? "http://127.0.0.1:9/mcp" },
    projects: [{ id: projectId, title: projectId === "own-project" ? "Own" : "Hidden" }],
    accountName: async () => "Claude",
    url: async (id: string) => `http://127.0.0.1:9/env/${id}`,
    mcp,
    getThread: async (id: string) => {
      const body = (await mcp.call("t3_thread_read", {
        threadId: id,
        limit: 1,
        maxCharsPerItem: 1,
      })) as { thread: typeof thread };
      const t = body.thread;
      const row = {
        id: t.threadId,
        projectId: t.projectId,
        deletedAt: null,
        title: t.title,
        updatedAt: t.updatedAt,
        branch: t.branch,
        runtimeMode: t.runtimeMode,
        modelSelection: { instanceId: t.providerInstanceId, model: t.model },
        mcp: t,
      };
      const project = { id: t.projectId, deletedAt: null };
      if (!projectVisible(READ_POLICY, project) || !threadVisible(READ_POLICY, row)) {
        throw new ChairRefusal(`refused: no thread '${id}' within the chair policy`);
      }
      return row;
    },
  };
  return { session, calls };
}

describe("read", () => {
  const visible = [
    serverItem({
      itemId: "item-user",
      messageId: "msg-user",
      text: "hello",
      position: 0,
    }),
    serverItem({
      itemId: "item-run",
      type: "assistant_message",
      status: "running",
      text: "still going",
      createdBy: "agent",
      position: 1,
    }),
    serverItem({
      itemId: "item-assistant",
      messageId: "msg-assistant",
      type: "assistant_message",
      createdBy: "agent",
      creationSource: "mcp",
      text: "world",
      textTruncated: true,
      nextTextOffset: 5,
      position: 2,
      updatedAt: "2026-11-01T00:02:00.000Z",
    }),
    serverItem({
      itemId: "item-blank",
      text: "   ",
      position: 3,
    }),
    serverItem({
      itemId: "item-tool",
      type: "tool",
      text: "ran a tool",
      messageId: null,
      createdBy: null,
      creationSource: null,
      senderThreadId: undefined,
      position: 4,
    }),
  ];

  it("keeps the legacy JSON to role, time, and text", async () => {
    const { session, calls } = readSession({ items: visible });
    const out = await VERBS.read(session, { verb: "read", thread: "thread-1", chars: "4000" });

    expect(out.messages).toEqual([
      { role: "user", at: "2026-11-01T00:00:00.000Z", text: "hello" },
      { role: "assistant", at: "2026-11-01T00:02:00.000Z", text: "world… [truncated]" },
    ]);
    expect(out.items).toBeUndefined();
    expect(out.endpoint).toBeUndefined();
    expect(out.effort).toBe("high");
    expect(JSON.stringify(out)).not.toContain("item-user");
    expect(JSON.stringify(out)).not.toContain("source-1");
    expect(calls.some((call) => call.tool === "t3_thread_configuration")).toBe(false);
    expect(
      calls.some(
        (call) => call.tool === "t3_thread_configure" && call.args["modelSelection"] === undefined,
      ),
    ).toBe(true);
    const page = calls.find((call) => call.args["view"] === "messages");
    expect(page?.args["afterPosition"]).toBeUndefined();
  });

  it("counts a server truncation marker inside the chair clip (known baseline)", async () => {
    const { session } = readSession({
      items: [
        serverItem({
          text: "abc",
          textTruncated: true,
          nextTextOffset: 3,
        }),
      ],
    });
    const out = await VERBS.read(session, { verb: "read", thread: "thread-1", chars: "3" });
    expect(out.messages).toEqual([
      { role: "user", at: "2026-11-01T00:00:00.000Z", text: "abc… [+13 chars]" },
    ]);
  });

  it("still clips a long legacy message", async () => {
    const { session } = readSession({
      items: [serverItem({ text: "abcdef", textTruncated: false, nextTextOffset: null })],
    });
    const out = await VERBS.read(session, { verb: "read", thread: "thread-1", chars: "3" });
    expect(out.messages).toEqual([
      { role: "user", at: "2026-11-01T00:00:00.000Z", text: "abc… [+3 chars]" },
    ]);
  });

  it("preserves identity, origin, and continuation on --detail", async () => {
    const { session, calls } = readSession({ items: visible });
    const out = await VERBS.read(session, { verb: "read", thread: "thread-1", detail: true });

    expect(out.messages).toBeUndefined();
    expect(out.endpoint).toBe("http://127.0.0.1:9/mcp");
    expect(out.view).toBe("messages");
    expect(out.textKind).toBe("item");
    expect(out.textOffset).toBeNull();
    expect(out.afterPosition).toBeNull();
    expect(out.hasMore).toBe(false);
    expect(out.items.map((item: { itemId: string }) => item.itemId)).toEqual([
      "item-user",
      "item-run",
      "item-assistant",
      "item-blank",
    ]);
    expect(out.items[2]).toMatchObject({
      sourceThreadId: "source-1",
      itemId: "item-assistant",
      messageId: "msg-assistant",
      runId: "run-1",
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: "parent-1",
      type: "assistant_message",
      status: "completed",
      updatedAt: "2026-11-01T00:02:00.000Z",
      text: "world",
      textTruncated: true,
      nextTextOffset: 5,
    });
    expect(calls.find((call) => call.args["view"] === "messages")?.args).not.toHaveProperty(
      "afterPosition",
    );
  });

  it("reads activity and messages as different pages", async () => {
    const { session, calls } = readSession({ items: visible });
    const activity = await VERBS.read(session, {
      verb: "read",
      thread: "thread-1",
      detail: true,
      view: "activity",
    });
    const messages = await VERBS.read(session, {
      verb: "read",
      thread: "thread-1",
      detail: true,
      view: "messages",
    });

    expect(activity.items.map((item: { type: string }) => item.type)).toContain("tool");
    expect(messages.items.map((item: { type: string }) => item.type)).not.toContain("tool");
    expect(
      calls.filter((call) => call.args["view"] !== undefined).map((call) => call.args["view"]),
    ).toEqual(["activity", "messages"]);
  });

  it("continues a cut item with itemId and textOffset, and pages with afterPosition", async () => {
    const { session, calls } = readSession({
      items: [
        serverItem({
          itemId: "item-long",
          fullText: "abcdefghij",
          text: "abcdefghij",
          position: 0,
        }),
        serverItem({ itemId: "item-next", text: "later", position: 1 }),
      ],
    });

    const first = await VERBS.read(session, {
      verb: "read",
      thread: "thread-1",
      detail: true,
      chars: "4",
      messages: "1",
    });
    expect(first.textKind).toBe("item");
    expect(first.items[0]).toMatchObject({
      itemId: "item-long",
      text: "abcd",
      textTruncated: true,
      nextTextOffset: 4,
    });
    expect(first.hasMore).toBe(true);
    expect(first.nextPosition).toBe(0);

    const rest = await VERBS.read(session, {
      verb: "read",
      thread: "thread-1",
      detail: true,
      item: "item-long",
      offset: "4",
      chars: "4",
    });
    expect(rest.textKind).toBe("fragment");
    expect(rest.textOffset).toBe(4);
    expect(rest.items[0]).toMatchObject({
      itemId: "item-long",
      text: "efgh",
      textTruncated: true,
      nextTextOffset: 8,
    });
    expect(rest.items[0].text).not.toBe("abcdefghij");

    const nextPage = await VERBS.read(session, {
      verb: "read",
      thread: "thread-1",
      detail: true,
      after: "0",
    });
    expect(nextPage.items.map((item: { itemId: string }) => item.itemId)).toEqual(["item-next"]);
    expect(nextPage.afterPosition).toBe(0);

    const detailCalls = calls.filter((call) => call.args["view"] === "messages");
    expect(detailCalls[0]?.args["afterPosition"]).toBeUndefined();
    expect(detailCalls[1]?.args).toMatchObject({ itemId: "item-long", textOffset: 4 });
    expect(detailCalls[2]?.args["afterPosition"]).toBe(0);
  });

  it("refuses a thread outside the fence and does not return its text", async () => {
    const { session, calls } = readSession({
      projectId: "client-project",
      items: [serverItem({ text: "FENCE-SECRET", fullText: "FENCE-SECRET" })],
    });

    await expect(VERBS.read(session, { verb: "read", thread: "thread-1" })).rejects.toThrow(
      ChairRefusal,
    );
    await expect(
      VERBS.read(session, { verb: "read", thread: "thread-1", detail: true, view: "activity" }),
    ).rejects.toThrow(ChairRefusal);
    const blockedAccount = readSession({
      instanceId: "client-account",
      items: [serverItem({ text: "ACCOUNT-SECRET", fullText: "ACCOUNT-SECRET" })],
    });
    await expect(
      VERBS.read(blockedAccount.session, { verb: "read", thread: "thread-1", detail: true }),
    ).rejects.toThrow(ChairRefusal);
    expect(calls.some((call) => call.args["view"] !== undefined)).toBe(false);
    expect(blockedAccount.calls.some((call) => call.args["view"] !== undefined)).toBe(false);
    expect(JSON.stringify(calls)).not.toContain("FENCE-SECRET");
    expect(JSON.stringify(blockedAccount.calls)).not.toContain("ACCOUNT-SECRET");
  });

  it("uses the consolidated pending read when a thread is waiting", async () => {
    const { session, calls } = readSession({
      status: "running",
      pendingRequestCount: 1,
      items: [serverItem()],
    });
    const out = await VERBS.read(session, { verb: "read", thread: "thread-1", detail: true });
    expect(out.status).toBe("question");
    expect(out.items).toHaveLength(1);
    expect(
      calls.filter((call) => call.tool === "t3_pending_request").map((call) => call.args["action"]),
    ).toEqual(["list", "read"]);
    expect(
      calls.some(
        (call) => call.tool === "t3_thread_configure" && call.args["modelSelection"] === undefined,
      ),
    ).toBe(true);
    expect(calls.some((call) => call.tool === "t3_pending_request_list")).toBe(false);
    expect(calls.some((call) => call.tool === "t3_thread_configuration")).toBe(false);
  });

  it("dedupes inserted, edited, and removed items by endpoint and identity", async () => {
    const items = [
      serverItem({
        itemId: "item-a",
        text: "alpha",
        position: 0,
        updatedAt: "2026-11-01T00:00:00.000Z",
      }),
      serverItem({
        itemId: "item-b",
        messageId: "msg-b",
        text: "beta",
        position: 1,
        updatedAt: "2026-11-01T00:01:00.000Z",
      }),
    ];
    const { session } = readSession({ items, endpoint: "http://127.0.0.1:9/mcp" });
    const first = await VERBS.read(session, { verb: "read", thread: "thread-1", detail: true });
    items.splice(
      0,
      2,
      serverItem({
        itemId: "item-b",
        messageId: "msg-b",
        text: "beta edited",
        position: 4,
        updatedAt: "2026-11-02T00:00:00.000Z",
      }),
      serverItem({
        itemId: "item-c",
        messageId: "msg-c",
        text: "gamma",
        position: 5,
        createdBy: "agent",
      }),
    );
    const second = await VERBS.read(session, { verb: "read", thread: "thread-1", detail: true });
    const opened = reconcileTimeline({
      previous: [],
      endpoint: first.endpoint,
      threadId: first.threadId,
      pieces: piecesFromDetail(first),
      hasMore: first.hasMore,
      mode: "snapshot",
      view: first.view,
    });
    const reread = reconcileTimeline({
      previous: opened.records,
      endpoint: second.endpoint,
      threadId: second.threadId,
      pieces: piecesFromDetail(second),
      hasMore: second.hasMore,
      mode: "snapshot",
      view: second.view,
    });

    expect(reread.removed.map((entry) => entry.item.itemId)).toEqual(["item-a"]);
    expect(
      reread.records.map((entry) => [entry.item.itemId, entry.item.text, entry.item.position]),
    ).toEqual([
      ["item-b", "beta edited", 4],
      ["item-c", "gamma", 5],
    ]);
    expect(reread.records.filter((entry) => entry.item.itemId === "item-b")).toHaveLength(1);

    const overlap = reconcileTimeline({
      previous: opened.records,
      endpoint: second.endpoint,
      threadId: second.threadId,
      pieces: piecesFromDetail({
        textKind: "item",
        textOffset: null,
        items: second.items.filter((item: { itemId: string }) => item.itemId === "item-c"),
      }),
      hasMore: true,
      mode: "page",
    });
    expect(overlap.removed).toEqual([]);
    expect(overlap.records.map((entry) => entry.item.itemId).sort()).toEqual([
      "item-a",
      "item-b",
      "item-c",
    ]);
  });

  it("rejects detail flags on the legacy read before it touches the thread", async () => {
    let reads = 0;
    const session = {
      getThread: async () => {
        reads += 1;
        return {};
      },
    };
    await expect(
      VERBS.read(session, { verb: "read", thread: "thread-1", after: "0" }),
    ).rejects.toThrow(/--after needs --detail/);
    await expect(
      VERBS.read(session, { verb: "read", thread: "thread-1", detail: true, offset: "1" }),
    ).rejects.toThrow(/--offset needs --item/);
    await expect(
      VERBS.read(session, { verb: "read", thread: "thread-1", detail: true, after: "-1" }),
    ).rejects.toThrow(/--after must be an integer >= 0/);
    await expect(
      VERBS.read(session, { verb: "read", thread: "thread-1", detail: true, view: "files" }),
    ).rejects.toThrow(/--view must be messages or activity/);
    expect(reads).toBe(0);
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

function openHarness(baseDir: string, providers: ReadonlyArray<unknown>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const session = {
    baseDir,
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
  title: "detail read pilot",
  task: "Reply with the single word pong.",
  why: "require effort high",
  account: "Claude",
  "no-start": true,
};

describe("open effort", () => {
  it("sends effort high by default when v0.1.7 lists it in values", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ values: ["low", "medium", "high", false] }),
    );
    const out = await VERBS.open(session, { ...openArgs });
    const launch = calls.find((call) => call.tool === "t3_thread_launch");
    expect(launch?.args["modelSelection"]).toMatchObject({
      instanceId: "own-account",
      model: "opus",
      options: [{ id: "effort", value: "high" }],
    });
    expect(out.effort).toBe("high");
  });

  it("sends an explicit high and still accepts the older options shape", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ options: [{ id: "low" }, { id: "high" }] }),
    );
    await VERBS.open(session, { ...openArgs, effort: "high" });
    const launch = calls.find((call) => call.tool === "t3_thread_launch");
    expect(launch?.args["modelSelection"]).toMatchObject({
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("rejects an effort the model does not list and does not launch", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ values: ["low", "medium"] }),
    );
    await expect(VERBS.open(session, { ...openArgs, effort: "high" })).rejects.toThrow(/opus/);
    expect(calls.some((call) => call.tool === "t3_thread_launch")).toBe(false);
  });

  it("refuses the default open when high cannot be applied", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ values: ["low", "medium"] }),
    );
    await expect(VERBS.open(session, { ...openArgs })).rejects.toThrow(ChairRefusal);
    await expect(VERBS.open(session, { ...openArgs })).rejects.toThrow(/requires effort 'high'/);
    expect(calls.some((call) => call.tool === "t3_thread_launch")).toBe(false);
  });

  it("refuses an instance outside the fence before launch", async () => {
    const { session, calls } = openHarness(
      await freshBaseDir(),
      capabilityProviders({ values: ["high"] }),
    );
    await expect(
      VERBS.open(session, {
        ...openArgs,
        account: undefined,
        instance: "client-account",
        model: "opus",
      }),
    ).rejects.toThrow(ChairRefusal);
    expect(calls).toEqual([]);
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
    const writes = calls.filter(
      (call) => call.tool === "t3_thread_configure" && call.args["modelSelection"] !== undefined,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args["modelSelection"]).toMatchObject({
      instanceId: "own-account",
      model: "opus",
      options: [{ id: "effort", value: "high" }],
    });
    expect(calls.some((call) => call.tool === "t3_thread_configuration")).toBe(false);
    expect(calls.some((call) => call.tool === "t3_thread_send")).toBe(true);
  });
});
