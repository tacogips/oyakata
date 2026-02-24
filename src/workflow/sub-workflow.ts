import type { NodeExecutionRecord, WorkflowSessionState } from "./session";
import type { SubWorkflowInputSource, SubWorkflowRef, WorkflowJson } from "./types";

function findLatestSucceededExecution(
  session: WorkflowSessionState,
  nodeId: string,
): NodeExecutionRecord | undefined {
  return [...session.nodeExecutions].reverse().find((entry) => entry.nodeId === nodeId && entry.status === "succeeded");
}

function sourceSatisfied(
  source: SubWorkflowInputSource,
  workflow: WorkflowJson,
  session: WorkflowSessionState,
): boolean {
  if (source.type === "human-input") {
    return session.runtimeVariables["humanInput"] !== undefined;
  }
  if (source.type === "workflow-output") {
    return session.runtimeVariables["workflowOutput"] !== undefined;
  }
  if (source.type === "node-output") {
    if (source.nodeId === undefined) {
      return false;
    }
    return findLatestSucceededExecution(session, source.nodeId) !== undefined;
  }
  if (source.type === "sub-workflow-output") {
    if (source.subWorkflowId === undefined) {
      return false;
    }
    const referenced = workflow.subWorkflows.find((entry) => entry.id === source.subWorkflowId);
    if (referenced === undefined) {
      return false;
    }
    return findLatestSucceededExecution(session, referenced.outputNodeId) !== undefined;
  }
  return false;
}

function subWorkflowAlreadyStarted(subWorkflow: SubWorkflowRef, session: WorkflowSessionState): boolean {
  return session.nodeExecutions.some((entry) => entry.nodeId === subWorkflow.inputNodeId);
}

function subWorkflowReady(subWorkflow: SubWorkflowRef, workflow: WorkflowJson, session: WorkflowSessionState): boolean {
  if (subWorkflow.inputSources.length === 0) {
    return true;
  }
  return subWorkflow.inputSources.every((source) => sourceSatisfied(source, workflow, session));
}

export function planManagerSubWorkflowInputs(args: {
  readonly workflow: WorkflowJson;
  readonly session: WorkflowSessionState;
}): readonly string[] {
  const planned: string[] = [];
  for (const subWorkflow of args.workflow.subWorkflows) {
    if (subWorkflowAlreadyStarted(subWorkflow, args.session)) {
      continue;
    }
    if (!subWorkflowReady(subWorkflow, args.workflow, args.session)) {
      continue;
    }
    planned.push(subWorkflow.inputNodeId);
  }
  return planned;
}
