import type { NodeKind, WorkflowJson } from "./types";

export type ManagerControlActionType =
  | "start-sub-workflow"
  | "deliver-to-child-input"
  | "retry-node";

export interface StartSubWorkflowAction {
  readonly type: "start-sub-workflow";
  readonly subWorkflowId: string;
}

export interface DeliverToChildInputAction {
  readonly type: "deliver-to-child-input";
  readonly inputNodeId: string;
}

export interface RetryNodeAction {
  readonly type: "retry-node";
  readonly nodeId: string;
}

export type ManagerControlAction =
  | StartSubWorkflowAction
  | DeliverToChildInputAction
  | RetryNodeAction;

export interface ParsedManagerControl {
  readonly actions: readonly ManagerControlAction[];
  readonly startSubWorkflowIds: readonly string[];
  readonly childInputNodeIds: readonly string[];
  readonly retryNodeIds: readonly string[];
  readonly overridesRootSubWorkflowPlanning: boolean;
  readonly overridesChildInputPlanning: boolean;
}

export interface ManagerControlParseContext {
  readonly managerNodeId: string;
  readonly managerKind: NodeKind | undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Readonly<Record<string, unknown>>,
  fieldName: string,
  actionLabel: string,
): string {
  const fieldValue = value[fieldName];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`${actionLabel}.${fieldName} must be a non-empty string`);
  }
  return fieldValue;
}

function parseAction(value: unknown): ManagerControlAction {
  if (!isRecord(value)) {
    throw new Error("managerControl.actions[] must be an object");
  }

  const type = value["type"];
  if (typeof type !== "string") {
    throw new Error("managerControl.actions[].type must be a string");
  }

  switch (type) {
    case "start-sub-workflow":
      return {
        type,
        subWorkflowId: readStringField(value, "subWorkflowId", "managerControl.actions[]"),
      };
    case "deliver-to-child-input":
      return {
        type,
        inputNodeId: readStringField(value, "inputNodeId", "managerControl.actions[]"),
      };
    case "retry-node":
      return {
        type,
        nodeId: readStringField(value, "nodeId", "managerControl.actions[]"),
      };
    default:
      throw new Error(`managerControl.actions[].type '${type}' is not supported`);
  }
}

function dedupe(values: readonly string[]): readonly string[] {
  return values.filter((value, index, all) => all.indexOf(value) === index);
}

function findOwnedSubWorkflow(workflow: WorkflowJson, managerNodeId: string) {
  return workflow.subWorkflows.find((entry) => entry.managerNodeId === managerNodeId);
}

function getOwnedSubWorkflowForNode(workflow: WorkflowJson, nodeId: string) {
  return workflow.subWorkflows.find((entry) => entry.nodeIds.includes(nodeId));
}

export function parseManagerControlPayload(
  payload: Readonly<Record<string, unknown>>,
  workflow: WorkflowJson,
  context: ManagerControlParseContext,
): ParsedManagerControl | null {
  const managerControlRaw = payload["managerControl"];
  if (managerControlRaw === undefined) {
    return null;
  }
  if (!isRecord(managerControlRaw)) {
    throw new Error("payload.managerControl must be an object when provided");
  }

  const actionsRaw = managerControlRaw["actions"];
  if (actionsRaw === undefined) {
    return {
      actions: [],
      startSubWorkflowIds: [],
      childInputNodeIds: [],
      retryNodeIds: [],
      overridesRootSubWorkflowPlanning: true,
      overridesChildInputPlanning: true,
    };
  }
  if (!Array.isArray(actionsRaw)) {
    throw new Error("payload.managerControl.actions must be an array when provided");
  }

  const actions = actionsRaw.map((entry) => parseAction(entry));
  for (const action of actions) {
    if (action.type === "start-sub-workflow") {
      if (context.managerNodeId !== workflow.managerNodeId || context.managerKind !== "root-manager") {
        throw new Error("managerControl start-sub-workflow is only allowed for the root manager");
      }
      const subWorkflow = workflow.subWorkflows.find((entry) => entry.id === action.subWorkflowId);
      if (subWorkflow === undefined) {
        throw new Error(`managerControl references unknown sub-workflow '${action.subWorkflowId}'`);
      }
      continue;
    }

    if (action.type === "deliver-to-child-input") {
      if (context.managerKind !== "sub-manager") {
        throw new Error("managerControl deliver-to-child-input is only allowed for a sub-manager");
      }
      const node = workflow.nodes.find((entry) => entry.id === action.inputNodeId);
      if (node?.kind !== "input") {
        throw new Error(`managerControl input node '${action.inputNodeId}' must exist with kind 'input'`);
      }
      const ownedSubWorkflow = findOwnedSubWorkflow(workflow, context.managerNodeId);
      if (ownedSubWorkflow === undefined) {
        throw new Error(`manager node '${context.managerNodeId}' does not own a sub-workflow`);
      }
      if (ownedSubWorkflow.inputNodeId !== action.inputNodeId) {
        throw new Error(
          `managerControl input node '${action.inputNodeId}' must be the owned input node '${ownedSubWorkflow.inputNodeId}' for sub-manager '${context.managerNodeId}'`,
        );
      }
      continue;
    }

    const node = workflow.nodes.find((entry) => entry.id === action.nodeId);
    if (node === undefined) {
      throw new Error(`managerControl retry node '${action.nodeId}' does not exist`);
    }
    if (action.nodeId === context.managerNodeId) {
      throw new Error(`managerControl retry node '${action.nodeId}' cannot target the manager node itself`);
    }
    if (context.managerNodeId === workflow.managerNodeId) {
      const ownedSubWorkflow = getOwnedSubWorkflowForNode(workflow, action.nodeId);
      if (ownedSubWorkflow !== undefined) {
        throw new Error(
          `managerControl retry node '${action.nodeId}' is inside sub-workflow '${ownedSubWorkflow.id}'; root manager must re-invoke that sub-workflow with start-sub-workflow instead`,
        );
      }
    }
    if (context.managerKind === "sub-manager") {
      const ownedSubWorkflow = findOwnedSubWorkflow(workflow, context.managerNodeId);
      if (ownedSubWorkflow === undefined) {
        throw new Error(`manager node '${context.managerNodeId}' does not own a sub-workflow`);
      }
      if (!ownedSubWorkflow.nodeIds.includes(action.nodeId)) {
        throw new Error(
          `managerControl retry node '${action.nodeId}' must belong to sub-workflow '${ownedSubWorkflow.id}' owned by '${context.managerNodeId}'`,
        );
      }
    }
  }

  const startSubWorkflowIds = dedupe(
    actions.filter((entry): entry is StartSubWorkflowAction => entry.type === "start-sub-workflow").map((entry) => entry.subWorkflowId),
  );
  const childInputNodeIds = dedupe(
    actions
      .filter((entry): entry is DeliverToChildInputAction => entry.type === "deliver-to-child-input")
      .map((entry) => entry.inputNodeId),
  );
  const retryNodeIds = dedupe(
    actions.filter((entry): entry is RetryNodeAction => entry.type === "retry-node").map((entry) => entry.nodeId),
  );

  return {
    actions,
    startSubWorkflowIds,
    childInputNodeIds,
    retryNodeIds,
    overridesRootSubWorkflowPlanning: managerControlRaw["actions"] !== undefined,
    overridesChildInputPlanning: managerControlRaw["actions"] !== undefined,
  };
}
