import { describe, expect, it } from "vite-plus/test";

import {
  actionableStatusToTaskState,
  isTerminalTaskState,
  issueStatusToTaskState,
} from "./taskState.ts";

describe("actionableStatusToTaskState", () => {
  const cases = [
    ["pending_founder", "queued"],
    ["dispatched", "dispatched"],
    ["gate_blocked_escalated", "blocked"],
    ["resolved", "done"],
    ["dropped", "dropped"],
    ["some_future_status", "unknown"],
  ] as const;

  for (const [input, expected] of cases) {
    it(`maps ${input} -> ${expected}`, () => {
      expect(actionableStatusToTaskState(input)).toBe(expected);
    });
  }
});

describe("issueStatusToTaskState", () => {
  it("recognizes terminal-ish issue statuses", () => {
    expect(issueStatusToTaskState("Closed")).toBe("done");
    expect(issueStatusToTaskState("merged")).toBe("done");
  });
  it("recognizes in-flight and blocked", () => {
    expect(issueStatusToTaskState("In Progress")).toBe("dispatched");
    expect(issueStatusToTaskState("Needs Review")).toBe("blocked");
  });
  it("recognizes queued and empty", () => {
    expect(issueStatusToTaskState("Open")).toBe("queued");
    expect(issueStatusToTaskState("")).toBe("unknown");
  });
});

describe("isTerminalTaskState", () => {
  it("treats done and dropped as terminal", () => {
    expect(isTerminalTaskState("done")).toBe(true);
    expect(isTerminalTaskState("dropped")).toBe(true);
    expect(isTerminalTaskState("dispatched")).toBe(false);
    expect(isTerminalTaskState("queued")).toBe(false);
  });
});
