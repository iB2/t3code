import { describe, expect, it } from "vite-plus/test";

import {
  TimelineReadError,
  collectBoundedReads,
  legacyTimelineMessages,
  readDetailItem,
  reconcileTimeline,
  threadReadArgs,
  type ChairDetailItem,
  type TimelineRecord,
} from "./threadRead.ts";

const ENDPOINT = "http://127.0.0.1:9/mcp";
const THREAD = "thread-1";

function item(over: Partial<ChairDetailItem> = {}): ChairDetailItem {
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: THREAD,
    itemId: "item-a",
    runId: "run-1",
    messageId: "msg-a",
    createdBy: "user",
    creationSource: "web",
    type: "user_message",
    status: "completed",
    title: null,
    text: "alpha",
    textTruncated: false,
    nextTextOffset: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

function record(entry: ChairDetailItem, threadId = THREAD, endpoint = ENDPOINT): TimelineRecord {
  return { endpoint, threadId, item: entry };
}

describe("legacyTimelineMessages", () => {
  it("keeps role, time, and text, and marks a cut item in the text", () => {
    expect(
      legacyTimelineMessages([
        {
          type: "user_message",
          status: "completed",
          text: "hello",
          updatedAt: "2026-11-01T00:00:00.000Z",
          itemId: "item-a",
          sourceThreadId: THREAD,
        },
        {
          type: "assistant_message",
          status: "completed",
          text: "world",
          textTruncated: true,
          updatedAt: "2026-11-01T00:01:00.000Z",
        },
        { type: "proposed_plan", status: "completed", text: "plan", updatedAt: "t" },
        { type: "assistant_message", status: "running", text: "still going", updatedAt: "t" },
        { type: "user_message", status: "completed", text: "   ", updatedAt: "t" },
        { type: "tool", status: "completed", text: "ran", updatedAt: "t", runId: "run-other" },
      ]),
    ).toEqual([
      { role: "user", at: "2026-11-01T00:00:00.000Z", text: "hello" },
      { role: "assistant", at: "2026-11-01T00:01:00.000Z", text: "world… [truncated]" },
      { role: "plan", at: "t", text: "plan" },
      { role: "tool", at: "t", text: "ran" },
    ]);
  });

  it("keeps only the requested run", () => {
    expect(
      legacyTimelineMessages(
        [
          {
            type: "assistant_message",
            status: "completed",
            text: "a",
            runId: "run-1",
            updatedAt: "t",
          },
          {
            type: "assistant_message",
            status: "completed",
            text: "b",
            runId: "run-2",
            updatedAt: "t",
          },
        ],
        "run-2",
      ),
    ).toEqual([{ role: "assistant", at: "t", text: "b" }]);
  });
});

describe("readDetailItem", () => {
  it("keeps identity, origin, status, and continuation fields", () => {
    expect(
      readDetailItem({
        position: 4,
        visibility: "inherited",
        sourceThreadId: "source-thread",
        itemId: "item-9",
        subagentId: "sub-1",
        runId: "run-9",
        messageId: "msg-9",
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: "parent-thread",
        type: "assistant_message",
        status: "completed",
        title: "note",
        text: "kept",
        textTruncated: true,
        nextTextOffset: 12,
        updatedAt: "2026-11-02T00:00:00.000Z",
        extra: "drop me",
      }),
    ).toEqual({
      position: 4,
      visibility: "inherited",
      sourceThreadId: "source-thread",
      itemId: "item-9",
      subagentId: "sub-1",
      runId: "run-9",
      messageId: "msg-9",
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: "parent-thread",
      type: "assistant_message",
      status: "completed",
      title: "note",
      text: "kept",
      textTruncated: true,
      nextTextOffset: 12,
      updatedAt: "2026-11-02T00:00:00.000Z",
    });
  });
});

describe("threadReadArgs", () => {
  it("omits afterPosition on the first page and sends 0 when the caller asks for it", () => {
    expect(
      threadReadArgs({ threadId: THREAD, view: "messages", limit: 6, maxCharsPerItem: 40 }),
    ).toEqual({
      threadId: THREAD,
      view: "messages",
      limit: 6,
      maxCharsPerItem: 40,
    });
    expect(
      threadReadArgs({
        threadId: THREAD,
        view: "activity",
        limit: 6,
        maxCharsPerItem: 40,
        afterPosition: 0,
      }).afterPosition,
    ).toBe(0);
  });

  it("sends textOffset only together with itemId", () => {
    expect(
      threadReadArgs({
        threadId: THREAD,
        view: "messages",
        limit: 1,
        maxCharsPerItem: 4,
        textOffset: 4,
      }),
    ).not.toHaveProperty("textOffset");
    expect(
      threadReadArgs({
        threadId: THREAD,
        view: "messages",
        limit: 1,
        maxCharsPerItem: 4,
        itemId: "item-9",
        textOffset: 4,
      }),
    ).toMatchObject({ itemId: "item-9", textOffset: 4 });
  });
});

describe("reconcileTimeline", () => {
  it("updates and inserts on a page, and does not remove an item the page left out", () => {
    const kept = item({ itemId: "item-a", text: "alpha" });
    const edited = item({
      itemId: "item-b",
      messageId: "msg-b",
      text: "beta",
      position: 1,
      updatedAt: "2026-11-01T00:02:00.000Z",
    });
    const previous = [
      record(kept),
      record(edited),
      record(item({ itemId: "item-a", text: "other endpoint" }), THREAD, "http://other/mcp"),
    ];
    const nextB = item({
      ...edited,
      text: "beta edited",
      position: 7,
      updatedAt: "2026-11-03T00:00:00.000Z",
    });
    const inserted = item({
      itemId: "item-c",
      messageId: "msg-c",
      text: "gamma",
      position: 2,
      createdBy: "agent",
    });
    const out = reconcileTimeline({
      previous,
      endpoint: ENDPOINT,
      threadId: THREAD,
      items: [nextB, inserted],
      hasMore: true,
      mode: "page",
    });

    expect(out.removed).toEqual([]);
    expect(
      out.records.map((entry) => [
        entry.endpoint,
        entry.item.itemId,
        entry.item.text,
        entry.item.position,
      ]),
    ).toEqual([
      [ENDPOINT, "item-a", "alpha", 0],
      [ENDPOINT, "item-b", "beta edited", 7],
      ["http://other/mcp", "item-a", "other endpoint", 0],
      [ENDPOINT, "item-c", "gamma", 2],
    ]);
    expect(out.records.filter((entry) => entry.item.itemId === "item-b")).toHaveLength(1);
  });

  it("removes only on a full reread of the same thread and endpoint", () => {
    const otherThread = record(item({ itemId: "item-a", text: "sibling" }), "thread-2");
    const previous = [
      record(item({ itemId: "item-a", text: "alpha" })),
      record(item({ itemId: "item-b", text: "beta", messageId: "msg-b" })),
      otherThread,
    ];
    const out = reconcileTimeline({
      previous,
      endpoint: ENDPOINT,
      threadId: THREAD,
      items: [item({ itemId: "item-b", text: "beta", messageId: "msg-b", position: 0 })],
      hasMore: false,
      mode: "snapshot",
    });

    expect(out.removed.map((entry) => entry.item.itemId)).toEqual(["item-a"]);
    expect(out.records.map((entry) => [entry.threadId, entry.item.itemId])).toEqual([
      [THREAD, "item-b"],
      ["thread-2", "item-a"],
    ]);
  });

  it("refuses to treat a short page as a full reread", () => {
    const previous = [record(item())];
    expect(() =>
      reconcileTimeline({
        previous,
        endpoint: ENDPOINT,
        threadId: THREAD,
        items: [],
        hasMore: true,
        mode: "snapshot",
      }),
    ).toThrow(TimelineReadError);
    expect(previous).toHaveLength(1);
  });

  it("reports an item with no identity instead of merging it", () => {
    const out = reconcileTimeline({
      previous: [],
      endpoint: ENDPOINT,
      threadId: THREAD,
      items: [item({ sourceThreadId: null, itemId: null, text: "loose" })],
      hasMore: false,
      mode: "snapshot",
    });
    expect(out.records).toEqual([]);
    expect(out.unkeyed.map((entry) => entry.text)).toEqual(["loose"]);
  });

  it("does not promise that a gapped reread still holds every server item", () => {
    const previous = [
      record(item({ itemId: "item-a" })),
      record(item({ itemId: "item-b", messageId: "msg-b" })),
    ];
    const out = reconcileTimeline({
      previous,
      endpoint: ENDPOINT,
      threadId: THREAD,
      items: [item({ itemId: "item-b", messageId: "msg-b", text: "only the page that arrived" })],
      hasMore: false,
      mode: "snapshot",
    });
    expect(out.removed.map((entry) => entry.item.itemId)).toEqual(["item-a"]);
  });
});

describe("collectBoundedReads", () => {
  it("omits afterPosition on the first page and stops at the cap", async () => {
    const seen: Array<number | undefined> = [];
    const out = await collectBoundedReads({
      maxPages: 2,
      readPage: async (afterPosition) => {
        seen.push(afterPosition);
        const start = afterPosition === undefined ? 0 : afterPosition + 1;
        return { items: [start], nextPosition: start, hasMore: true };
      },
    });
    expect(seen).toEqual([undefined, 0]);
    expect(out).toEqual({ pages: 2, items: [0, 1], hasMore: true, capped: true });
  });

  it("stops when the page hint does not advance", async () => {
    let calls = 0;
    const out = await collectBoundedReads({
      maxPages: 5,
      readPage: async () => {
        calls += 1;
        return { items: ["x"], nextPosition: 3, hasMore: true };
      },
    });
    expect(calls).toBe(2);
    expect(out.pages).toBe(2);
    expect(out.capped).toBe(false);
    expect(out.hasMore).toBe(true);
  });

  it("reads every remaining page under the cap and does not keep going", async () => {
    let calls = 0;
    const out = await collectBoundedReads({
      maxPages: 5,
      readPage: async (afterPosition) => {
        calls += 1;
        const last = afterPosition === 1;
        return { items: [calls], nextPosition: calls - 1, hasMore: !last };
      },
    });
    expect(calls).toBe(3);
    expect(out).toMatchObject({ pages: 3, hasMore: false, capped: false, items: [1, 2, 3] });
  });

  it("rejects an unbounded read", async () => {
    await expect(
      collectBoundedReads({
        maxPages: 0,
        readPage: async () => ({ items: [], nextPosition: null, hasMore: false }),
      }),
    ).rejects.toThrow(TimelineReadError);
  });
});
