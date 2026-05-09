import type {
  listEventReplyDispatchesFromRuntimeDb,
  listRuntimeHookEvents,
  listRuntimeNodeExecutions,
  listRuntimeNodeLogs,
} from "../workflow/runtime-db";
import type { MockNodeScenario } from "../workflow/adapter";
import type {
  AutoImprovePolicy,
  ChatReplyDispatcher,
  LoadOptions,
  WorkflowJson,
} from "../workflow/types";
import type {
  NodeExecutionRecord,
  WorkflowSessionState,
} from "../workflow/session";
import type { SessionStoreOptions } from "../workflow/session-store";
import type { CallStepInput } from "../workflow/call-step";

export type DivedraOptions = LoadOptions & SessionStoreOptions;

export interface ExecuteWorkflowInput extends DivedraOptions {
  readonly workflowName: string;
  readonly workflowWorkingDirectory?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly mockScenario?: MockNodeScenario;
  readonly dryRun?: boolean;
  readonly eventReplyDispatcher?: ChatReplyDispatcher;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  /**
   * Supervised execution: on a new run (not resume/rerun from library), the engine
   * seeds {@link WorkflowSessionState.supervision} and runs the supervision loop
   * (retry on terminal target failure) until success or `maxSupervisedAttempts`.
   */
  readonly autoImprove?: AutoImprovePolicy;
  /**
   * Phase-2: run the configured superviser workflow as a nested session (requires
   * `autoImprove`; see engine `runWorkflow` option `nestedSuperviserDriver`).
   * CLI: prefer `--supervisor-workflow` / `--nested-supervisor` (aliases for legacy
   * `--superviser-workflow` / `--nested-superviser`).
   */
  readonly nestedSuperviserDriver?: boolean;
}

export interface ResumeWorkflowInput extends DivedraOptions {
  readonly sessionId: string;
  readonly workflowWorkingDirectory?: string;
  readonly mockScenario?: MockNodeScenario;
  /** Merges into persisted supervision policy when the session was started with `autoImprove`. */
  readonly autoImprove?: AutoImprovePolicy;
  /**
   * When the session was started with `nestedSuperviserDriver`, pass `true` to continue the
   * nested superviser workflow (requires the same `autoImprove` policy shape as the original run).
   */
  readonly nestedSuperviserDriver?: boolean;
}

export interface RerunWorkflowInput extends DivedraOptions {
  readonly sourceSessionId: string;
  /** Rerun target as an authored step id. */
  readonly fromStepId: string;
  readonly workflowWorkingDirectory?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly mockScenario?: MockNodeScenario;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  readonly dryRun?: boolean;
  readonly autoImprove?: AutoImprovePolicy;
}

export interface ContinueWorkflowFromHistoryInput extends DivedraOptions {
  readonly sourceWorkflowExecutionId: string;
  /** Inclusive imported-history boundary (`nodeExecId` / step-run id). */
  readonly afterStepRunId: string;
  /** Entry step id for the new workflow execution. */
  readonly startStepId: string;
  readonly workflowWorkingDirectory?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly mockScenario?: MockNodeScenario;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  readonly dryRun?: boolean;
  readonly autoImprove?: AutoImprovePolicy;
  readonly nestedSuperviserDriver?: boolean;
}

/** Merged timeline view for CLI / GraphQL step-run listings (TASK-003 / TASK-004). */
export interface MergedWorkflowExecutionStepRunRow {
  readonly timelineOrdinal: number;
  readonly executionOrdinal: number;
  readonly persistedWorkflowExecutionId: string;
  readonly stepRunId: string;
  readonly stepId: string | undefined;
  readonly nodeRegistryId: string | undefined;
  readonly status: NodeExecutionRecord["status"];
  readonly imported: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface RuntimeSessionView {
  readonly session: WorkflowSessionState & {
    readonly currentStepId: string | null;
  };
  readonly nodeExecutions: ReturnType<
    typeof listRuntimeNodeExecutions
  > extends Promise<infer T>
    ? T
    : never;
  readonly nodeLogs: ReturnType<typeof listRuntimeNodeLogs> extends Promise<
    infer T
  >
    ? T
    : never;
  readonly hookEvents?: ReturnType<
    typeof listRuntimeHookEvents
  > extends Promise<infer T>
    ? T
    : never;
  readonly replyDispatches?: ReturnType<
    typeof listEventReplyDispatchesFromRuntimeDb
  > extends Promise<infer T>
    ? T
    : never;
}

export interface CallWorkflowStepInput extends CallStepInput {}

export interface WorkflowExecutionClientOptions extends DivedraOptions {
  readonly workflowName: string;
  readonly endpoint?: string;
  readonly authToken?: string;
  readonly managerSessionId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly eventReplyDispatcher?: ChatReplyDispatcher;
}

export interface WorkflowExecutionClientRequest {
  readonly input?: Readonly<Record<string, unknown>>;
  readonly workingDirectory?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly mockScenario?: MockNodeScenario;
  readonly async?: boolean;
  readonly dryRun?: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
}

export interface WorkflowExecutionClientResult {
  readonly workflowName: string;
  readonly workflowExecutionId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly accepted?: boolean;
  readonly exitCode?: number;
}

export interface WorkflowExecutionClient {
  readonly workflowName: string;
  execute(
    request?: WorkflowExecutionClientRequest,
  ): Promise<WorkflowExecutionClientResult>;
}

export interface CurrentStepWorkflowView {
  readonly workflowId: string;
  readonly steps?: WorkflowJson["steps"];
}
