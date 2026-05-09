import type { WorkflowJson } from "./types";
import type {
  PendingOptionalNodeDecision,
  WorkflowSessionState,
  NodeExecutionRecord,
} from "./session";
import type { ParsedManagerControl } from "./manager-control";
import { isWorkflowOutputKindNode } from "./runtime-addressing";
import { resolveWorkflowManagerStepId } from "./types";
import { err, ok, type Result } from "./engine-types";

export function findNodeRef(workflow: WorkflowJson, nodeId: string) {
  return workflow.nodes.find((entry) => entry.id === nodeId);
}

export function isOptionalNode(
  workflow: WorkflowJson,
  nodeId: string,
): boolean {
  return findNodeRef(workflow, nodeId)?.execution?.mode === "optional";
}

export function findOwningManagerNodeId(
  workflow: WorkflowJson,
  _nodeId: string,
): string {
  return resolveWorkflowManagerStepId(workflow);
}

export function dedupeNodeIds(nodeIds: readonly string[]): readonly string[] {
  return nodeIds.filter((value, index, all) => all.indexOf(value) === index);
}

export function upsertPendingOptionalNodeDecision(
  decisions: readonly PendingOptionalNodeDecision[],
  decision: PendingOptionalNodeDecision,
): readonly PendingOptionalNodeDecision[] {
  return [
    ...decisions.filter((entry) => entry.nodeId !== decision.nodeId),
    decision,
  ];
}

export function removePendingOptionalNodeDecision(
  decisions: readonly PendingOptionalNodeDecision[],
  nodeId: string,
): readonly PendingOptionalNodeDecision[] {
  return decisions.filter((entry) => entry.nodeId !== nodeId);
}

export function findPendingOptionalNodeDecision(
  session: WorkflowSessionState,
  nodeId: string,
): PendingOptionalNodeDecision | undefined {
  return session.pendingOptionalNodeDecisions?.find(
    (entry) => entry.nodeId === nodeId,
  );
}

export function buildOptionalSkipOutput(
  reason = "manager judged unnecessary",
): Readonly<Record<string, unknown>> {
  return {
    provider: "runtime-optional-skip",
    completionPassed: true,
    when: {
      always: true,
      skipped: true,
    },
    payload: {
      optionalNodeSkipped: true,
      reason,
    },
  };
}

export function applyOptionalManagerDecisions(input: {
  readonly managerControl: ParsedManagerControl | null;
  readonly session: WorkflowSessionState;
  readonly workflow: WorkflowJson;
  readonly managerStepId: string;
  readonly managerNodeExecId: string;
  readonly decidedAt: string;
}): Result<
  {
    readonly pendingOptionalNodeDecisions: readonly PendingOptionalNodeDecision[];
    readonly queuedNodeIds: readonly string[];
  },
  string
> {
  const optionalTargetNoun =
    input.workflow.steps !== undefined ? "step" : "node";
  const managerControl = input.managerControl;
  if (managerControl === null) {
    return ok({
      pendingOptionalNodeDecisions:
        input.session.pendingOptionalNodeDecisions ?? [],
      queuedNodeIds: [],
    });
  }

  const actionsByNodeId = new Map<
    string,
    { readonly status: "execute" | "skip"; readonly reason?: string }
  >();
  for (const action of managerControl.actions) {
    if (
      action.type !== "execute-optional-step" &&
      action.type !== "skip-optional-step"
    ) {
      continue;
    }
    const nextStatus =
      action.type === "execute-optional-step" ? "execute" : "skip";
    const existingAction = actionsByNodeId.get(action.stepId);
    if (existingAction !== undefined && existingAction.status !== nextStatus) {
      return err(
        `invalid manager control at '${input.managerStepId}': optional ${optionalTargetNoun} '${action.stepId}' cannot be both executed and skipped in one manager turn`,
      );
    }
    actionsByNodeId.set(action.stepId, {
      status: nextStatus,
      ...(action.type === "skip-optional-step" && action.reason !== undefined
        ? { reason: action.reason }
        : {}),
    });
  }

  let pendingOptionalNodeDecisions =
    input.session.pendingOptionalNodeDecisions ?? [];
  const queuedNodeIds: string[] = [];
  for (const [nodeId, action] of actionsByNodeId.entries()) {
    const currentDecision = pendingOptionalNodeDecisions.find(
      (entry) => entry.nodeId === nodeId,
    );
    if (currentDecision === undefined || currentDecision.status !== "pending") {
      return err(
        `invalid manager control at '${input.managerStepId}': optional ${optionalTargetNoun} '${nodeId}' is not currently pending`,
      );
    }
    if (currentDecision.owningManagerStepId !== input.managerStepId) {
      return err(
        `invalid manager control at '${input.managerStepId}': optional ${optionalTargetNoun} '${nodeId}' is owned by '${currentDecision.owningManagerStepId}'`,
      );
    }
    if (!isOptionalNode(input.workflow, nodeId)) {
      return err(
        `invalid manager control at '${input.managerStepId}': ${optionalTargetNoun} '${nodeId}' is not optional`,
      );
    }
    pendingOptionalNodeDecisions = upsertPendingOptionalNodeDecision(
      pendingOptionalNodeDecisions,
      {
        ...currentDecision,
        status: action.status,
        ...(action.status === "skip" && action.reason !== undefined
          ? { reason: action.reason }
          : {}),
        decidedAt: input.decidedAt,
        decidedByNodeExecId: input.managerNodeExecId,
      },
    );
    queuedNodeIds.push(nodeId);
  }

  return ok({
    pendingOptionalNodeDecisions,
    queuedNodeIds: dedupeNodeIds(queuedNodeIds),
  });
}

export function findLatestPublishedWorkflowResult(
  workflow: WorkflowJson,
  session: WorkflowSessionState,
): NodeExecutionRecord | undefined {
  return [...session.nodeExecutions]
    .reverse()
    .find(
      (entry) =>
        entry.status === "succeeded" &&
        isWorkflowOutputKindNode(workflow, entry.nodeId),
    );
}
