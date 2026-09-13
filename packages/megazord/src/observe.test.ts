import { describe, expect, it } from "vite-plus/test";

import { observationDetail, observeFromIssue } from "./observe.ts";

describe("observeFromIssue", () => {
  it("projects coarse state from status and omits absent signals", () => {
    const obs = observeFromIssue({ status: "in progress" });
    expect(obs.state).toBe("dispatched");
    expect(obs.rawStatus).toBe("in progress");
    expect(obs.phase).toBeUndefined();
    expect(obs.agent).toBeUndefined();
  });

  it("extracts phase/agent/cost/risk when present", () => {
    const obs = observeFromIssue({
      status: "running",
      phase: "review",
      assignee: { name: "narrative" },
      cost: "$0.42",
      tier: 2,
    });
    expect(obs.phase).toBe("review");
    expect(obs.agent).toBe("narrative");
    expect(obs.cost).toBe("$0.42");
    expect(obs.risk).toBe("2");
  });

  it("reads a flat assignee string too", () => {
    const obs = observeFromIssue({ status: "open", assignee: "platform" });
    expect(obs.agent).toBe("platform");
  });

  it("never throws on a garbage/empty issue body", () => {
    const obs = observeFromIssue({});
    expect(obs.state).toBe("unknown");
    expect(obs.rawStatus).toBe("");
  });
});

describe("observationDetail", () => {
  it("joins present signals and skips absent ones", () => {
    expect(observationDetail({ phase: "dispatch", agent: "weaver" })).toBe(
      "phase: dispatch · agent: weaver",
    );
    expect(observationDetail({})).toBe("");
    expect(observationDetail({ risk: "high" })).toBe("risk: high");
  });
});
