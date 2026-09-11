import { describe, expect, it } from "vite-plus/test";

import {
  megazordPollShouldStop,
  megazordSubmitEvents,
  megazordThreadEventsForTransition,
} from "./runtimeEvents.ts";

describe("megazordSubmitEvents", () => {
  it("opens a session and a turn on submit", () => {
    const events = megazordSubmitEvents({ issueIdent: "PAP-42" });
    expect(events.map((e) => e.kind)).toEqual(["session-started", "turn-started"]);
    const started = events[0];
    if (started?.kind !== "session-started") throw new Error("expected session-started");
    expect(started.text).toContain("PAP-42");
  });
});

describe("megazordThreadEventsForTransition", () => {
  it("emits nothing when the state did not change", () => {
    expect(megazordThreadEventsForTransition("dispatched", "dispatched")).toEqual([]);
  });

  it("reports dispatch as an informational note", () => {
    const [ev] = megazordThreadEventsForTransition("queued", "dispatched", { issueIdent: "PAP-7" });
    expect(ev?.kind).toBe("status-note");
    if (ev?.kind !== "status-note") throw new Error("expected status-note");
    expect(ev.text).toContain("PAP-7");
  });

  it("keeps the turn open when blocked (founder escalation)", () => {
    const [ev] = megazordThreadEventsForTransition("dispatched", "blocked");
    expect(ev?.kind).toBe("blocked");
  });

  it("completes the turn on done", () => {
    const [ev] = megazordThreadEventsForTransition("dispatched", "done");
    if (ev?.kind !== "turn-completed") throw new Error("expected turn-completed");
    expect(ev.state).toBe("completed");
  });

  it("fails the turn on dropped", () => {
    const [ev] = megazordThreadEventsForTransition("dispatched", "dropped");
    if (ev?.kind !== "turn-completed") throw new Error("expected turn-completed");
    expect(ev.state).toBe("failed");
  });

  it("does not spam a note for the initial queued observation", () => {
    expect(megazordThreadEventsForTransition(undefined, "queued")).toEqual([]);
  });

  it("full happy-path round-trip produces one terminal completion", () => {
    const path = ["dispatched", "done"] as const;
    let prev: "queued" | "dispatched" | "done" | undefined = "queued";
    const all = [];
    for (const next of path) {
      all.push(...megazordThreadEventsForTransition(prev, next));
      prev = next;
    }
    const completions = all.filter((e) => e.kind === "turn-completed");
    expect(completions).toHaveLength(1);
  });
});

describe("megazordPollShouldStop", () => {
  it("stops on terminal states only", () => {
    expect(megazordPollShouldStop("done")).toBe(true);
    expect(megazordPollShouldStop("dropped")).toBe(true);
    expect(megazordPollShouldStop("blocked")).toBe(false);
    expect(megazordPollShouldStop("dispatched")).toBe(false);
  });
});
