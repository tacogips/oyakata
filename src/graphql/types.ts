import type { MockNodeScenario } from "../workflow/adapter";
import type {
  CommunicationGraphqlView,
  CommunicationLookupInput,
  ReplayCommunicationResult,
  RetryCommunicationDeliveryResult,
} from "../workflow/communication-service";
import type { WorkflowInspectionSummary } from "../workflow/inspect";
import type {
  ManagerControlAction,
} from "../workflow/manager-control";
import type {
  DataDirFileRef,
  ManagerMessageService,
  SendManagerMessageResult,
} from "../workflow/manager-message-service";
import type {
  AmbientManagerExecutionContext,
  ManagerMessageRecord,
  ManagerSessionRecord,
  ManagerSessionStore,
} from "../workflow/manager-session-store";
import type {
  RuntimeNodeExecutionSummary,
  RuntimeNodeLogEntry,
} from "../workflow/runtime-db";
import type { SessionStoreOptions } from "../workflow/session-store";
import type { NodeExecutionRecord, WorkflowSessionState } from "../workflow/session";
import type { LoadOptions } from "../workflow/types";
import type {
  CommunicationService,
} from "../workflow/communication-service";

export interface GraphqlRequestContext extends SessionStoreOptions {
  readonly authToken?: string;
  readonly managerSessionId?: string;
}

export interface WorkflowLookupInput {
  readonly workflowName: string;
}

export interface WorkflowExecutionLookupInput {
  readonly workflowExecutionId: string;
}

export interface NodeExecutionLookupInput {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly recentLogLimit?: number;
}

export interface ManagerSessionLookupInput {
  readonly managerSessionId?: string;
}

export interface CommunicationsQueryInput {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly fromNodeId?: string;
  readonly toNodeId?: string;
  readonly status?: WorkflowSessionState["communications"][number]["status"];
  readonly first?: number;
  readonly afterCommunicationId?: string;
}

export interface WorkflowView extends WorkflowInspectionSummary {}

export interface WorkflowExecutionView {
  readonly workflowExecutionId: string;
  readonly session: WorkflowSessionState;
  readonly nodeExecutions: readonly RuntimeNodeExecutionSummary[];
  readonly nodeLogs: readonly RuntimeNodeLogEntry[];
}

export interface NodeExecutionView {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly status: NodeExecutionRecord["status"];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly attempt?: number;
  readonly outputAttemptCount?: number;
  readonly outputValidationErrors?: readonly {
    readonly path: string;
    readonly message: string;
  }[];
  readonly backendSessionId?: string;
  readonly backendSessionMode?: "new" | "reuse";
  readonly restartedFromNodeExecId?: string;
  readonly artifactDir: string;
  readonly output: string | null;
  readonly meta: string | null;
  readonly terminalMessage: string | null;
  readonly recentLogs: readonly RuntimeNodeLogEntry[];
}

export interface CommunicationConnection {
  readonly items: readonly CommunicationGraphqlView[];
  readonly totalCount: number;
  readonly nextCursor?: string;
}

export interface ManagerSessionView {
  readonly session: ManagerSessionRecord;
  readonly messages: readonly ManagerMessageRecord[];
}

export interface ExecuteWorkflowInput {
  readonly workflowName: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly dryRun?: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
}

export interface ExecuteWorkflowPayload {
  readonly workflowExecutionId: string;
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
  readonly exitCode: number;
}

export interface ResumeWorkflowExecutionInput {
  readonly workflowExecutionId: string;
}

export interface ResumeWorkflowExecutionPayload {
  readonly workflowExecutionId: string;
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
  readonly exitCode: number;
}

export interface RerunWorkflowExecutionInput {
  readonly workflowExecutionId: string;
  readonly nodeId: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly dryRun?: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
}

export interface RerunWorkflowExecutionPayload {
  readonly workflowExecutionId: string;
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
  readonly exitCode: number;
}

export interface CancelWorkflowExecutionInput {
  readonly workflowExecutionId: string;
}

export interface CancelWorkflowExecutionPayload {
  readonly accepted: boolean;
  readonly workflowExecutionId: string;
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
}

export interface SendManagerMessageInput {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly message?: string;
  readonly actions?: readonly ManagerControlAction[];
  readonly attachments?: readonly DataDirFileRef[];
  readonly idempotencyKey?: string;
  readonly managerSessionId?: string;
  readonly managerNodeId?: string;
  readonly managerNodeExecId?: string;
}

export interface SendManagerMessagePayload extends SendManagerMessageResult {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly managerSessionId: string;
}

export interface ReplayCommunicationInput extends CommunicationLookupInput {
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly managerSessionId?: string;
}

export interface ReplayCommunicationPayload
  extends ReplayCommunicationResult {}

export interface RetryCommunicationDeliveryInput
  extends CommunicationLookupInput {
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly managerSessionId?: string;
}

export interface RetryCommunicationDeliveryPayload
  extends RetryCommunicationDeliveryResult {}

export interface GraphqlManagerScope {
  readonly context: AmbientManagerExecutionContext | null;
  readonly session: ManagerSessionRecord;
}

export interface GraphqlSchemaDependencies {
  readonly now?: () => string;
  readonly communicationService?: CommunicationService;
  readonly managerMessageService?: ManagerMessageService;
  readonly managerSessionStore?: ManagerSessionStore;
}

export interface GraphqlQueryRoot {
  workflow(
    input: WorkflowLookupInput,
    context?: GraphqlRequestContext,
  ): Promise<WorkflowView | null>;
  workflowExecution(
    input: WorkflowExecutionLookupInput,
    context?: GraphqlRequestContext,
  ): Promise<WorkflowExecutionView | null>;
  communications(
    input: CommunicationsQueryInput,
    context?: GraphqlRequestContext,
  ): Promise<CommunicationConnection>;
  communication(
    input: CommunicationLookupInput,
    context?: GraphqlRequestContext,
  ): Promise<CommunicationGraphqlView | null>;
  nodeExecution(
    input: NodeExecutionLookupInput,
    context?: GraphqlRequestContext,
  ): Promise<NodeExecutionView | null>;
  managerSession(
    input: ManagerSessionLookupInput,
    context?: GraphqlRequestContext,
  ): Promise<ManagerSessionView | null>;
}

export interface GraphqlMutationRoot {
  executeWorkflow(
    input: ExecuteWorkflowInput,
    context?: GraphqlRequestContext,
  ): Promise<ExecuteWorkflowPayload>;
  resumeWorkflowExecution(
    input: ResumeWorkflowExecutionInput,
    context?: GraphqlRequestContext,
  ): Promise<ResumeWorkflowExecutionPayload>;
  rerunWorkflowExecution(
    input: RerunWorkflowExecutionInput,
    context?: GraphqlRequestContext,
  ): Promise<RerunWorkflowExecutionPayload>;
  sendManagerMessage(
    input: SendManagerMessageInput,
    context?: GraphqlRequestContext,
  ): Promise<SendManagerMessagePayload>;
  retryCommunicationDelivery(
    input: RetryCommunicationDeliveryInput,
    context?: GraphqlRequestContext,
  ): Promise<RetryCommunicationDeliveryPayload>;
  replayCommunication(
    input: ReplayCommunicationInput,
    context?: GraphqlRequestContext,
  ): Promise<ReplayCommunicationPayload>;
  cancelWorkflowExecution(
    input: CancelWorkflowExecutionInput,
    context?: GraphqlRequestContext,
  ): Promise<CancelWorkflowExecutionPayload>;
}

export interface GraphqlSchema {
  readonly query: GraphqlQueryRoot;
  readonly mutation: GraphqlMutationRoot;
}

export interface GraphqlExecutionOverrides extends LoadOptions {
  readonly mockScenario?: MockNodeScenario;
}
