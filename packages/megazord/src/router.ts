/**
 * MachineRouter — the T3 COCKPIT model: one cockpit routes N machines.
 *
 * ## The model this implements (DISTRIBUTION-PLAN, decision by Bruno)
 *
 * The "sonho" is a single T3 cockpit (operable from Mac OR Windows) that
 * dispatches each request to a chosen **machine + account**, via the mesh
 * (Remote Control / a session per machine). This module is the routing
 * INTERFACE plus the fully-working path for a LOCAL machine; a REMOTE machine is
 * modelled as a first-class target whose transport is wired live (the multi-
 * machine round-trip is validated on the Mac test, per the plan).
 *
 * ## Honest scope
 *
 * - LOCAL targets: fully build-verified — they carry the loopback Paperclip URL +
 *   factory dir, so the existing intake/observe/intervene clients drive them with
 *   no extra transport.
 * - REMOTE targets: the interface exists and routing resolves them, but there is
 *   no in-process mesh transport here. A caller that resolves a remote target and
 *   has not supplied a transport must FAIL-CLOSED (see {@link requireLocal}) — we
 *   never silently pretend a remote dispatch happened. This is the seam Bruno
 *   validates live from the Mac.
 *
 * Framework-agnostic (no Effect/T3 imports) so it lives in this leaf package and
 * is reused verbatim by the in-tree driver.
 *
 * @module megazord/router
 */

export type MachineKind = "local" | "remote";

/** One routable machine the cockpit can dispatch to. */
export interface MachineTarget {
  /** Stable machine id, e.g. `"win-desktop"`, `"mac-studio"`. */
  readonly id: string;
  readonly kind: MachineKind;
  /** Account/subscription this machine runs under (the "conta por request"). */
  readonly account?: string;
  /** Paperclip org server base URL. For local: loopback. For remote: mesh-resolved. */
  readonly paperclipBaseUrl?: string;
  /** capiva-factory checkout dir (local dispatch only). */
  readonly factoryDir?: string;
  /** Paperclip company scope for this machine's org. */
  readonly companyId?: string;
  /** Base branch for the machine's worktree control-plane. */
  readonly baseBranch?: string;
  /** The repo the machine's threads work on (worktree provisioning). */
  readonly repoDir?: string;
  /** Remote mesh routing hint (Remote Control session ref / transport name). */
  readonly mesh?: { readonly sessionRef?: string; readonly transport?: string };
}

/** A dispatch request's routing hint: which machine + account. */
export interface MegazordRouteRequest {
  /** Explicit target machine id. Omit to use the router default. */
  readonly machine?: string;
  /** Explicit account override for this request. */
  readonly account?: string;
}

/** Thrown when routing cannot resolve a target (fail-closed). */
export class MegazordRoutingError extends Error {
  override readonly name = "MegazordRoutingError";
  constructor(message: string) {
    super(message);
  }
}

export interface MegazordMachineRouterOptions {
  /** Machine id used when a request carries no `machine`. Defaults to the sole/first target. */
  readonly defaultMachine?: string;
}

/**
 * Holds the machine registry and resolves `request → MachineTarget`. This is the
 * interface that makes "1 cockpit routes N machines" concrete; the driver builds
 * one from config and asks it per session/turn which machine to dispatch to.
 */
export class MegazordMachineRouter {
  private readonly targets = new Map<string, MachineTarget>();
  private readonly order: string[] = [];
  private readonly defaultMachine: string | undefined;

  constructor(
    targets: ReadonlyArray<MachineTarget> = [],
    options: MegazordMachineRouterOptions = {},
  ) {
    for (const t of targets) this.register(t);
    this.defaultMachine = options.defaultMachine;
  }

  /** Add/replace a machine target. Duplicate ids overwrite (last wins). */
  register(target: MachineTarget): void {
    if (target.id.trim() === "") {
      throw new MegazordRoutingError("machine target requires a non-empty id");
    }
    if (!this.targets.has(target.id)) this.order.push(target.id);
    this.targets.set(target.id, target);
  }

  /** Every registered machine, in registration order. */
  list(): ReadonlyArray<MachineTarget> {
    return this.order.map((id) => this.targets.get(id)!);
  }

  /** Whether the router has any target at all. */
  isEmpty(): boolean {
    return this.targets.size === 0;
  }

  /**
   * Resolve a request to its target machine. Fail-closed:
   *  - unknown explicit machine id → throw (never silently fall back);
   *  - no explicit machine and no resolvable default → throw.
   * An `account` on the request overrides the target's default account.
   */
  resolve(request: MegazordRouteRequest = {}): MachineTarget {
    const wanted = request.machine?.trim();
    let target: MachineTarget | undefined;
    if (wanted !== undefined && wanted !== "") {
      target = this.targets.get(wanted);
      if (target === undefined) {
        throw new MegazordRoutingError(
          `unknown machine '${wanted}' (registered: ${this.order.join(", ") || "none"})`,
        );
      }
    } else {
      const defId = this.defaultMachine ?? this.order[0];
      if (defId === undefined) {
        throw new MegazordRoutingError("no machines registered to route to");
      }
      target = this.targets.get(defId);
      if (target === undefined) {
        throw new MegazordRoutingError(`default machine '${defId}' is not registered`);
      }
    }
    if (request.account !== undefined && request.account !== "") {
      return { ...target, account: request.account };
    }
    return target;
  }
}

/**
 * Assert a resolved target is locally dispatchable, or FAIL-CLOSED. The local
 * path (intake/observe/intervene over the loopback Paperclip) is build-verified;
 * a remote target with no mesh transport is refused here rather than pretended.
 * This is the exact seam Bruno wires + validates from the Mac.
 */
export function requireLocal(target: MachineTarget): MachineTarget {
  if (target.kind !== "local") {
    throw new MegazordRoutingError(
      `machine '${target.id}' is remote; the mesh transport (Remote Control) is ` +
        `not wired in-process yet — validate multi-machine dispatch live from the Mac`,
    );
  }
  if ((target.factoryDir ?? "").trim() === "") {
    throw new MegazordRoutingError(
      `local machine '${target.id}' has no factoryDir; cannot dispatch to its org`,
    );
  }
  return target;
}
