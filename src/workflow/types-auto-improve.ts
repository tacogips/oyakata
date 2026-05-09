import type { LoadOptions } from "./types-base";

// --- auto-improve / superviser mode (design-auto-improve-superviser-mode) ---

/**
 * Input policy for supervised `--auto-improve` runs. Persisted on the session when active.
 */
export interface AutoImprovePolicy {
  readonly enabled: true;
  readonly superviserWorkflowId?: string;
  readonly monitorIntervalMs: number;
  readonly stallTimeoutMs: number;
  readonly maxSupervisedAttempts: number;
  readonly maxWorkflowPatches: number;
  readonly workflowMutationMode: "execution-copy" | "in-place";
  readonly allowTargetedRerun?: boolean;
}

/**
 * Polls the runtime session snapshot row (`sessions.updated_at` from
 * `saveSessionSnapshotToRuntimeDb`) while a step executes; on stale snapshots,
 * the adapter or native step execution is aborted (design: persisted timestamps).
 */
export interface SupervisionStallWatch {
  readonly sessionId: string;
  readonly monitorIntervalMs: number;
  readonly stallTimeoutMs: number;
  readonly loadOptions: LoadOptions;
}

export interface SupervisionIncident {
  readonly incidentId: string;
  readonly supervisedAttemptId: string;
  readonly category: "failure" | "stall" | "budget-exhausted";
  readonly summary: string;
  readonly detectedAt: string;
}

/** Normalized remediation choice recorded after an incident (impl-plan superviser module). */
export type SupervisionRemediationAction =
  | "rerun-workflow"
  | "rerun-step"
  | "patch-workflow"
  | "stop-supervision";

export interface SupervisionRemediationRecord {
  readonly remediationId: string;
  readonly incidentId: string;
  readonly decidedAt: string;
  readonly action: SupervisionRemediationAction;
  readonly targetStepId?: string;
  readonly reason: string;
}

export type SupervisionRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "stopped";

/**
 * Durable supervision cycle state stored on the workflow session record when auto-improve is active.
 * Policy and remediation history are required for resume-safe supervision (design-auto-improve-superviser-mode).
 */
export interface SupervisionRunState {
  readonly supervisionRunId: string;
  readonly targetWorkflowId: string;
  readonly superviserWorkflowId: string;
  readonly status: SupervisionRunStatus;
  readonly attemptCount: number;
  readonly workflowPatchCount: number;
  /** Active policy for this cycle; omitted in older persisted sessions until backfilled. */
  readonly policy?: AutoImprovePolicy;
  /**
   * When phase-2 nested superviser execution is active, the session id of the
   * superviser workflow run that owns this supervision cycle.
   */
  readonly nestedSuperviserSessionId?: string;
  /**
   * Absolute path to the workflow bundle directory (canonical source for in-place, or
   * execution-scoped copy under the artifact root). Used to resume loads after restart.
   */
  readonly mutableWorkflowDir?: string;
  readonly incidents: readonly SupervisionIncident[];
  /** Remediation decisions applied during this cycle, newest last. */
  readonly remediations?: readonly SupervisionRemediationRecord[];
}

/**
 * Library/GraphQL-friendly snapshot derived from {@link SupervisionRunState}.
 */
export interface SupervisionSummary {
  readonly supervisionRunId: string;
  readonly targetWorkflowId: string;
  readonly superviserWorkflowId: string;
  readonly status: SupervisionRunStatus;
  readonly attemptCount: number;
  readonly workflowPatchCount: number;
  readonly latestIncidentId?: string;
  readonly latestRemediationId?: string;
  readonly mutableWorkflowDir?: string;
  readonly nestedSuperviserSessionId?: string;
}

/**
 * Shared request fields for nested-superviser control add-on `arguments` (phase 2).
 * The runtime issues a {@link SuperviserControlAuth} when launching the nested superviser;
 * each control call must repeat it so the engine can scope operations to the active cycle.
 */
export interface SuperviserControlAuth {
  readonly supervisionRunId: string;
  readonly targetSessionId: string;
}

export interface StartWorkflowAddonInput {
  readonly workflowId: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly autoImprove?: AutoImprovePolicy;
}

export interface GetWorkflowStatusAddonInput {
  readonly sessionId: string;
}

export interface GetWorkflowExecutionDetailsAddonInput {
  readonly sessionId: string;
}

export interface RerunWorkflowAddonInput {
  readonly sessionId: string;
  /**
   * When omitted, nested `SuperviserRuntimeControl` resolves a step id from the
   * target session and workflow (current step, else manager/entry anchor) so
   * `runWorkflow` receives `rerunFromStepId` with `rerunFromSessionId`.
   */
  readonly rerunFromStepId?: string;
}

export interface LoadWorkflowDefinitionAddonInput {
  readonly workflowId: string;
  readonly mutableWorkflowDir: string;
}

export interface SaveWorkflowDefinitionAddonInput {
  readonly workflowId: string;
  readonly mutableWorkflowDir: string;
  /**
   * `workflow` + `nodePayloads` bundle to write via {@link import("./save").saveWorkflowToDisk}.
   */
  readonly bundle: {
    readonly workflow: Readonly<Record<string, unknown>>;
    readonly nodePayloads: Readonly<Record<string, unknown>>;
  };
}

export interface StartTargetWorkflowOutput {
  readonly sessionId: string;
  /** Mirrors {@link import("./session").SessionStatus} (string union, keeps types acyclic). */
  readonly status: string;
}

export interface GetWorkflowStatusOutput {
  readonly sessionId: string;
  readonly status: string;
  readonly workflowId: string;
  readonly currentNodeId?: string;
  readonly lastError?: string;
}

export interface GetWorkflowExecutionDetailsOutput {
  readonly session: Readonly<Record<string, unknown>>;
}

export interface RerunTargetWorkflowOutput {
  readonly sessionId: string;
  readonly status: string;
}

export interface LoadWorkflowDefinitionOutput {
  readonly workflowId: string;
  readonly mutableWorkflowDir: string;
  /**
   * Normalized `workflow.json` object plus any node payload records the load path produced.
   * Shape follows `loadWorkflowFromDisk` bundle view used by the runtime.
   */
  readonly bundle: Readonly<Record<string, unknown>>;
}

export interface SaveWorkflowDefinitionOutput {
  readonly saved: true;
  readonly workflowId: string;
  readonly mutableWorkflowDir: string;
}

/**
 * Add-on `arguments` must include {@link SuperviserControlAuth} fields plus
 * the fields for the selected operation; see `superviser-control.ts` parsing helpers.
 */
export type StartTargetWorkflowControlArguments = SuperviserControlAuth &
  StartWorkflowAddonInput;
export type GetWorkflowStatusControlArguments = SuperviserControlAuth &
  GetWorkflowStatusAddonInput;
export type GetWorkflowExecutionDetailsControlArguments =
  SuperviserControlAuth & GetWorkflowExecutionDetailsAddonInput;
export type RerunWorkflowControlArguments = SuperviserControlAuth &
  RerunWorkflowAddonInput;
export type LoadWorkflowDefinitionControlArguments = SuperviserControlAuth &
  LoadWorkflowDefinitionAddonInput;
export type SaveWorkflowDefinitionControlArguments = SuperviserControlAuth &
  SaveWorkflowDefinitionAddonInput;

/**
 * Locates a workflow bundle the superviser may mutate. For `execution-copy`, files live under
 * the artifact root; `in-place` reuses the canonical source directory (design-auto-improve-superviser-mode).
 */
export interface MutableWorkflowWorkspace {
  readonly workflowId: string;
  readonly sourceWorkflowDir: string;
  readonly mutableWorkflowDir: string;
  readonly mutationMode: "execution-copy" | "in-place";
}

/**
 * Provenance for a superviser-driven workflow definition patch (impl-plan: revision tracking).
 */
export interface WorkflowPatchRevisionInput {
  readonly supervisionRunId: string;
  readonly mutableWorkflowDir: string;
  readonly reason: string;
  readonly patchedByStepId: string;
}

/**
 * A recorded patch revision stored under
 * `<artifactRoot>/supervision/<supervisionRunId>/patch-revisions.json`.
 */
export interface WorkflowPatchRevisionRecord {
  readonly patchRevisionId: string;
  readonly recordedAt: string;
  readonly reason: string;
  readonly patchedByStepId: string;
  readonly mutableWorkflowDir: string;
}
