import { randomBytes } from "node:crypto";
import type { WorkflowSessionState } from "./session";
import type { SupervisionRunState } from "./types-auto-improve";
import type { AutoImprovePolicy, AgentNodePayload, NodePayload } from "./types";
import {
  DEFAULT_SUPERVISER_WORKFLOW_ID,
  resolveSuperviserWorkflowId,
} from "./auto-improve-policy";
import { asAgentNodePayload } from "./types";

export function isTerminalStatus(
  status: WorkflowSessionState["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function readBusinessPayload(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const payload = value["payload"];
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  return payload as Readonly<Record<string, unknown>>;
}

export function cloneSession(
  session: WorkflowSessionState,
): WorkflowSessionState {
  const next: WorkflowSessionState = {
    ...session,
    queue: [...session.queue],
    nodeExecutionCounts: { ...session.nodeExecutionCounts },
    loopIterationCounts: { ...(session.loopIterationCounts ?? {}) },
    restartCounts: { ...(session.restartCounts ?? {}) },
    restartEvents: [...(session.restartEvents ?? [])],
    transitions: [...session.transitions],
    nodeExecutions: [...session.nodeExecutions],
    communicationCounter: session.communicationCounter,
    communications: [...session.communications],
    conversationTurns: [...(session.conversationTurns ?? [])],
    nodeBackendSessions: { ...(session.nodeBackendSessions ?? {}) },
    pendingOptionalNodeDecisions: [
      ...(session.pendingOptionalNodeDecisions ?? []),
    ],
    activeUserActions: [...(session.activeUserActions ?? [])],
    runtimeVariables: { ...session.runtimeVariables },
  };
  if (session.supervision === undefined) {
    return next;
  }
  return {
    ...next,
    supervision: {
      ...session.supervision,
      incidents: [...session.supervision.incidents],
      ...(session.supervision.remediations === undefined
        ? {}
        : { remediations: [...session.supervision.remediations] }),
    },
  };
}

export function createInitialSupervisionRunState(input: {
  readonly policy: AutoImprovePolicy;
  readonly targetWorkflowId: string;
}): SupervisionRunState {
  const superviserWorkflowId = resolveSuperviserWorkflowId(
    input.policy.superviserWorkflowId,
  );
  return {
    supervisionRunId: `sup-${randomBytes(10).toString("hex")}`,
    targetWorkflowId: input.targetWorkflowId,
    superviserWorkflowId: superviserWorkflowId.ok
      ? superviserWorkflowId.value
      : DEFAULT_SUPERVISER_WORKFLOW_ID,
    status: "running",
    attemptCount: 1,
    workflowPatchCount: 0,
    policy: input.policy,
    incidents: [],
    remediations: [],
  };
}

export function cloneSupervisionForContinuedRun(
  source: SupervisionRunState,
  policy: AutoImprovePolicy,
): SupervisionRunState {
  const superviserWorkflowId = resolveSuperviserWorkflowId(
    policy.superviserWorkflowId,
  );
  return {
    ...source,
    superviserWorkflowId: superviserWorkflowId.ok
      ? superviserWorkflowId.value
      : DEFAULT_SUPERVISER_WORKFLOW_ID,
    status: "running",
    policy,
    incidents: [...source.incidents],
    ...(source.remediations === undefined
      ? {}
      : { remediations: [...source.remediations] }),
  };
}

export function buildScenarioExecutableNodePayload(
  node: NodePayload,
  hasScenarioEntry: boolean,
  allowScenarioFallback: boolean,
  allowDryRun: boolean,
): AgentNodePayload | null {
  const agentNodePayload = asAgentNodePayload(node);
  if (agentNodePayload !== null) {
    return agentNodePayload;
  }

  if (
    node.managerType === "code" &&
    (allowScenarioFallback || allowDryRun) &&
    node.promptTemplate !== undefined
  ) {
    return {
      ...node,
      nodeType: "agent",
      model: node.model ?? "deterministic-code-manager",
      promptTemplate: node.promptTemplate,
    };
  }

  if (
    hasScenarioEntry &&
    (node.nodeType === "command" ||
      node.nodeType === "container" ||
      node.nodeType === "addon")
  ) {
    const { nodeType: _nodeType, ...rest } = node;
    return {
      ...rest,
      nodeType: "agent",
      model: `scenario/${node.nodeType}`,
      promptTemplate: node.promptTemplate ?? "",
    };
  }

  return null;
}
