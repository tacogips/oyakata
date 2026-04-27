import {
  type AgentNodePayload,
  type WorkflowJson,
} from "./types";

export interface StepIdentityFields {
  readonly stepId?: string;
  readonly nodeRegistryId?: string;
}

export interface StepExecutionAddress extends StepIdentityFields {
  readonly promptVariant?: string;
  readonly timeoutMs?: number;
  readonly inheritFromStepId?: string;
}

export interface BackendSessionSelection extends StepIdentityFields {
  readonly sessionLookupNodeId?: string;
  readonly inheritFromStepId?: string;
  readonly promptVariant?: string;
}

export function resolveStepExecutionAddress(
  workflow: WorkflowJson,
  runtimeNodeId: string,
): StepExecutionAddress {
  const step = workflow.steps?.find((entry) => entry.id === runtimeNodeId);
  return {
    ...(step?.id === undefined ? {} : { stepId: step.id }),
    ...(step?.nodeId === undefined ? {} : { nodeRegistryId: step.nodeId }),
    ...(step?.promptVariant === undefined
      ? {}
      : { promptVariant: step.promptVariant }),
    ...(step?.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    ...(step?.sessionPolicy?.inheritFromStepId === undefined
      ? {}
      : { inheritFromStepId: step.sessionPolicy.inheritFromStepId }),
  };
}

export function toStepIdentityFields(
  input: StepIdentityFields,
): StepIdentityFields {
  return {
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    ...(input.nodeRegistryId === undefined
      ? {}
      : { nodeRegistryId: input.nodeRegistryId }),
  };
}

export function resolveBackendSessionSelection(
  stepExecutionAddress: StepExecutionAddress,
  node: AgentNodePayload,
): BackendSessionSelection {
  if (node.sessionPolicy?.mode !== "reuse") {
    return {};
  }

  return {
    sessionLookupNodeId: stepExecutionAddress.inheritFromStepId ?? node.id,
    ...(stepExecutionAddress.inheritFromStepId === undefined
      ? {}
      : { inheritFromStepId: stepExecutionAddress.inheritFromStepId }),
    ...toStepIdentityFields(stepExecutionAddress),
    ...(stepExecutionAddress.promptVariant === undefined
      ? {}
      : { promptVariant: stepExecutionAddress.promptVariant }),
  };
}

/**
 * True when `runtimeNodeId` matches a workflow node ref with kind `output`.
 * Used for workflow-output runtime variables and external publication selection.
 * This is unrelated to which manager runtime id is recorded on communication
 * delivery metadata (`deliveredByNodeId`).
 */
export function isWorkflowOutputKindNode(
  workflow: WorkflowJson,
  runtimeNodeId: string,
): boolean {
  const node = workflow.nodes.find((entry) => entry.id === runtimeNodeId);
  return node?.kind === "output";
}
