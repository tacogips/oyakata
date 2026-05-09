import type {
  ManagedWorkflowRunRecord,
  SupervisorDispatchDecisionRecord,
  WorkflowSupervisorConversationRecord,
} from "../events/supervisor-conversations";
import type { DispatchProposalValidationIssue } from "../events/supervisor-dispatch-contract";
import type { SupervisorDispatchProposal } from "../events/supervisor-dispatch-contract";
import type {
  EventBinding,
  EventSourceConfig,
  ExternalEventEnvelope,
} from "../events/types";
import type { WorkflowTriggerRunnerOptions } from "../events/workflow-trigger-runner-options";
import type { LoadOptions } from "./types";

export interface DispatchSupervisorConversationInput extends LoadOptions {
  readonly eventRoot: string;
  readonly binding: EventBinding;
  readonly event: ExternalEventEnvelope;
  readonly source?: EventSourceConfig;
  readonly supervisorProfileId: string;
  readonly sourceMessageId: string;
  readonly correlationKey: string;
  readonly mockScenario?: WorkflowTriggerRunnerOptions["mockScenario"];
  readonly dryRun?: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  readonly endpoint?: string;
  readonly authToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly readOnly?: boolean;
  readonly eventReplyDispatcher?: WorkflowTriggerRunnerOptions["eventReplyDispatcher"];
  readonly supervisorClient?: WorkflowTriggerRunnerOptions["supervisorClient"];
}

export interface WorkflowSupervisorDispatchView {
  readonly conversation: WorkflowSupervisorConversationRecord;
  readonly managedRuns: readonly ManagedWorkflowRunRecord[];
  readonly decision: SupervisorDispatchDecisionRecord;
  readonly proposal: SupervisorDispatchProposal;
  readonly applied: boolean;
  readonly validationIssues?: readonly DispatchProposalValidationIssue[];
}

export interface WorkflowSupervisorDispatchClient {
  dispatchExternalInput(
    input: DispatchSupervisorConversationInput,
  ): Promise<WorkflowSupervisorDispatchView>;
}

export interface StartManagedWorkflowInput {
  readonly supervisorConversationId: string;
  readonly managedWorkflowKey: string;
  readonly runAlias?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
}

export interface SubmitManagedWorkflowInput {
  readonly supervisorConversationId: string;
  readonly managedRunId: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
}

export interface StopManagedWorkflowInput {
  readonly supervisorConversationId: string;
  readonly managedRunId: string;
  readonly reason?: string;
}

export interface SupervisorRuntimeCapabilitySet {
  startManagedWorkflow(
    input: StartManagedWorkflowInput,
  ): Promise<ManagedWorkflowRunRecord>;
  submitManagedInput(
    input: SubmitManagedWorkflowInput,
  ): Promise<ManagedWorkflowRunRecord>;
  stopManagedWorkflow(
    input: StopManagedWorkflowInput,
  ): Promise<ManagedWorkflowRunRecord>;
}
