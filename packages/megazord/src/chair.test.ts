import { describe, expect, it } from "vite-plus/test";

import {
  ChairRefusal,
  assertInstanceAllowed,
  classifyThread,
  parsePolicy,
  pendingApprovals,
  projectVisible,
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
