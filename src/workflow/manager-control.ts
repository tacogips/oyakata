import type { CommunicationRecord } from "./session";
import type { NodeKind, NodeRole, WorkflowJson } from "./types";

export type ManagerControlActionType =
  | "planner-note"
  | "retry-step"
  | "replay-communication"
  | "execute-optional-step"
  | "skip-optional-step";

export interface PlannerNoteAction {
  readonly type: "planner-note";
}

export interface RetryStepAction {
  readonly type: "retry-step";
  readonly stepId: string;
}

export interface ReplayCommunicationAction {
  readonly type: "replay-communication";
  readonly communicationId: string;
  readonly reason?: string;
}

export interface ExecuteOptionalStepAction {
  readonly type: "execute-optional-step";
  readonly stepId: string;
}

export interface SkipOptionalStepAction {
  readonly type: "skip-optional-step";
  readonly stepId: string;
  readonly reason?: string;
}

export type ManagerControlAction =
  | PlannerNoteAction
  | RetryStepAction
  | ReplayCommunicationAction
  | ExecuteOptionalStepAction
  | SkipOptionalStepAction;

export interface ParsedManagerControl {
  readonly actions: readonly ManagerControlAction[];
  readonly retryStepIds: readonly string[];
  readonly replayCommunicationIds: readonly string[];
  readonly executeOptionalStepIds: readonly string[];
  readonly skipOptionalStepIds: readonly string[];
}

export interface ManagerControlParseContext {
  readonly managerNodeId: string;
  readonly managerKind: NodeKind | undefined;
  readonly managerRole?: NodeRole;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedStringField(
  value: Readonly<Record<string, unknown>>,
  fieldName: string,
  actionLabel: string,
): string {
  const fieldValue = value[fieldName];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`${actionLabel}.${fieldName} must be a non-empty string`);
  }
  return fieldValue.trim();
}

function readOptionalTrimmedStringField(
  value: Readonly<Record<string, unknown>>,
  fieldName: string,
  actionLabel: string,
): string | undefined {
  const fieldValue = value[fieldName];
  if (fieldValue === undefined) {
    return undefined;
  }
  if (typeof fieldValue !== "string") {
    throw new Error(`${actionLabel}.${fieldName} must be a string when provided`);
  }
  const trimmed = fieldValue.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function parseManagerControlActionInput(
  value: unknown,
): ManagerControlAction {
  if (!isRecord(value)) {
    throw new Error("managerControl.actions[] must be an object");
  }

  const type = value["type"];
  if (typeof type !== "string") {
    throw new Error("managerControl.actions[].type must be a string");
  }

  switch (type) {
    case "planner-note":
      return {
        type,
      };
    case "retry-step":
      return {
        type: "retry-step",
        stepId: readTrimmedStringField(
          value,
          "stepId",
          "managerControl.actions[]",
        ),
      };
    case "execute-optional-step":
      return {
        type: "execute-optional-step",
        stepId: readTrimmedStringField(
          value,
          "stepId",
          "managerControl.actions[]",
        ),
      };
    case "skip-optional-step": {
      const reason = readOptionalTrimmedStringField(
        value,
        "reason",
        "managerControl.actions[]",
      );
      return {
        type: "skip-optional-step",
        stepId: readTrimmedStringField(
          value,
          "stepId",
          "managerControl.actions[]",
        ),
        ...(reason === undefined ? {} : { reason }),
      };
    }
    case "replay-communication": {
      const reason = readOptionalTrimmedStringField(
        value,
        "reason",
        "managerControl.actions[]",
      );
      return {
        type,
        communicationId: readTrimmedStringField(
          value,
          "communicationId",
          "managerControl.actions[]",
        ),
        ...(reason === undefined ? {} : { reason }),
      };
    }
    default:
      throw new Error(
        `managerControl.actions[].type '${type}' is not supported`,
      );
  }
}

function dedupe(values: readonly string[]): readonly string[] {
  return values.filter((value, index, all) => all.indexOf(value) === index);
}

function findOwnedSubWorkflow(workflow: WorkflowJson, managerNodeId: string) {
  return workflow.subWorkflows.find(
    (entry) => entry.managerNodeId === managerNodeId,
  );
}

function getOwnedSubWorkflowForNode(workflow: WorkflowJson, nodeId: string) {
  return workflow.subWorkflows.find((entry) => entry.nodeIds.includes(nodeId));
}

function isRootManagerControlContext(
  workflow: WorkflowJson,
  context: ManagerControlParseContext,
): boolean {
  return (
    context.managerNodeId === workflow.managerNodeId &&
    context.managerKind !== "subworkflow-manager" &&
    context.managerRole !== "worker"
  );
}

function isSubworkflowManagerControlContext(
  context: ManagerControlParseContext,
): boolean {
  return context.managerKind === "subworkflow-manager";
}

function assertOptionalStepDecisionScope(
  workflow: WorkflowJson,
  context: ManagerControlParseContext,
  stepId: string,
  actionType: "execute-optional-step" | "skip-optional-step",
): void {
  const node = workflow.nodes.find((entry) => entry.id === stepId);
  if (node === undefined) {
    throw new Error(
      `managerControl ${actionType} step '${stepId}' does not exist`,
    );
  }
  if (node.id === context.managerNodeId) {
    throw new Error(
      `managerControl ${actionType} step '${stepId}' cannot target the manager node itself`,
    );
  }
  if (node.execution?.mode !== "optional") {
    throw new Error(
      `managerControl ${actionType} step '${stepId}' must reference a node with workflow execution.mode 'optional'`,
    );
  }

  if (isRootManagerControlContext(workflow, context)) {
    const ownedSubWorkflow = getOwnedSubWorkflowForNode(workflow, stepId);
    if (ownedSubWorkflow !== undefined) {
      throw new Error(
        `managerControl ${actionType} step '${stepId}' is inside sub-workflow '${ownedSubWorkflow.id}'; use the owning subworkflow-manager instead`,
      );
    }
    return;
  }

  if (isSubworkflowManagerControlContext(context)) {
    const ownedSubWorkflow = findOwnedSubWorkflow(
      workflow,
      context.managerNodeId,
    );
    if (ownedSubWorkflow === undefined) {
      throw new Error(
        `manager node '${context.managerNodeId}' does not own a sub-workflow`,
      );
    }
    if (!ownedSubWorkflow.nodeIds.includes(stepId)) {
      throw new Error(
        `managerControl ${actionType} step '${stepId}' must belong to sub-workflow '${ownedSubWorkflow.id}' owned by '${context.managerNodeId}'`,
      );
    }
    return;
  }

  throw new Error(
    `manager node '${context.managerNodeId}' does not have a recognized control scope`,
  );
}

function resolveEffectiveCommunicationScope(
  communication: CommunicationRecord,
  workflow: WorkflowJson,
): {
  readonly fromSubWorkflowId?: string;
  readonly toSubWorkflowId?: string;
} {
  const fromSubWorkflowId =
    communication.fromSubWorkflowId ??
    getOwnedSubWorkflowForNode(workflow, communication.fromNodeId)?.id;
  const toSubWorkflowId =
    communication.toSubWorkflowId ??
    getOwnedSubWorkflowForNode(workflow, communication.toNodeId)?.id;
  return {
    ...(fromSubWorkflowId === undefined ? {} : { fromSubWorkflowId }),
    ...(toSubWorkflowId === undefined ? {} : { toSubWorkflowId }),
  };
}

export function assertCommunicationInManagerScope(
  communication: CommunicationRecord,
  workflow: WorkflowJson,
  context: ManagerControlParseContext,
  operationLabel = "managerControl",
): void {
  const effectiveScope = resolveEffectiveCommunicationScope(
    communication,
    workflow,
  );

  if (isSubworkflowManagerControlContext(context)) {
    const ownedSubWorkflow = findOwnedSubWorkflow(
      workflow,
      context.managerNodeId,
    );
    if (ownedSubWorkflow === undefined) {
      throw new Error(
        `manager node '${context.managerNodeId}' does not own a sub-workflow`,
      );
    }
    if (
      effectiveScope.fromSubWorkflowId !== ownedSubWorkflow.id ||
      effectiveScope.toSubWorkflowId !== ownedSubWorkflow.id
    ) {
      throw new Error(
        `${operationLabel} communication '${communication.communicationId}' must stay within sub-workflow '${ownedSubWorkflow.id}' owned by '${context.managerNodeId}'`,
      );
    }
    return;
  }

  if (isRootManagerControlContext(workflow, context)) {
    if (
      effectiveScope.fromSubWorkflowId !== undefined ||
      effectiveScope.toSubWorkflowId !== undefined
    ) {
      throw new Error(
        `${operationLabel} communication '${communication.communicationId}' is outside root-manager scope; re-invoke the sub-workflow or use the owning subworkflow-manager`,
      );
    }
    return;
  }

  throw new Error(
    `manager node '${context.managerNodeId}' does not have a recognized control scope`,
  );
}

export function parseManagerControlActions(
  actionsRaw: readonly unknown[],
  workflow: WorkflowJson,
  context: ManagerControlParseContext,
): ParsedManagerControl {
  const actions = actionsRaw.map((entry) =>
    parseManagerControlActionInput(entry),
  );
  for (const action of actions) {
    if (action.type === "planner-note") {
      continue;
    }

    if (action.type === "replay-communication") {
      continue;
    }

    if (
      action.type === "execute-optional-step" ||
      action.type === "skip-optional-step"
    ) {
      assertOptionalStepDecisionScope(
        workflow,
        context,
        action.stepId,
        action.type,
      );
      continue;
    }

    const node = workflow.nodes.find((entry) => entry.id === action.stepId);
    if (node === undefined) {
      throw new Error(
        `managerControl retry step '${action.stepId}' does not exist`,
      );
    }
    if (action.stepId === context.managerNodeId) {
      throw new Error(
        `managerControl retry step '${action.stepId}' cannot target the manager node itself`,
      );
    }
    if (isSubworkflowManagerControlContext(context)) {
      const ownedSubWorkflow = findOwnedSubWorkflow(
        workflow,
        context.managerNodeId,
      );
      if (ownedSubWorkflow === undefined) {
        throw new Error(
          `manager node '${context.managerNodeId}' does not own a sub-workflow`,
        );
      }
      if (!ownedSubWorkflow.nodeIds.includes(action.stepId)) {
        throw new Error(
          `managerControl retry step '${action.stepId}' must belong to sub-workflow '${ownedSubWorkflow.id}' owned by '${context.managerNodeId}'`,
        );
      }
    }
  }

  const retryStepIds = dedupe(
    actions
      .filter((entry): entry is RetryStepAction => entry.type === "retry-step")
      .map((entry) => entry.stepId),
  );
  const replayCommunicationIds = dedupe(
    actions
      .filter(
        (entry): entry is ReplayCommunicationAction =>
          entry.type === "replay-communication",
      )
      .map((entry) => entry.communicationId),
  );
  const executeOptionalStepIds = dedupe(
    actions
      .filter(
        (entry): entry is ExecuteOptionalStepAction =>
          entry.type === "execute-optional-step",
      )
      .map((entry) => entry.stepId),
  );
  const skipOptionalStepIds = dedupe(
    actions
      .filter(
        (entry): entry is SkipOptionalStepAction =>
          entry.type === "skip-optional-step",
      )
      .map((entry) => entry.stepId),
  );

  return {
    actions,
    retryStepIds,
    replayCommunicationIds,
    executeOptionalStepIds,
    skipOptionalStepIds,
  };
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
      retryStepIds: [],
      replayCommunicationIds: [],
      executeOptionalStepIds: [],
      skipOptionalStepIds: [],
    };
  }
  if (!Array.isArray(actionsRaw)) {
    throw new Error(
      "payload.managerControl.actions must be an array when provided",
    );
  }

  return parseManagerControlActions(actionsRaw, workflow, context);
}
