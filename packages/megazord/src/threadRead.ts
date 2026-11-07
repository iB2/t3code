/**
 * Opt-in timeline read for the chair.
 *
 * T3 rebuilds `position` for each response. `afterPosition` is an index in the
 * whole visible timeline, so a messages page can carry positions 0, 3, 6.
 * It is not a durable cursor.
 *
 * The identity of an item is the endpoint, the thread that was read, the
 * source thread, and the item id. The read thread stays in the key so a reread
 * of one thread cannot delete another thread's copy of an inherited item.
 *
 * `reconcileTimeline` and `collectBoundedReads` are helpers for tests and for
 * a caller that wants to fold pages. The chair command does not call them.
 * `collectBoundedReads` only walks `afterPosition`. It does not stitch text.
 *
 * @module megazord/threadRead
 */

export type TimelineView = "messages" | "activity";

/** Types T3 keeps in a `messages` page. Other timeline rows are activity-only. */
const MESSAGE_TYPES = new Set(["user_message", "assistant_message", "proposed_plan"]);

function inSnapshotScope(view: TimelineView, item: ChairDetailItem): boolean {
  if (view === "activity") return true;
  return item.type !== null && MESSAGE_TYPES.has(item.type);
}

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
 * Omit `afterPosition` on the first page. The value is an index in the whole
 * visible timeline, including rows the messages view leaves out, so the next
 * page may start at 0, 3, or 6. It is not a durable cursor. `textOffset` is
 * sent only with `itemId`, which is how the server applies it. An offset above
 * 0 asks for a text fragment, not a new copy of the whole item.
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

/**
 * A full item read starts at the beginning of the text, even when the server
 * cut it. A fragment starts at `textOffset` and holds only the slice from
 * there. Offsets are JavaScript string indexes, the same ones the server uses.
 */
export type TimelinePiece =
  | { readonly kind: "item"; readonly item: ChairDetailItem }
  | { readonly kind: "fragment"; readonly textOffset: number; readonly item: ChairDetailItem };

/** Turn one detail response into pieces. A fragment is never labeled as a full item. */
export function piecesFromDetail(input: {
  readonly textKind: "item" | "fragment";
  readonly textOffset: number | null;
  readonly items: ReadonlyArray<ChairDetailItem>;
}): ReadonlyArray<TimelinePiece> {
  if (input.textKind === "item") {
    if (input.textOffset !== null && input.textOffset !== 0) {
      throw new TimelineReadError("refused: a full item read cannot start past the beginning");
    }
    return input.items.map((item) => ({ kind: "item", item }));
  }
  if (input.textOffset === null || !Number.isInteger(input.textOffset) || input.textOffset < 0) {
    throw new TimelineReadError("refused: a text fragment needs an integer textOffset >= 0");
  }
  if (input.textOffset === 0) return input.items.map((item) => ({ kind: "item", item }));
  const textOffset = input.textOffset;
  return input.items.map((item) => ({ kind: "fragment", textOffset, item }));
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

function fragmentEnd(piece: Extract<TimelinePiece, { kind: "fragment" }>): number {
  const text = piece.item.text;
  if (text === null) throw new TimelineReadError("refused: a text fragment has no text");
  if (!Number.isInteger(piece.textOffset) || piece.textOffset < 0) {
    throw new TimelineReadError("refused: a text fragment offset must be an integer >= 0");
  }
  const end = piece.textOffset + text.length;
  if (piece.item.textTruncated) {
    if (piece.item.nextTextOffset !== end) {
      throw new TimelineReadError(
        "refused: a truncated fragment's nextTextOffset must equal textOffset plus the fragment length",
      );
    }
  } else if (piece.item.nextTextOffset !== null) {
    throw new TimelineReadError("refused: a finished fragment must leave nextTextOffset empty");
  }
  return end;
}

/**
 * Keep the stored prefix. Append only the slice that begins where the stored
 * text ends, or accept an exact retry of a slice already kept. Anything else
 * is refused and the caller keeps the previous records.
 */
function mergeFragment(
  stored: ChairDetailItem | undefined,
  piece: Extract<TimelinePiece, { kind: "fragment" }>,
): ChairDetailItem {
  const text = piece.item.text;
  if (text === null) throw new TimelineReadError("refused: a text fragment has no text");
  fragmentEnd(piece);
  if (stored === undefined || stored.text === null) {
    if (piece.textOffset !== 0) {
      throw new TimelineReadError("refused: a text fragment arrived before its prefix");
    }
    return piece.item;
  }
  if (stored.updatedAt === null || piece.item.updatedAt === null) {
    throw new TimelineReadError(
      "refused: updatedAt is required to continue a stored timeline item",
    );
  }
  if (stored.updatedAt !== piece.item.updatedAt) {
    throw new TimelineReadError(
      "refused: the item changed during continuation; reread it as a full item",
    );
  }
  const have = stored.text;
  if (piece.textOffset > have.length) {
    throw new TimelineReadError(
      "refused: a text fragment leaves a gap before the text already kept",
    );
  }
  const overlap = have.slice(piece.textOffset, piece.textOffset + text.length);
  if (overlap !== text.slice(0, overlap.length)) {
    throw new TimelineReadError("refused: a text fragment does not match the text already kept");
  }
  const end = piece.textOffset + text.length;
  if (end < have.length) return stored;
  // A duplicate slice that stops at the stored end must not mark a finished
  // item truncated again.
  if (end === have.length && stored.textTruncated === false && piece.item.textTruncated) {
    return stored;
  }
  const assembled = have.slice(0, piece.textOffset) + text;
  return {
    ...stored,
    ...piece.item,
    text: assembled,
    textTruncated: piece.item.textTruncated,
    nextTextOffset: piece.item.nextTextOffset,
  };
}

/**
 * Keep the assembled text and its truncation fields. Copy metadata the new
 * read actually carries, including a moved `position`.
 */
function retainAssembledText(stored: ChairDetailItem, incoming: ChairDetailItem): ChairDetailItem {
  const subagentId = incoming.subagentId ?? stored.subagentId;
  const senderThreadId = incoming.senderThreadId ?? stored.senderThreadId;
  return {
    ...stored,
    position: incoming.position ?? stored.position,
    visibility: incoming.visibility ?? stored.visibility,
    status: incoming.status ?? stored.status,
    title: incoming.title ?? stored.title,
    runId: incoming.runId ?? stored.runId,
    messageId: incoming.messageId ?? stored.messageId,
    createdBy: incoming.createdBy ?? stored.createdBy,
    creationSource: incoming.creationSource ?? stored.creationSource,
    type: incoming.type ?? stored.type,
    ...(subagentId === undefined ? {} : { subagentId }),
    ...(senderThreadId === undefined ? {} : { senderThreadId }),
    text: stored.text,
    textTruncated: stored.textTruncated,
    nextTextOffset: stored.nextTextOffset,
    updatedAt: stored.updatedAt,
  };
}

/**
 * A same-version full item must not replace a longer stored text with a
 * matching truncated prefix. A different `updatedAt` replaces the record.
 * v0.1.7 always sends `updatedAt`. A null timestamp is an invalid payload, so
 * it cannot replace stored text. Same-version text that is not a prefix either
 * way is refused.
 */
function applyFullItem(
  stored: ChairDetailItem | undefined,
  incoming: ChairDetailItem,
): ChairDetailItem {
  if (stored === undefined || stored.text === null) return incoming;
  if (incoming.text === null || stored.updatedAt === null || incoming.updatedAt === null) {
    throw new TimelineReadError(
      "refused: updatedAt and text are required to compare a timeline item with stored text",
    );
  }
  if (stored.updatedAt !== incoming.updatedAt) return incoming;
  if (incoming.text === stored.text) {
    return stored.textTruncated === false && incoming.textTruncated
      ? retainAssembledText(stored, incoming)
      : incoming;
  }
  if (stored.text.startsWith(incoming.text) && incoming.textTruncated) {
    return retainAssembledText(stored, incoming);
  }
  if (incoming.text.startsWith(stored.text)) return incoming;
  throw new TimelineReadError(
    "refused: a full item of the same version contradicts the text already kept",
  );
}

/**
 * Merge one read into the records already kept.
 *
 * The chair command does not call this. A caller passes `pieces`. A full item
 * from another version replaces the stored text. A same-version truncated
 * prefix does not shrink a longer record. A fragment is stitched on only when
 * its offset matches text already kept. A mismatched fragment throws, and
 * `previous` is left untouched.
 *
 * `page` updates and inserts. It does not remove, because a short page is not
 * evidence that an unseen item is gone. `snapshot` is a full reread of one
 * view (`hasMore` false). `messages` removes only user, assistant, and plan
 * items that the reread left out. `activity` removes any item of that thread
 * the reread left out. A fragment cannot remove items. There is no promise
 * that the pages were a consistent server snapshot: an item skipped because
 * the timeline moved is reported removed.
 */
export function reconcileTimeline(
  input: {
    readonly previous: ReadonlyArray<TimelineRecord>;
    readonly endpoint: string;
    readonly threadId: string;
    readonly pieces: ReadonlyArray<TimelinePiece>;
    readonly hasMore: boolean;
  } & ({ readonly mode: "page" } | { readonly mode: "snapshot"; readonly view: TimelineView }),
): ReconcileOutcome {
  if (input.mode === "snapshot" && input.hasMore) {
    throw new TimelineReadError(
      "refused: a page with hasMore is not a full reread, so it cannot remove items",
    );
  }
  if (input.mode === "snapshot" && input.pieces.some((piece) => piece.kind === "fragment")) {
    throw new TimelineReadError("refused: a text fragment cannot remove items; pass it as a page");
  }
  if (
    input.mode === "snapshot" &&
    input.view === "messages" &&
    input.pieces.some(
      (piece) => hasTimelineIdentity(piece.item) && !inSnapshotScope("messages", piece.item),
    )
  ) {
    throw new TimelineReadError(
      "refused: a messages snapshot cannot include an activity-only item",
    );
  }
  const unkeyed: ChairDetailItem[] = [];
  const working: TimelineRecord[] = [...input.previous];
  const seen = new Set<string>();
  const upserted: TimelineRecord[] = [];
  for (const piece of input.pieces) {
    if (!hasTimelineIdentity(piece.item)) {
      if (piece.kind === "fragment") {
        throw new TimelineReadError("refused: a text fragment has no item identity");
      }
      unkeyed.push(piece.item);
      continue;
    }
    const key = timelineKey({
      endpoint: input.endpoint,
      threadId: input.threadId,
      sourceThreadId: piece.item.sourceThreadId,
      itemId: piece.item.itemId,
    });
    const index = working.findIndex((record) => recordKey(record) === key);
    const nextItem =
      piece.kind === "item"
        ? applyFullItem(working[index]?.item, piece.item)
        : mergeFragment(working[index]?.item, piece);
    const record: TimelineRecord = {
      endpoint: input.endpoint,
      threadId: input.threadId,
      item: nextItem,
    };
    if (index >= 0) working[index] = record;
    else working.push(record);
    seen.add(key);
    upserted.push(record);
  }
  if (input.mode === "page") return { records: working, upserted, removed: [], unkeyed };
  const records: TimelineRecord[] = [];
  const removed: TimelineRecord[] = [];
  for (const record of working) {
    const key = recordKey(record);
    const inScope =
      input.mode === "snapshot" &&
      record.endpoint === input.endpoint &&
      record.threadId === input.threadId &&
      inSnapshotScope(input.view, record.item);
    if (inScope && key !== undefined && !seen.has(key)) removed.push(record);
    else records.push(record);
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
 * `nextPosition` does not move forward. The chair command does not call this.
 * The helper does not stitch text fragments.
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
