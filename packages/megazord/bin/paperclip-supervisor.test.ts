import { describe, expect, it } from "vite-plus/test";

import { classifyOrchFailure, probeOrigin, timedWithRetry } from "./paperclip-supervisor.mjs";

// Regression coverage for the 130-alert false-positive flood: a slow token mint
// (subprocess contention under machine load) was being reported as the backend
// being down. These tests pin the fix's three observable cases.

describe("timedWithRetry", () => {
  it("retries once on failure with the configured backoff", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await timedWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("token mint timed out after 60000ms");
        return { healthy: true };
      },
      {
        wait: async (ms: number) => {
          waits.push(ms);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(waits).toEqual([2500]);
  });

  it("gives up only after both attempts fail", async () => {
    let calls = 0;
    const result = await timedWithRetry(
      async () => {
        calls += 1;
        throw new Error("fetch failed");
      },
      { wait: async () => {} },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(2);
    expect(result.error).toBe("fetch failed");
  });
});

describe("classifyOrchFailure", () => {
  it("is not critical when the origin still answers (mint slow, server alive)", () => {
    const orch = { ok: false as const, ms: 60_000, error: "token mint timed out after 60000ms" };
    const finding = classifyOrchFailure(orch, { reachable: true, status: 200 });
    expect(finding.severity).toBe("warn");
    expect(finding.message).toContain("mint lento");
    expect(finding.message).toContain("backend responde");
  });

  it("is critical when the origin is unreachable too", () => {
    const orch = { ok: false as const, ms: 60_000, error: "token mint timed out after 60000ms" };
    const finding = classifyOrchFailure(orch, { reachable: false, error: "fetch failed" });
    expect(finding.severity).toBe("critical");
    expect(finding.message).toContain("down");
  });
});

describe("probeOrigin", () => {
  it("reports reachable when the origin root responds", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const probe = await probeOrigin("http://127.0.0.1:3773", { fetchImpl });
    expect(probe.reachable).toBe(true);
    expect(probe.status).toBe(200);
  });

  it("reports unreachable when the connection itself fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3773");
    }) as unknown as typeof fetch;
    const probe = await probeOrigin("http://127.0.0.1:3773", { fetchImpl });
    expect(probe.reachable).toBe(false);
  });
});

describe("orchestration check — the 3 cases that mattered for the false-positive", () => {
  it("mint timeout on both tries but backend responds -> non-critical finding", async () => {
    const orch = await timedWithRetry(
      async () => {
        throw new Error("token mint timed out after 60000ms");
      },
      { wait: async () => {} },
    );
    const probe = await probeOrigin("http://127.0.0.1:3773", {
      fetchImpl: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    const finding = classifyOrchFailure(orch, probe);
    expect(finding.severity).not.toBe("critical");
    expect(finding.severity).toBe("warn");
  });

  it("both tries fail and the backend is unreachable -> critical finding", async () => {
    const orch = await timedWithRetry(
      async () => {
        throw new Error("fetch failed");
      },
      { wait: async () => {} },
    );
    const probe = await probeOrigin("http://127.0.0.1:3773", {
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3773");
      }) as unknown as typeof fetch,
    });
    const finding = classifyOrchFailure(orch, probe);
    expect(finding.severity).toBe("critical");
  });

  it("first try fails, second succeeds -> ok, no finding at all (silence)", async () => {
    let attempts = 0;
    const orch = await timedWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("token mint timed out after 60000ms");
        return { healthy: true };
      },
      { wait: async () => {} },
    );
    expect(orch.ok).toBe(true);
    expect(attempts).toBe(2);
    // sweep() only ever pushes a finding when `!orch.ok`; a recovered retry
    // produces none — this is what silences the alert.
  });
});
