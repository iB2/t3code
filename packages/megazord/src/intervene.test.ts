import { describe, expect, it } from "vite-plus/test";

import {
  approvalDecisionToIntervene,
  interveneCommentBody,
  MegazordInterveneClient,
  MegazordInterveneError,
  MEGAZORD_INTERVENE_KINDS,
  planIntervention,
  type MegazordInterveneAction,
  type MegazordThreadCoords,
} from "./intervene.ts";

const COORDS: MegazordThreadCoords = {
  issueId: "iss-1",
  approvalId: "apr-1",
  companyId: "co-1",
  issueIdent: "CAPA-9",
  actionableId: "act-1",
};

describe("planIntervention (fail-closed)", () => {
  it("refuses (no network) an issue-family action with no issueId", () => {
    for (const coords of [{}, { companyId: "co-1" }, { approvalId: "apr-1" }]) {
      try {
        planIntervention({ kind: "pause" }, coords);
        throw new Error("expected refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(MegazordInterveneError);
        expect((e as MegazordInterveneError).refusal).toBe(true);
      }
    }
  });

  it("refuses (no network) a gate action with no approvalId", () => {
    for (const coords of [{}, { issueId: "iss-1" }, { companyId: "co-1" }]) {
      try {
        planIntervention({ kind: "approve" }, coords);
        throw new Error("expected refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(MegazordInterveneError);
        expect((e as MegazordInterveneError).refusal).toBe(true);
      }
    }
  });

  it("refuses an empty injected message", () => {
    try {
      planIntervention({ kind: "inject", message: "   " }, COORDS);
      throw new Error("expected refusal");
    } catch (e) {
      expect((e as MegazordInterveneError).refusal).toBe(true);
    }
  });

  it("maps inject to an interrupting comment POST on the issue path", () => {
    const req = planIntervention({ kind: "inject", message: "go left instead" }, COORDS);
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/issues/iss-1/comments");
    expect(String(req.body["body"])).toContain("go left instead");
    expect(String(req.body["body"])).toContain("mz:redirect=1");
    expect(req.body["interrupt"]).toBe(true);
  });

  it("maps pause/resume/kill to tree-holds with the mapped mode", () => {
    const pause = planIntervention({ kind: "pause" }, COORDS);
    expect(pause.path).toBe("/issues/iss-1/tree-holds");
    expect(pause.body["mode"]).toBe("pause");
    expect(String(pause.body["reason"])).toContain("mz:control=pause");

    expect(planIntervention({ kind: "resume" }, COORDS).body["mode"]).toBe("resume");
    expect(planIntervention({ kind: "kill" }, COORDS).body["mode"]).toBe("cancel");
  });

  it("maps approve/reject to the approval decision path", () => {
    const approve = planIntervention({ kind: "approve" }, COORDS);
    expect(approve.method).toBe("POST");
    expect(approve.path).toBe("/approvals/apr-1/approve");
    expect(String(approve.body["decisionNote"])).toContain("mz:gate=approve");

    const reject = planIntervention({ kind: "reject", note: "not safe" }, COORDS);
    expect(reject.path).toBe("/approvals/apr-1/reject");
    expect(String(reject.body["decisionNote"])).toContain("not safe");
  });

  it("honours endpoint + body-key overrides", () => {
    const inject = planIntervention({ kind: "inject", message: "x" }, COORDS, {
      commentPath: (id) => `/x/${id}/notes`,
      commentBodyKey: "text",
    });
    expect(inject.path).toBe("/x/iss-1/notes");
    expect(inject.body["text"]).toBeDefined();

    const pause = planIntervention({ kind: "pause" }, COORDS, {
      treeHoldPath: (id) => `/x/${id}/holds`,
    });
    expect(pause.path).toBe("/x/iss-1/holds");

    const approve = planIntervention({ kind: "approve" }, COORDS, {
      approvalDecisionPath: (id, decision) => `/x/${id}/${decision}!`,
    });
    expect(approve.path).toBe("/x/apr-1/approve!");
  });
});

describe("interveneCommentBody markers", () => {
  it("tags gate decisions", () => {
    expect(interveneCommentBody({ kind: "approve" }, COORDS)).toContain("mz:gate=approve");
    expect(interveneCommentBody({ kind: "reject", note: "not safe" }, COORDS)).toContain(
      "mz:gate=reject",
    );
    expect(interveneCommentBody({ kind: "reject", note: "not safe" }, COORDS)).toContain(
      "not safe",
    );
  });
  it("tags control actions and echoes the actionable id", () => {
    const body = interveneCommentBody({ kind: "kill" }, COORDS);
    expect(body).toContain("mz:control=kill");
    expect(body).toContain("mz:actionable=act-1");
  });
});

describe("approvalDecisionToIntervene", () => {
  it("maps accept variants to approve, decline/cancel to reject", () => {
    for (const d of ["accept", "acceptForSession", "acceptAlways"]) {
      expect(approvalDecisionToIntervene(d).kind).toBe("approve");
    }
    for (const d of ["decline", "cancel"]) {
      expect(approvalDecisionToIntervene(d).kind).toBe("reject");
    }
  });
});

describe("MegazordInterveneClient", () => {
  it("refuses before touching the network when coords are missing", async () => {
    let called = 0;
    const client = new MegazordInterveneClient({
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(client.intervene({}, { kind: "pause" })).rejects.toBeInstanceOf(
      MegazordInterveneError,
    );
    expect(called).toBe(0);
  });

  it("posts an interrupting comment to the running Paperclip (mocked fetch)", async () => {
    let seenUrl = "";
    let seenBody = "";
    const client = new MegazordInterveneClient({
      paperclipBaseUrl: "http://127.0.0.1:3100/",
      companyId: "co-1",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenBody = String(init.body);
        return new Response(JSON.stringify({ id: "c-99" }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const res = await client.intervene(
      { issueId: "iss-1" },
      { kind: "inject", message: "pivot to plan B" },
    );
    expect(seenUrl).toBe("http://127.0.0.1:3100/api/issues/iss-1/comments");
    expect(seenBody).toContain("pivot to plan B");
    expect(seenBody).toContain('"interrupt":true');
    expect(res.action).toBe("inject");
    expect(res.issueId).toBe("iss-1");
  });

  it("posts a gate decision to the approval path (mocked fetch)", async () => {
    let seenUrl = "";
    const client = new MegazordInterveneClient({
      fetchImpl: (async (url: string) => {
        seenUrl = url;
        return new Response(JSON.stringify({ id: "apr-1", status: "approved" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await client.intervene({ approvalId: "apr-1" }, { kind: "approve" });
    expect(seenUrl).toBe("http://127.0.0.1:3100/api/approvals/apr-1/approve");
    expect(res.action).toBe("approve");
    expect(res.approvalId).toBe("apr-1");
  });

  it("surfaces a factory rejection as a non-refusal error", async () => {
    const client = new MegazordInterveneClient({
      companyId: "co-1",
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    try {
      await client.intervene({ issueId: "iss-1" }, { kind: "kill" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MegazordInterveneError);
      expect((e as MegazordInterveneError).refusal).toBe(false);
      expect((e as MegazordInterveneError).detail?.status).toBe(500);
    }
  });

  it("covers every declared action kind through the planner", () => {
    for (const kind of MEGAZORD_INTERVENE_KINDS) {
      const action = (
        kind === "inject" ? { kind, message: "x" } : { kind }
      ) as MegazordInterveneAction;
      const req = planIntervention(action, COORDS);
      expect(req.method).toBe("POST");
    }
  });
});
