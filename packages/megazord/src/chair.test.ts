import { describe, expect, it } from "vite-plus/test";

import {
  ChairRefusal,
  assertInstanceAllowed,
  classifyMcpThread,
  classifyThread,
  parsePolicy,
  pendingApprovals,
  projectVisible,
  settleRefusal,
  threadVisible,
} from "./chair.ts";

const POLICY = parsePolicy({
  blockedProjectIds: ["client-project"],
  blockedInstanceIds: ["client-account"],
});

const thread = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  projectId: "own-project",
  modelSelection: { instanceId: "own-account", model: "m" },
  deletedAt: null,
  settledAt: null,
  ...over,
});

describe("parsePolicy", () => {
  it("refuses a policy that leaves a list out, so a typo cannot open the fence", () => {
    expect(() => parsePolicy({ blockedProjectIds: [] })).toThrow(ChairRefusal);
    expect(() => parsePolicy({ blockedProjectIds: [], blockedInstanceIds: "x" })).toThrow(
      ChairRefusal,
    );
    expect(() => parsePolicy(null)).toThrow(ChairRefusal);
  });

  it("gives another machine no access until the policy names it, and never reuses this machine's lists", () => {
    const raw = {
      blockedProjectIds: ["client-project"],
      blockedInstanceIds: ["client-account"],
      environments: { mac: { blockedProjectIds: [], blockedInstanceIds: ["mac-client-account"] } },
    };
    expect(() => parsePolicy(raw, "phone")).toThrow(ChairRefusal);
    expect(() => parsePolicy({ ...raw, environments: { mac: {} } }, "mac")).toThrow(ChairRefusal);
    const mac = parsePolicy(raw, "mac");
    expect(mac.blockedInstanceIds).toEqual(["mac-client-account"]);
    expect(parsePolicy(raw).blockedInstanceIds).toEqual(["client-account"]);
  });
});

describe("the fence", () => {
  it("hides a blocked project and every thread in it, whatever account ran it", () => {
    expect(projectVisible(POLICY, { id: "client-project", deletedAt: null })).toBe(false);
    expect(threadVisible(POLICY, thread({ projectId: "client-project" }))).toBe(false);
  });

  it("hides a thread on a blocked account even inside an allowed project", () => {
    const onClientAccount = thread({
      modelSelection: { instanceId: "client-account", model: "m" },
    });
    expect(threadVisible(POLICY, onClientAccount)).toBe(false);
    expect(() => assertInstanceAllowed(POLICY, "client-account")).toThrow(ChairRefusal);
  });

  it("hides a thread whose account cannot be read: unknown is not allowed", () => {
    expect(threadVisible(POLICY, thread({ modelSelection: null }))).toBe(false);
  });

  it("shows an own thread and hides it once deleted", () => {
    expect(threadVisible(POLICY, thread())).toBe(true);
    expect(threadVisible(POLICY, thread({ deletedAt: "2026-01-01T00:00:00Z" }))).toBe(false);
  });
});

describe("classifyThread", () => {
  const running = thread({
    latestTurn: { turnId: "turn-1", state: "running" },
    session: { status: "running" },
  });

  it("reports the open question of a running turn, and stops once it is answered", () => {
    const asked = {
      kind: "user-input.requested",
      turnId: "turn-1",
      payload: { requestId: "r1", questions: [{ id: "q", question: "Which?", options: [] }] },
    };
    const state = classifyThread(running, [asked]);
    expect(state.status).toBe("question");
    expect(state.pendingInput?.requestId).toBe("r1");

    const answered = {
      kind: "user-input.resolved",
      turnId: "turn-1",
      payload: { requestId: "r1" },
    };
    expect(classifyThread(running, [asked, answered]).status).toBe("running");
  });

  it("reports only the approvals nobody resolved", () => {
    const acts = [
      { kind: "approval.requested", turnId: "turn-1", payload: { requestId: "a1" } },
      { kind: "approval.requested", turnId: "turn-1", payload: { requestId: "a2" } },
      { kind: "approval.resolved", turnId: "turn-1", payload: { requestId: "a1" } },
    ];
    expect(pendingApprovals(acts, "turn-1").map((a) => a.requestId)).toEqual(["a2"]);
    expect(classifyThread(running, acts).status).toBe("approval");
  });

  it("separates a finished turn waiting for a next step from a settled thread", () => {
    const finished = thread({
      latestTurn: { turnId: "turn-1", state: "completed" },
      session: { status: "stopped" },
    });
    expect(classifyThread(finished, []).status).toBe("idle");
    expect(classifyThread({ ...finished, settledAt: "2026-01-01T00:00:00Z" }, []).status).toBe(
      "done",
    );
  });

  it("reports a failed turn as an error and a thread that never ran as empty", () => {
    const failed = thread({ latestTurn: { turnId: "turn-1", state: "error" } });
    expect(classifyThread(failed, []).status).toBe("error");
    expect(classifyThread(thread(), []).status).toBe("empty");
  });
});

describe("classifyMcpThread", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    threadId: "t1",
    status: "idle",
    latestRunId: "run-1",
    itemCount: 4,
    settled: false,
    ...over,
  });

  it("finds a run blocked on a person although T3 still reports it running", () => {
    const blocked = row({ status: "running", pendingRequestCount: 1 });
    const question = { requestId: "r1", questions: [] };
    const asked = classifyMcpThread(blocked, question);
    expect(asked.status).toBe("question");
    expect(asked.pendingInput?.requestId).toBe("r1");
    expect(classifyMcpThread(blocked).status).toBe("approval");
    expect(classifyMcpThread(row({ status: "running", pendingRequestCount: 0 })).status).toBe(
      "running",
    );
  });

  it("keeps threads migrated from before 0.1.0 as idle, not empty", () => {
    expect(classifyMcpThread(row({ latestRunId: null, itemCount: 17 })).status).toBe("idle");
    expect(classifyMcpThread(row({ latestRunId: null, itemCount: 0 })).status).toBe("empty");
  });

  it("puts a settled thread out of the inbox whatever its last run did", () => {
    expect(classifyMcpThread(row({ status: "failed", settled: true })).status).toBe("done");
    expect(classifyMcpThread(row({ status: "failed" })).status).toBe("error");
    expect(classifyMcpThread(row({ status: "cancelled" })).status).toBe("interrupted");
    expect(classifyMcpThread(row({ status: "queued" })).status).toBe("running");
  });
});

describe("a queue held after the last turn ended", () => {
  // The shape T3 0.1.0 returned on 2026-10-18 for a thread whose turn died on a
  // session limit while a follow-up sat in the queue: t3_thread_read reports the
  // queued run as the thread's status, nothing is active, and the queued run never
  // started. T3 refuses to settle it ("has a queued message").
  const held = {
    threadId: "t1",
    status: "queued",
    latestRunId: "run:2",
    activeRunId: null,
    pendingRequestCount: 0,
    runCount: 2,
    itemCount: 228,
    settled: false,
    recentRuns: [
      { runId: "run:2", ordinal: 2, status: "queued", startedAt: null, completedAt: null },
      {
        runId: "run:1",
        ordinal: 1,
        status: "failed",
        startedAt: "2026-10-18T15:40:11.413Z",
        completedAt: "2026-10-18T16:56:17.762Z",
      },
    ],
  };

  it("is a held queue, not a running turn", () => {
    expect(classifyMcpThread(held).status).toBe("queued");
  });

  it("refuses settle naming the queue, unless the caller drops it", () => {
    const state = classifyMcpThread(held);
    expect(settleRefusal(state, { queuedCount: 1 })).toMatch(/1 queued message .*--drop-queued/);
    expect(settleRefusal(state, { queuedCount: 1, dropQueued: true })).toBe(undefined);
  });

  it("still refuses a thread with a turn running, even with --drop-queued", () => {
    const running = {
      ...held,
      status: "running",
      activeRunId: "run:2",
      recentRuns: [{ ...held.recentRuns[0], status: "running", startedAt: "2026-10-18T17:00:00Z" }],
    };
    expect(classifyMcpThread(running).status).toBe("running");
    expect(settleRefusal(classifyMcpThread(running), { dropQueued: true })).toMatch(/running/);
    expect(settleRefusal(classifyMcpThread({ ...held, status: "failed", recentRuns: [] }))).toBe(
      undefined,
    );
  });

  it("keeps a new thread whose first run is still queued as running", () => {
    const fresh = { ...held, latestRunId: "run:1", runCount: 1, recentRuns: [held.recentRuns[0]] };
    expect(classifyMcpThread(fresh).status).toBe("running");
  });
});
