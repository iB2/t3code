/**
 * Opt-in timeline read for the chair.
 *
 * T3 rebuilds `position` for each response, so `afterPosition` only asks for
 * the next page of that response. The identity of an item is the endpoint,
 * the thread that was read, the source thread, and the item id. The read
 * thread stays in the key so a reread of one thread cannot delete another
 * thread's copy of an inherited item.
 *
 * @module megazord/threadRead
 */

export type TimelineView = "messages" | "activity";

/** One server timeline item, with the fields a later reread has to match. */
export interface ChairDetailItem {
  readonly position: number | null;
  readonly visibility: string | null;
  readonly sourceThreadId: string | null;
  readonly itemId: string | null;
  readonly subagentId?: string;
  readonly runId: string | null;
  readonly messageId: string | null;
  readonly createdBy: string | null;
  readonly creationSource: string | null;
  readonly senderThreadId?: string;
  readonly type: string | null;
  readonly status: string | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly textTruncated: boolean;
  readonly nextTextOffset: number | null;
  readonly updatedAt: string | null;
}

/** An item remembered from one read of one thread on one endpoint. */
export interface TimelineRecord {
  readonly endpoint: string;
  readonly threadId: string;
  readonly item: ChairDetailItem;
}

const ROLE: Readonly<Record<string, string>> = {
  user_message: "user",
  assistant_message: "assistant",
  proposed_plan: "plan",
};

function row(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Copy the identity and continuation fields off one raw MCP item. */
export function readDetailItem(raw: unknown): ChairDetailItem {
  const item = row(raw) ?? {};
  const subagentId = str(item["subagentId"]);
  const senderThreadId = str(item["senderThreadId"]);
  return {
    position: num(item["position"]),
    visibility: str(item["visibility"]),
    sourceThreadId: str(item["sourceThreadId"]),
    itemId: str(item["itemId"]),
    ...(subagentId === null ? {} : { subagentId }),
    runId: str(item["runId"]),
    messageId: str(item["messageId"]),
    createdBy: str(item["createdBy"]),
    creationSource: str(item["creationSource"]),
    ...(senderThreadId === null ? {} : { senderThreadId }),
    type: str(item["type"]),
    status: str(item["status"]),
    title: str(item["title"]),
    text: str(item["text"]),
    textTruncated: item["textTruncated"] === true,
    nextTextOffset: num(item["nextTextOffset"]),
    updatedAt: str(item["updatedAt"]),
  };
}

export function hasTimelineIdentity(
  item: ChairDetailItem,
): item is ChairDetailItem & { readonly sourceThreadId: string; readonly itemId: string } {
  return (
    item.sourceThreadId !== null &&
    item.sourceThreadId !== "" &&
    item.itemId !== null &&
    item.itemId !== ""
  );
}

export interface LegacyMessage {
  readonly role: unknown;
  readonly at: unknown;
  readonly text: unknown;
}

/**
 * The read the chair has always printed: role, time, and text. A running item
 * and a blank item are left out. A cut item keeps the cut mark in the text.
 */
export function legacyTimelineMessages(
  items: ReadonlyArray<unknown>,
  runId?: string,
): ReadonlyArray<LegacyMessage> {
  const out: LegacyMessage[] = [];
  for (const raw of items) {
    const item = row(raw);
    if (item === undefined) continue;
    if (runId !== undefined && item["runId"] !== runId) continue;
    if (item["status"] === "running" || String(item["text"] ?? "").trim() === "") continue;
    const type = item["type"];
    out.push({
      role: typeof type === "string" ? (ROLE[type] ?? type) : type,
      at: item["updatedAt"],
      text: item["textTruncated"] ? `${item["text"]}… [truncated]` : item["text"],
    });
  }
  return out;
}

export interface ThreadReadPageRequest {
  readonly threadId: string;
  readonly view: TimelineView;
  readonly limit: number;
  readonly maxCharsPerItem: number;
  readonly afterPosition?: number;
  readonly itemId?: string;
  readonly textOffset?: number;
}

export interface ThreadReadArgs {
  readonly threadId: string;
  readonly view: TimelineView;
  readonly limit: number;
  readonly maxCharsPerItem: number;
  readonly afterPosition?: number;
  readonly itemId?: string;
  readonly textOffset?: number;
}

/**
 * Arguments for `t3_thread_read`.
 *
 * Omit `afterPosition` on the first page. `0` means "after the item at
 * index 0", not "start". `textOffset` is sent only with `itemId`, which is
 * how the server applies it.
 */
export function threadReadArgs(request: ThreadReadPageRequest): ThreadReadArgs {
  return {
    threadId: request.threadId,
    view: request.view,
    limit: request.limit,
    maxCharsPerItem: request.maxCharsPerItem,
    ...(request.afterPosition === undefined ? {} : { afterPosition: request.afterPosition }),
    ...(request.itemId === undefined ? {} : { itemId: request.itemId }),
    ...(request.itemId === undefined || request.textOffset === undefined
      ? {}
      : { textOffset: request.textOffset }),
  };
}

export function timelineKey(input: {
  readonly endpoint: string;
  readonly threadId: string;
  readonly sourceThreadId: string;
  readonly itemId: string;
}): string {
  return JSON.stringify([input.endpoint, input.threadId, input.sourceThreadId, input.itemId]);
}

export class TimelineReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineReadError";
  }
}

export interface ReconcileOutcome {
  readonly records: ReadonlyArray<TimelineRecord>;
  readonly upserted: ReadonlyArray<TimelineRecord>;
  readonly removed: ReadonlyArray<TimelineRecord>;
  readonly unkeyed: ReadonlyArray<ChairDetailItem>;
}

function recordKey(record: TimelineRecord): string | undefined {
  if (!hasTimelineIdentity(record.item)) return undefined;
  return timelineKey({
    endpoint: record.endpoint,
    threadId: record.threadId,
    sourceThreadId: record.item.sourceThreadId,
    itemId: record.item.itemId,
  });
}

/**
 * Merge one read into the records already kept.
 *
 * `page` updates and inserts. It does not remove, because a short page is not
 * evidence that an unseen item is gone. `snapshot` is a full reread of one
 * thread (`hasMore` false) and replaces that thread's records. There is no
 * promise that the pages were a consistent server snapshot: an item skipped
 * because the timeline moved is reported removed.
 */
export function reconcileTimeline(input: {
  readonly previous: ReadonlyArray<TimelineRecord>;
  readonly endpoint: string;
  readonly threadId: string;
  readonly items: ReadonlyArray<ChairDetailItem>;
  readonly hasMore: boolean;
  readonly mode: "page" | "snapshot";
}): ReconcileOutcome {
  if (input.mode === "snapshot" && input.hasMore) {
    throw new TimelineReadError(
      "refused: a page with hasMore is not a full reread, so it cannot remove items",
    );
  }
  const unkeyed = input.items.filter((item) => !hasTimelineIdentity(item));
  const incoming = new Map<string, TimelineRecord>();
  for (const item of input.items) {
    if (!hasTimelineIdentity(item)) continue;
    const record: TimelineRecord = { endpoint: input.endpoint, threadId: input.threadId, item };
    incoming.set(
      timelineKey({
        endpoint: input.endpoint,
        threadId: input.threadId,
        sourceThreadId: item.sourceThreadId,
        itemId: item.itemId,
      }),
      record,
    );
  }
  const records: TimelineRecord[] = [];
  const removed: TimelineRecord[] = [];
  const seen = new Set<string>();
  for (const record of input.previous) {
    const key = recordKey(record);
    if (key === undefined) {
      records.push(record);
      continue;
    }
    const next = incoming.get(key);
    const inScope = record.endpoint === input.endpoint && record.threadId === input.threadId;
    if (input.mode === "snapshot" && inScope) {
      if (next === undefined) removed.push(record);
      else {
        records.push(next);
        seen.add(key);
      }
      continue;
    }
    if (next !== undefined) {
      records.push(next);
      seen.add(key);
    } else records.push(record);
  }
  const upserted: TimelineRecord[] = [];
  for (const [key, record] of incoming) {
    upserted.push(record);
    if (!seen.has(key)) records.push(record);
  }
  return { records, upserted, removed, unkeyed };
}

export interface BoundedReadPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextPosition: number | null;
  readonly hasMore: boolean;
}

export interface BoundedReadResult<T> {
  readonly pages: number;
  readonly items: ReadonlyArray<T>;
  readonly hasMore: boolean;
  readonly capped: boolean;
}

/**
 * Read at most `maxPages` pages. The first call omits `afterPosition`.
 * This stops at the cap, when the server reports no further page, or when
 * `nextPosition` does not move forward. It does not run a watcher.
 */
export async function collectBoundedReads<T>(input: {
  readonly maxPages: number;
  readonly readPage: (afterPosition: number | undefined) => Promise<BoundedReadPage<T>>;
}): Promise<BoundedReadResult<T>> {
  if (!Number.isInteger(input.maxPages) || input.maxPages < 1) {
    throw new TimelineReadError("maxPages must be a positive integer");
  }
  const items: T[] = [];
  let after: number | undefined;
  for (let pages = 1; pages <= input.maxPages; pages += 1) {
    const page = await input.readPage(after);
    items.push(...page.items);
    if (page.hasMore !== true) return { pages, items, hasMore: false, capped: false };
    if (pages === input.maxPages) return { pages, items, hasMore: true, capped: true };
    if (page.nextPosition === null || (after !== undefined && page.nextPosition <= after)) {
      return { pages, items, hasMore: true, capped: false };
    }
    after = page.nextPosition;
  }
  return { pages: input.maxPages, items, hasMore: true, capped: true };
}
