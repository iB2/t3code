/**
 * `@t3tools/megazord` — bridge between a T3 Code thread and the capiva-factory
 * ("Megazord") agent factory.
 *
 * Public surface: a dependency-free intake client plus the status-projection
 * helpers a harness needs to drive a thread lifecycle from factory state.
 *
 * @module megazord
 */
export {
  MegazordIntakeClient,
  MegazordIntakeError,
  type MegazordIntakeClientOptions,
  type MegazordIntakeRequest,
  type MegazordDomain,
  type MegazordSubmitResult,
  type MegazordPaperclipRef,
  type MegazordStatus,
} from "./MegazordIntakeClient.ts";

export {
  actionableStatusToTaskState,
  issueStatusToTaskState,
  isTerminalTaskState,
  type MegazordTaskState,
  type FactoryActionableStatus,
} from "./taskState.ts";

export {
  megazordSubmitEvents,
  megazordThreadEventsForTransition,
  megazordPollShouldStop,
  type MegazordThreadEvent,
  type MegazordProgressContext,
} from "./runtimeEvents.ts";

export {
  WorktreeManager,
  WorktreeError,
  WorktreeGuardrailError,
  sanitizeThreadRef,
  extractPrUrl,
  type WorktreeManagerOptions,
  type ThreadWorktree,
  type WorktreeCommandDetail,
} from "./worktree.ts";
