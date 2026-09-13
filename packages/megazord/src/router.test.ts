import { describe, expect, it } from "vite-plus/test";

import {
  MegazordMachineRouter,
  MegazordRoutingError,
  requireLocal,
  type MachineTarget,
} from "./router.ts";

const LOCAL: MachineTarget = {
  id: "win-desktop",
  kind: "local",
  factoryDir: "/f",
  paperclipBaseUrl: "http://127.0.0.1:3100",
  companyId: "co-1",
};
const MAC: MachineTarget = {
  id: "mac-studio",
  kind: "remote",
  mesh: { transport: "remote-control" },
};

describe("MegazordMachineRouter (1 cockpit → N machines)", () => {
  it("routes to the default (first) machine when no hint is given", () => {
    const r = new MegazordMachineRouter([LOCAL, MAC]);
    expect(r.resolve().id).toBe("win-desktop");
    expect(r.list().map((t) => t.id)).toEqual(["win-desktop", "mac-studio"]);
  });

  it("routes to an explicit machine id", () => {
    const r = new MegazordMachineRouter([LOCAL, MAC]);
    expect(r.resolve({ machine: "mac-studio" }).id).toBe("mac-studio");
  });

  it("fails closed on an unknown machine", () => {
    const r = new MegazordMachineRouter([LOCAL]);
    expect(() => r.resolve({ machine: "ghost" })).toThrow(MegazordRoutingError);
  });

  it("fails closed when nothing is registered", () => {
    const r = new MegazordMachineRouter([]);
    expect(r.isEmpty()).toBe(true);
    expect(() => r.resolve()).toThrow(MegazordRoutingError);
  });

  it("honours a configured default and per-request account override", () => {
    const r = new MegazordMachineRouter([LOCAL, MAC], { defaultMachine: "mac-studio" });
    expect(r.resolve().id).toBe("mac-studio");
    const withAcct = r.resolve({ machine: "win-desktop", account: "acct-x" });
    expect(withAcct.account).toBe("acct-x");
  });

  it("register overwrites by id without duplicating order", () => {
    const r = new MegazordMachineRouter([LOCAL]);
    r.register({ ...LOCAL, companyId: "co-2" });
    expect(r.list()).toHaveLength(1);
    expect(r.resolve().companyId).toBe("co-2");
  });
});

describe("requireLocal (fail-closed remote seam)", () => {
  it("passes a well-formed local target through", () => {
    expect(requireLocal(LOCAL).id).toBe("win-desktop");
  });
  it("refuses a remote target (mesh transport not wired)", () => {
    expect(() => requireLocal(MAC)).toThrow(MegazordRoutingError);
  });
  it("refuses a local target with no factoryDir", () => {
    expect(() => requireLocal({ id: "x", kind: "local" })).toThrow(MegazordRoutingError);
  });
});
