import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MODEL_BY_DRIVER,
  defaultSsbMatcher,
  MegazordDispatchError,
  MegazordT3DispatchClient,
  parseAccounts,
  selectInstance,
  type InstanceUsage,
  type ProviderInstanceAccount,
} from "./dispatch.ts";

// The real inventory shape read from settings.json (values structurally real,
// no secrets): 4 enabled instances, two harnesses, one marked SSB.
const ACCOUNTS: ReadonlyArray<ProviderInstanceAccount> = [
  { instanceId: "codex", driver: "codex", enabled: true },
  { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude SSB", enabled: true },
  { instanceId: "codex_codex_capiva", driver: "codex", displayName: "Codex Capiva", enabled: true },
  {
    instanceId: "claudeAgent_claude_capiva",
    driver: "claudeAgent",
    displayName: "Claude Capiva",
    enabled: true,
  },
];

describe("defaultSsbMatcher", () => {
  it("matches only the enabled claudeAgent marked SSB", () => {
    const matched = ACCOUNTS.filter(defaultSsbMatcher);
    expect(matched.map((a) => a.instanceId)).toEqual(["claudeAgent"]);
  });

  it("does not match a codex account even if displayName says SSB", () => {
    expect(defaultSsbMatcher({ instanceId: "x", driver: "codex", displayName: "SSB codex" })).toBe(
      false,
    );
  });
});

describe("selectInstance — SSB exclusivity (hard rule)", () => {
  it("routes scope=ssb to the SSB account", () => {
    const d = selectInstance({ accounts: ACCOUNTS, scope: "ssb" });
    expect(d.instanceId).toBe("claudeAgent");
    expect(d.driver).toBe("claudeAgent");
    expect(d.model).toBe(DEFAULT_MODEL_BY_DRIVER.claudeAgent);
  });

  it("NEVER routes general work to the SSB account", () => {
    for (let i = 0; i < 5; i++) {
      const d = selectInstance({ accounts: ACCOUNTS, scope: "general" });
      expect(d.instanceId).not.toBe("claudeAgent");
    }
  });

  it("fail-closed: scope=ssb with no SSB account is a refusal, never a fallback", () => {
    const noSsb = ACCOUNTS.filter((a) => a.instanceId !== "claudeAgent");
    try {
      selectInstance({ accounts: noSsb, scope: "ssb" });
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(MegazordDispatchError);
      expect((e as MegazordDispatchError).refusal).toBe(true);
    }
  });

  it("fail-closed: scope=ssb refuses ambiguity (two SSB matches)", () => {
    const two = [
      ...ACCOUNTS,
      { instanceId: "claudeAgent_ssb2", driver: "claudeAgent", displayName: "SSB backup" },
    ];
    expect(() => selectInstance({ accounts: two, scope: "ssb" })).toThrow(MegazordDispatchError);
  });

  it("fail-closed: scope=ssb never leaks to another account when SSB is disabled", () => {
    const disabled = ACCOUNTS.map((a) =>
      a.instanceId === "claudeAgent" ? { ...a, enabled: false } : a,
    );
    const err = (() => {
      try {
        selectInstance({ accounts: disabled, scope: "ssb" });
        return undefined;
      } catch (e) {
        return e as MegazordDispatchError;
      }
    })();
    expect(err).toBeInstanceOf(MegazordDispatchError);
    expect(err!.refusal).toBe(true);
  });
});

describe("selectInstance — general pool (capability + quota)", () => {
  it("general pool = the three non-SSB accounts", () => {
    const d = selectInstance({ accounts: ACCOUNTS, scope: "general" });
    const pool = ["codex", "codex_codex_capiva", "claudeAgent_claude_capiva"];
    expect(pool).toContain(d.instanceId);
  });

  it("driver capability pins the harness (general)", () => {
    const d = selectInstance({ accounts: ACCOUNTS, scope: "general", driver: "claudeAgent" });
    // Only claudeAgent in the general pool is claudeAgent_claude_capiva.
    expect(d.instanceId).toBe("claudeAgent_claude_capiva");
  });

  it("fail-closed: required driver with no eligible general account refuses", () => {
    const onlyCodexPool = ACCOUNTS.filter(
      (a) => a.driver === "codex" || a.instanceId === "claudeAgent",
    );
    expect(() =>
      selectInstance({ accounts: onlyCodexPool, scope: "general", driver: "claudeAgent" }),
    ).toThrow(MegazordDispatchError);
  });

  it("chooses the least-loaded by quota", () => {
    const usage: InstanceUsage[] = [
      { instanceId: "codex", usedPercent: 80 },
      { instanceId: "codex_codex_capiva", usedPercent: 10 },
      { instanceId: "claudeAgent_claude_capiva", usedPercent: 40 },
    ];
    const d = selectInstance({ accounts: ACCOUNTS, scope: "general", usage });
    expect(d.instanceId).toBe("codex_codex_capiva");
    expect(d.load).toBe(10);
  });

  it("saturated accounts sort last even vs unknown-quota ones", () => {
    const usage: InstanceUsage[] = [
      { instanceId: "codex", usedPercent: 99 }, // saturated
      { instanceId: "codex_codex_capiva", usedPercent: 50 },
    ];
    // claudeAgent_claude_capiva has unknown quota; codex is saturated.
    const d = selectInstance({ accounts: ACCOUNTS, scope: "general", usage });
    expect(d.instanceId).toBe("codex_codex_capiva");
  });

  it("deterministic config order when quota is unknown", () => {
    const d1 = selectInstance({ accounts: ACCOUNTS, scope: "general" });
    const d2 = selectInstance({ accounts: ACCOUNTS, scope: "general" });
    expect(d1.instanceId).toBe(d2.instanceId);
    expect(d1.instanceId).toBe("codex"); // first non-SSB in config order
  });
});

describe("selectInstance — connector capability (needs)", () => {
  it("routes a needs request to the instance exposing the connector", () => {
    const d = selectInstance({
      accounts: ACCOUNTS,
      scope: "general",
      needs: "teams",
      capabilities: { codex_codex_capiva: ["teams", "jira"] },
    });
    expect(d.instanceId).toBe("codex_codex_capiva");
  });

  it("fail-closed: needs with no capability info refuses (never guesses)", () => {
    expect(() => selectInstance({ accounts: ACCOUNTS, scope: "general", needs: "teams" })).toThrow(
      MegazordDispatchError,
    );
  });
});

describe("parseAccounts", () => {
  it("reads the providerInstances object shape from settings.json", () => {
    const settings = {
      providerInstances: {
        codex: { driver: "codex", enabled: true, config: { customModels: [] } },
        claudeAgent: {
          driver: "claudeAgent",
          displayName: "Claude SSB",
          enabled: true,
          config: { homePath: "/home/x" },
        },
      },
    };
    const accounts = parseAccounts(settings);
    expect(accounts.map((a) => a.instanceId).sort()).toEqual(["claudeAgent", "codex"]);
    const ssb = accounts.find((a) => a.instanceId === "claudeAgent")!;
    expect(ssb.displayName).toBe("Claude SSB");
    expect(ssb.homePath).toBe("/home/x");
  });

  it("returns [] for missing/invalid providerInstances", () => {
    expect(parseAccounts({})).toEqual([]);
    expect(parseAccounts(null)).toEqual([]);
  });
});

// ── Client with injected fetch + accounts (no live server, no subprocess) ──────

function makeFetchStub(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; method: string; body?: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    if (u.endsWith("/api/orchestration/snapshot")) {
      return new Response(
        JSON.stringify({
          projects: [{ id: "proj-1", title: "podkst", deletedAt: null }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/api/orchestration/threads/")) {
      const threadId = u.slice(u.lastIndexOf("/") + 1);
      if (threadId === "gone") return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          thread: {
            id: threadId,
            deletedAt: threadId === "deleted" ? "2026-09-13T00:00:00.000Z" : null,
            archivedAt: null,
            latestTurn: {
              turnId: "turn-1",
              state: "completed",
              requestedAt: "2026-09-13T00:00:00.000Z",
            },
            messages: [
              { id: "m1", role: "user", text: "oi", turnId: "turn-1", streaming: false },
              {
                id: "m2",
                role: "assistant",
                text: "resposta",
                turnId: "turn-1",
                streaming: false,
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.endsWith("/api/orchestration/dispatch")) {
      return new Response(JSON.stringify({ sequence: 4242 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("MegazordT3DispatchClient", () => {
  it("select mode runs the policy with no network dispatch", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const client = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      fetchImpl,
    });
    const out = await client.dispatch({ task: "x", scope: "ssb", mode: "select" });
    expect(out.mode).toBe("select");
    expect(out.instanceId).toBe("claudeAgent");
    expect(out.threadId).toBe("");
    expect(calls.length).toBe(0); // proved the choice without touching the account
  });

  it("full dispatch creates a thread + turn on the chosen general instance", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    let seq = 0;
    const client = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      fetchImpl,
      uuid: () => `uuid-${++seq}`,
      now: () => "2026-09-12T00:00:00.000Z",
      usageSource: () => [
        { instanceId: "codex", usedPercent: 90 },
        { instanceId: "codex_codex_capiva", usedPercent: 5 },
      ],
    });
    const out = await client.dispatch({
      task: "do a thing",
      scope: "general",
      projectId: "proj-1",
    });
    expect(out.mode).toBe("full");
    expect(out.instanceId).toBe("codex_codex_capiva"); // least loaded
    const dispatches = calls.filter((c) => c.url.endsWith("/dispatch"));
    expect(dispatches.map((c) => (c.body as { type: string }).type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    const create = dispatches[0]!.body as { modelSelection: { instanceId: string } };
    expect(create.modelSelection.instanceId).toBe("codex_codex_capiva");
    expect(out.sequence).toBe(4242);
    // The link is the T3 UI route, openable by a human — not the API endpoint.
    expect(out.url).toBe("http://127.0.0.1:3773/env-1/uuid-1");
    expect(out.url).not.toContain("/api/");
  });

  it("create mode stops after thread.create (no harness, no quota spent)", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const client = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      fetchImpl,
    });
    const out = await client.dispatch({
      task: "peek",
      scope: "general",
      projectId: "proj-1",
      mode: "create",
    });
    expect(out.mode).toBe("create");
    const dispatches = calls.filter((c) => c.url.endsWith("/dispatch"));
    expect(dispatches.length).toBe(1);
    expect((dispatches[0]!.body as { type: string }).type).toBe("thread.create");
  });

  it("resolves projectId by exact title against the live snapshot", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const client = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      fetchImpl,
    });
    await client.dispatch({
      task: "t",
      scope: "general",
      projectTitle: "podkst",
      mode: "create",
    });
    const create = calls
      .filter((c) => c.url.endsWith("/dispatch"))
      .map((c) => c.body as { projectId: string })[0]!;
    expect(create.projectId).toBe("proj-1");
  });

  it("fail-closed at the client: ssb dispatch with no SSB account refuses before any I/O", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const client = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS.filter((a) => a.instanceId !== "claudeAgent"),
      fetchImpl,
    });
    await expect(
      client.dispatch({ task: "secret", scope: "ssb", projectId: "proj-1" }),
    ).rejects.toBeInstanceOf(MegazordDispatchError);
    expect(calls.length).toBe(0);
  });
});

describe("model pinning", () => {
  it("a pinned model beats the harness default and says so in the reason", () => {
    const decision = selectInstance({
      accounts: ACCOUNTS,
      scope: "general",
      driver: "claudeAgent",
      model: "claude-opus-5",
      modelsByDriver: { claudeAgent: ["claude-opus-5", "claude-sonnet-5"] },
    });
    expect(decision.model).toBe("claude-opus-5");
    expect(decision.reason).toContain("model pinned=claude-opus-5");
  });

  it("refuses a model the harness does not offer instead of creating a dead thread", () => {
    expect(() =>
      selectInstance({
        accounts: ACCOUNTS,
        scope: "general",
        driver: "claudeAgent",
        model: "gpt-5.6-sol",
        modelsByDriver: { claudeAgent: ["claude-opus-5", "claude-sonnet-5"] },
      }),
    ).toThrow(/not available for harness 'claudeAgent'/);
  });

  it("an unknown manifest does not gate the pin", () => {
    const decision = selectInstance({
      accounts: ACCOUNTS,
      scope: "general",
      driver: "claudeAgent",
      model: "claude-opus-5",
    });
    expect(decision.model).toBe("claude-opus-5");
  });

  it("dispatch sends the pinned model in thread.create", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const client = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      modelsByDriver: { claudeAgent: ["claude-opus-5"] },
      fetchImpl,
    });
    const out = await client.dispatch({
      task: "do a thing",
      scope: "general",
      projectId: "proj-1",
      driver: "claudeAgent",
      model: "claude-opus-5",
    });
    expect(out.model).toBe("claude-opus-5");
    const create = calls.filter((c) => c.url.endsWith("/dispatch"))[0]!.body as {
      modelSelection: { model: string };
    };
    expect(create.modelSelection.model).toBe("claude-opus-5");
  });
});

describe("continuing a thread", () => {
  it("sends only a turn, keeps the thread, and says it was reused", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const c = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      fetchImpl,
    });
    const out = await c.dispatch({
      task: "segunda mensagem",
      scope: "general",
      threadId: "th-existing",
    });
    expect(out.reusedThread).toBe(true);
    expect(out.threadId).toBe("th-existing");
    expect(out.url).toBe("http://127.0.0.1:3773/env-1/th-existing");
    const posted = calls.filter((call) => call.url.endsWith("/dispatch"));
    // No thread.create: the conversation already exists.
    expect(posted.map((call) => (call.body as { type: string }).type)).toEqual([
      "thread.turn.start",
    ]);
    expect((posted[0]!.body as { threadId: string }).threadId).toBe("th-existing");
  });

  it("refuses a thread that is gone so the caller can start a fresh one", async () => {
    const { fetchImpl } = makeFetchStub();
    const c = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      fetchImpl,
    });
    await expect(c.dispatch({ task: "x", scope: "general", threadId: "gone" })).rejects.toThrow(
      /is not open on this machine/,
    );
  });

  it("refuses a deleted thread too", async () => {
    const { fetchImpl } = makeFetchStub();
    const c = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      fetchImpl,
    });
    await expect(c.dispatch({ task: "x", scope: "general", threadId: "deleted" })).rejects.toThrow(
      /is not open on this machine/,
    );
  });

  it("awaitTurn returns the assistant text of the terminal turn", async () => {
    const { fetchImpl } = makeFetchStub();
    const c = new MegazordT3DispatchClient({
      origin: "http://127.0.0.1:3773",
      token: "TESTTOKEN",
      environmentId: "env-1",
      accounts: ACCOUNTS,
      fetchImpl,
    });
    const out = await c.awaitTurn({ threadId: "th-existing", timeoutMs: 5000 });
    expect(out.state).toBe("completed");
    expect(out.text).toBe("resposta");
    expect(out.timedOut).toBe(false);
    expect(out.url).toBe("http://127.0.0.1:3773/env-1/th-existing");
  });
});
