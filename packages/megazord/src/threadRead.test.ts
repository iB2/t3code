import { describe, expect, it } from "vite-plus/test";

import {
  TimelineReadError,
  collectBoundedReads,
  legacyTimelineMessages,
  piecesFromDetail,
  readDetailItem,
  reconcileTimeline,
  threadReadArgs,
  type ChairDetailItem,
  type TimelinePiece,
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

function full(entry: ChairDetailItem): TimelinePiece {
  return { kind: "item", item: entry };
}

function fragment(entry: ChairDetailItem, textOffset: number): TimelinePiece {
  return { kind: "fragment", textOffset, item: entry };
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
      pieces: [full(nextB), full(inserted)],
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
      pieces: [full(item({ itemId: "item-b", text: "beta", messageId: "msg-b", position: 0 }))],
      hasMore: false,
      mode: "snapshot",
      view: "messages",
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
        pieces: [],
        hasMore: true,
        mode: "snapshot",
        view: "messages",
      }),
    ).toThrow(TimelineReadError);
    expect(previous).toHaveLength(1);
  });

  it("reports an item with no identity instead of merging it", () => {
    const out = reconcileTimeline({
      previous: [],
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [full(item({ sourceThreadId: null, itemId: null, text: "loose" }))],
      hasMore: false,
      mode: "snapshot",
      view: "messages",
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
      pieces: [
        full(
          item({
            itemId: "item-b",
            messageId: "msg-b",
            text: "only the page that arrived",
            updatedAt: "2026-11-06T00:00:00.000Z",
          }),
        ),
      ],
      hasMore: false,
      mode: "snapshot",
      view: "messages",
    });
    expect(out.removed.map((entry) => entry.item.itemId)).toEqual(["item-a"]);
  });

  it("stitches a continuation onto the prefix and ignores an exact retry", () => {
    const head = item({
      text: "abcd",
      textTruncated: true,
      nextTextOffset: 4,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const opened = reconcileTimeline({
      previous: [],
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [full(head)],
      hasMore: false,
      mode: "page",
    });
    const cont = item({
      text: "efgh",
      textTruncated: true,
      nextTextOffset: 8,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const once = reconcileTimeline({
      previous: opened.records,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [fragment(cont, 4)],
      hasMore: true,
      mode: "page",
    });
    const twice = reconcileTimeline({
      previous: once.records,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [fragment(cont, 4)],
      hasMore: true,
      mode: "page",
    });
    const done = reconcileTimeline({
      previous: twice.records,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [
        fragment(
          item({
            text: "ij",
            textTruncated: false,
            nextTextOffset: null,
            updatedAt: "2026-11-01T00:00:00.000Z",
          }),
          8,
        ),
      ],
      hasMore: false,
      mode: "page",
    });

    expect(once.records[0]?.item.text).toBe("abcdefgh");
    expect(once.records[0]?.item.textTruncated).toBe(true);
    expect(once.records[0]?.item.nextTextOffset).toBe(8);
    expect(twice.records[0]?.item.text).toBe("abcdefgh");
    expect(done.records[0]?.item).toMatchObject({
      text: "abcdefghij",
      textTruncated: false,
      nextTextOffset: null,
    });
  });

  it("refuses a gap, a mismatched slice, and a continuation after the item changes", () => {
    const previous = [
      record(
        item({
          text: "hello",
          textTruncated: true,
          nextTextOffset: 5,
          updatedAt: "2026-11-01T00:00:00.000Z",
        }),
      ),
    ];
    const refuse = (piece: TimelinePiece) =>
      reconcileTimeline({
        previous,
        endpoint: ENDPOINT,
        threadId: THREAD,
        pieces: [piece],
        hasMore: true,
        mode: "page",
      });

    expect(() =>
      refuse(
        fragment(
          item({
            text: "!",
            textTruncated: false,
            nextTextOffset: null,
            updatedAt: "2026-11-01T00:00:00.000Z",
          }),
          7,
        ),
      ),
    ).toThrow(/gap/);
    expect(() =>
      refuse(
        fragment(
          item({
            text: "X",
            textTruncated: false,
            nextTextOffset: null,
            updatedAt: "2026-11-01T00:00:00.000Z",
          }),
          4,
        ),
      ),
    ).toThrow(/does not match/);
    expect(() =>
      refuse(
        fragment(
          item({
            text: "!",
            textTruncated: false,
            nextTextOffset: null,
            updatedAt: "2026-11-04T00:00:00.000Z",
          }),
          5,
        ),
      ),
    ).toThrow(/changed during continuation/);
    expect(() =>
      refuse(
        fragment(
          item({
            text: "!",
            textTruncated: true,
            nextTextOffset: 9,
            updatedAt: "2026-11-01T00:00:00.000Z",
          }),
          5,
        ),
      ),
    ).toThrow(/nextTextOffset/);
    expect(previous[0]?.item.text).toBe("hello");
  });

  it("keeps a longer same-version record when a full read is only its truncated prefix", () => {
    const assembled = `${"a".repeat(200)}b`.padEnd(4391, "c");
    const previous = [
      record(
        item({
          text: assembled,
          textTruncated: false,
          nextTextOffset: null,
          updatedAt: "2026-11-01T00:00:00.000Z",
        }),
      ),
    ];
    const out = reconcileTimeline({
      previous,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [
        full(
          item({
            text: assembled.slice(0, 200),
            textTruncated: true,
            nextTextOffset: 200,
            updatedAt: "2026-11-01T00:00:00.000Z",
          }),
        ),
      ],
      hasMore: true,
      mode: "page",
    });
    expect(out.records[0]?.item.text).toBe(assembled);
    expect(out.records[0]?.item.textTruncated).toBe(false);
    expect(previous[0]?.item.text).toBe(assembled);
  });

  it("replaces the record when the full item is a different version", () => {
    const previous = [
      record(
        item({
          text: "abcdefghij",
          textTruncated: false,
          nextTextOffset: null,
          updatedAt: "2026-11-01T00:00:00.000Z",
        }),
      ),
    ];
    const out = reconcileTimeline({
      previous,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [
        full(
          item({
            text: "zz",
            textTruncated: true,
            nextTextOffset: 2,
            updatedAt: "2026-11-05T00:00:00.000Z",
          }),
        ),
      ],
      hasMore: true,
      mode: "page",
    });
    expect(out.records[0]?.item.text).toBe("zz");
  });

  it("refuses a fragment whose overlap contradicts the stored text", () => {
    const previous = [
      record(
        item({
          text: "prefix-KEEP-suffix",
          textTruncated: false,
          nextTextOffset: null,
          updatedAt: "2026-11-01T00:00:00.000Z",
        }),
      ),
    ];
    expect(() =>
      reconcileTimeline({
        previous,
        endpoint: ENDPOINT,
        threadId: THREAD,
        pieces: [
          fragment(
            item({
              text: "XXXX",
              textTruncated: false,
              nextTextOffset: null,
              updatedAt: "2026-11-01T00:00:00.000Z",
            }),
            "prefix-".length,
          ),
        ],
        hasMore: true,
        mode: "page",
      }),
    ).toThrow(/does not match/);
    expect(previous[0]?.item.text).toBe("prefix-KEEP-suffix");
  });

  it("still replaces the stored text when a later read is a full item", () => {
    const previous = [
      record(item({ text: "abcdefghij", textTruncated: false, nextTextOffset: null })),
    ];
    const out = reconcileTimeline({
      previous,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [full(item({ text: "beta edited", updatedAt: "2026-11-03T00:00:00.000Z" }))],
      hasMore: true,
      mode: "page",
    });
    expect(out.records[0]?.item.text).toBe("beta edited");
    expect(out.records).toHaveLength(1);
  });

  it("labels a detail continuation as a fragment before stitching it", () => {
    const head = piecesFromDetail({
      textKind: "item",
      textOffset: null,
      items: [item({ text: "abcd", textTruncated: true, nextTextOffset: 4 })],
    });
    const tail = piecesFromDetail({
      textKind: "fragment",
      textOffset: 4,
      items: [item({ text: "efghij", textTruncated: false, nextTextOffset: null })],
    });
    expect(head[0]?.kind).toBe("item");
    expect(tail[0]?.kind).toBe("fragment");
    const opened = reconcileTimeline({
      previous: [],
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: head,
      hasMore: false,
      mode: "page",
    });
    const merged = reconcileTimeline({
      previous: opened.records,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: tail,
      hasMore: false,
      mode: "page",
    });
    expect(merged.records[0]?.item.text).toBe("abcdefghij");
    expect(merged.records[0]?.item.text).not.toBe("efghij");
  });

  it("keeps activity items when a messages snapshot is complete", () => {
    const message = item({
      itemId: "item-msg",
      type: "user_message",
      text: "hello",
      position: 0,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const tool = item({
      itemId: "item-tool",
      type: "tool",
      text: "ran",
      messageId: null,
      position: 1,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const assistant = item({
      itemId: "item-assistant",
      type: "assistant_message",
      text: "done",
      position: 3,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const stored = reconcileTimeline({
      previous: [],
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [full(message), full(tool), full(assistant)],
      hasMore: true,
      mode: "page",
    });
    const out = reconcileTimeline({
      previous: stored.records,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [full({ ...message, position: 6 })],
      hasMore: false,
      mode: "snapshot",
      view: "messages",
    });
    expect(out.removed.map((entry) => entry.item.itemId)).toEqual(["item-assistant"]);
    expect(out.records.map((entry) => entry.item.itemId)).toEqual(["item-msg", "item-tool"]);
    expect(out.records.find((entry) => entry.item.itemId === "item-msg")?.item.position).toBe(6);
    expect(out.records.find((entry) => entry.item.itemId === "item-tool")?.item.text).toBe("ran");

    const activity = reconcileTimeline({
      previous: out.records,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [full({ ...message, position: 6 })],
      hasMore: false,
      mode: "snapshot",
      view: "activity",
    });
    expect(activity.removed.map((entry) => entry.item.itemId)).toEqual(["item-tool"]);
    expect(() =>
      reconcileTimeline({
        previous: stored.records,
        endpoint: ENDPOINT,
        threadId: THREAD,
        pieces: [full(message), full(tool)],
        hasMore: false,
        mode: "snapshot",
        view: "messages",
      }),
    ).toThrow(/activity-only/);
  });

  it("does not mark a finished item truncated when a duplicate fragment is retried", () => {
    const updatedAt = "2026-11-01T00:00:00.000Z";
    const opened = reconcileTimeline({
      previous: [],
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [
        full(
          item({
            text: "abcdefghij",
            textTruncated: false,
            nextTextOffset: null,
            updatedAt,
          }),
        ),
      ],
      hasMore: false,
      mode: "page",
    });
    const out = reconcileTimeline({
      previous: opened.records,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [
        fragment(
          item({
            text: "ghij",
            textTruncated: true,
            nextTextOffset: 10,
            updatedAt,
          }),
          6,
        ),
      ],
      hasMore: true,
      mode: "page",
    });
    expect(out.records[0]?.item.text).toBe("abcdefghij");
    expect(out.records[0]?.item.textTruncated).toBe(false);
    expect(out.records[0]?.item.nextTextOffset).toBeNull();
  });

  it("moves position on a same-version truncated prefix without shrinking the text", () => {
    const updatedAt = "2026-11-01T00:00:00.000Z";
    const assembled = `${"a".repeat(200)}tail`;
    const previous = [
      record(
        item({
          text: assembled,
          textTruncated: false,
          nextTextOffset: null,
          position: 1,
          status: "running",
          updatedAt,
        }),
      ),
    ];
    const out = reconcileTimeline({
      previous,
      endpoint: ENDPOINT,
      threadId: THREAD,
      pieces: [
        full(
          item({
            text: assembled.slice(0, 200),
            textTruncated: true,
            nextTextOffset: 200,
            position: 8,
            status: "completed",
            updatedAt,
          }),
        ),
      ],
      hasMore: true,
      mode: "page",
    });
    expect(out.records[0]?.item.text).toBe(assembled);
    expect(out.records[0]?.item.textTruncated).toBe(false);
    expect(out.records[0]?.item.position).toBe(8);
    expect(out.records[0]?.item.status).toBe("completed");
  });

  it("refuses a missing updatedAt instead of replacing stored text", () => {
    const previous = [
      record(item({ text: "abcdefghij", textTruncated: false, nextTextOffset: null })),
    ];
    expect(() =>
      reconcileTimeline({
        previous,
        endpoint: ENDPOINT,
        threadId: THREAD,
        pieces: [
          full(
            item({
              text: "ab",
              textTruncated: true,
              nextTextOffset: 2,
              updatedAt: null,
            }),
          ),
        ],
        hasMore: true,
        mode: "page",
      }),
    ).toThrow(/updatedAt and text are required/);
    expect(previous[0]?.item.text).toBe("abcdefghij");
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
