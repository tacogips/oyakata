import type {
  ChatReplyDispatcher,
  AutoImprovePolicy,
  LoadOptions,
} from "./types";
import type {
  CommunicationRecord,
  NodeExecutionRecord,
  WorkflowSessionState,
} from "./session";
import type { SessionStoreOptions } from "./session-store";
import type { OutputRef } from "./session";
import type { SuperviserRuntimeControl } from "./superviser-control";
import type { MockNodeScenario } from "./adapter";
import { err, ok, type Result } from "./result";
import type { JsonSchemaValidationError } from "./json-schema";

export interface WorkflowRunOptions extends LoadOptions, SessionStoreOptions {
  readonly sessionId?: string;
  readonly workflowWorkingDirectory?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  readonly dryRun?: boolean;
  readonly eventReplyDispatcher?: ChatReplyDispatcher;
  readonly superviserControl?: SuperviserRuntimeControl;
  readonly mockScenario?: MockNodeScenario;
  readonly autoImprove?: AutoImprovePolicy;
  readonly supervisionLoopExecution?: boolean;
  readonly nestedSuperviserDriver?: boolean;
  readonly resumeSessionId?: string;
  readonly rerunFromSessionId?: string;
  readonly rerunFromStepId?: string;
  readonly continueFromWorkflowExecutionId?: string;
  readonly continueAfterStepRunId?: string;
  readonly continueStartStepId?: string;
  readonly restartOnStuck?: boolean;
  readonly maxStuckRestarts?: number;
  readonly stuckRestartBackoffMs?: number;
}

export interface WorkflowRunResult {
  readonly session: WorkflowSessionState;
  readonly exitCode: number;
}

export interface WorkflowRunFailure {
  readonly exitCode: number;
  readonly message: string;
  readonly sessionId?: string;
}

export function workflowRunFailure(
  code: number,
  message: string,
  session?: Pick<WorkflowSessionState, "sessionId">,
): WorkflowRunFailure {
  return {
    exitCode: code,
    message,
    ...(session === undefined ? {} : { sessionId: session.sessionId }),
  };
}

export interface CancellationProbe {
  isCancelled(sessionId: string): Promise<boolean>;
}

export interface EngineExecutionGuards {
  readonly cancellationProbe: CancellationProbe;
}

export interface UpstreamOutputRef extends OutputRef {
  readonly fromNodeId: string;
  readonly transitionWhen: string;
  readonly status:
    | NodeExecutionRecord["status"]
    | CommunicationRecord["status"];
  readonly communicationId: string;
}

export interface UpstreamInput extends UpstreamOutputRef {
  readonly output: Readonly<Record<string, unknown>>;
  readonly outputRaw: string;
}

export interface OutputArtifact {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly raw: string;
}

export interface CandidatePayloadResolutionError {
  readonly message: string;
  readonly retryable: boolean;
}

export interface CrossWorkflowDispatchExecutionResult {
  readonly communications: readonly CommunicationRecord[];
  readonly communicationCounter: number;
  readonly queuedNodeIds: readonly string[];
  readonly transitions: readonly {
    readonly from: string;
    readonly to: string;
    readonly when: string;
  }[];
}

export type RunWorkflowInternalFn = (
  workflowName: string,
  options: WorkflowRunOptions,
  adapter: import("./adapter").NodeAdapter | undefined,
  guards: EngineExecutionGuards | undefined,
  crossWorkflowInvocationStack: readonly string[],
) => Promise<Result<WorkflowRunResult, WorkflowRunFailure>>;

export type RunWorkflowFn = (
  workflowName: string,
  options: WorkflowRunOptions,
  adapter?: import("./adapter").NodeAdapter,
  guards?: EngineExecutionGuards,
) => Promise<Result<WorkflowRunResult, WorkflowRunFailure>>;

export { err, ok };
export type { Result, JsonSchemaValidationError };
