import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJsonFile as writeJsonFile,
  atomicWriteTextFile as writeRawTextFile,
} from "../shared/fs";
import { saveNodeExecutionToRuntimeDb } from "./runtime-db";
import {
  buildOutputRefForExecution,
  type NodeExecutionRecord,
  type WorkflowSessionState,
  type CommunicationRecord,
} from "./session";
import { saveSession } from "./session-store";
import { resolveWorkflowManagerStepId } from "./types";
import type {
  WorkflowJson,
  WorkflowEdge,
  LoopRule,
  NodePayload,
  AgentNodePayload,
} from "./types";
import type { WorkflowNodeRef } from "./types-base";
import { resolveLoopTransition, evaluateBranch } from "./semantics";
import {
  isWorkflowOutputKindNode,
  type toStepIdentityFields,
} from "./runtime-addressing";
import type { StepExecutionAddress } from "./runtime-addressing";
import {
  err,
  ok,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
  type WorkflowRunResult,
  type UpstreamInput,
} from "./engine-types";
import {
  dedupeNodeIds,
  removePendingOptionalNodeDecision,
  buildOptionalSkipOutput,
} from "./engine-node-helpers";
import { sha256Hex, stableJson, nowIso } from "./engine-utils";
import {
  persistCommunicationArtifact,
  buildCommitMessageTemplate,
  markCommunicationsConsumed,
} from "./engine-communications";
import type { Result } from "./result";

export type OptionalNodeHandlerResult =
  | {
      readonly kind: "return";
      readonly result: Result<WorkflowRunResult, WorkflowRunFailure>;
    }
  | { readonly kind: "break"; readonly session: WorkflowSessionState };

export interface HandleSkipOptionalNodeInput {
  readonly session: WorkflowSessionState;
  readonly queue: readonly string[];
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly nodeRef: WorkflowNodeRef;
  readonly stepIdentityFields: ReturnType<typeof toStepIdentityFields>;
  readonly stepExecutionAddress: StepExecutionAddress;
  readonly mailboxInstanceId: string;
  readonly nextExecutionCounter: number;
  readonly updatedCounts: Readonly<Record<string, number>>;
  readonly executionNodePayload: NodePayload;
  readonly agentNodePayload: AgentNodePayload | null;
  readonly baseInputPayload: Readonly<Record<string, unknown>>;
  readonly upstreamCommunicationIds: readonly string[];
  readonly upstreamInputs: readonly UpstreamInput[];
  readonly artifactDir: string;
  readonly artifactWorkflowRoot: string;
  readonly workflow: WorkflowJson;
  readonly options: WorkflowRunOptions;
  readonly outgoingEdges: ReadonlyMap<string, readonly WorkflowEdge[]>;
  readonly maxLoopIterations: number | undefined;
  readonly loopRule: LoopRule | undefined;
  readonly pendingOptionalDecisionReason: string | undefined;
}

export async function handleSkipOptionalNode(
  input: HandleSkipOptionalNodeInput,
): Promise<OptionalNodeHandlerResult> {
  const {
    session,
    queue,
    nodeId,
    nodeExecId,
    stepIdentityFields,
    stepExecutionAddress,
    mailboxInstanceId,
    nextExecutionCounter,
    updatedCounts,
    executionNodePayload,
    baseInputPayload,
    upstreamCommunicationIds,
    artifactDir,
    artifactWorkflowRoot,
    workflow,
    options,
    outgoingEdges,
    maxLoopIterations,
    loopRule,
    pendingOptionalDecisionReason,
  } = input;

  const startedAt = nowIso();
  const endedAt = startedAt;
  const outputPayload = buildOptionalSkipOutput(pendingOptionalDecisionReason);
  let selected = (outgoingEdges.get(nodeId) ?? []).filter((edge) =>
    evaluateBranch({ when: edge.when, output: outputPayload }),
  );
  let updatedLoopIterationCounts = session.loopIterationCounts;
  if (loopRule !== undefined) {
    const resolvedMax = loopRule.maxIterations ?? maxLoopIterations;
    const effectiveLoopRule: LoopRule =
      resolvedMax !== undefined
        ? { ...loopRule, maxIterations: resolvedMax }
        : { ...loopRule };
    const iteration = session.loopIterationCounts?.[loopRule.id] ?? 0;
    const transition = resolveLoopTransition({
      loopRule: effectiveLoopRule,
      output: outputPayload,
      state: { loopId: loopRule.id, iteration },
    });
    if (transition === "continue") {
      selected = (outgoingEdges.get(nodeId) ?? []).filter(
        (edge) => edge.when === effectiveLoopRule.continueWhen,
      );
      updatedLoopIterationCounts = {
        ...(session.loopIterationCounts ?? {}),
        [loopRule.id]: iteration + 1,
      };
    } else if (transition === "exit") {
      selected = (outgoingEdges.get(nodeId) ?? []).filter(
        (edge) => edge.when === effectiveLoopRule.exitWhen,
      );
    }
  }

  const inputJson = stableJson({
    ...baseInputPayload,
    nodeType: executionNodePayload.nodeType ?? "agent",
    optionalDecision: "skip",
  });
  await writeRawTextFile(
    path.join(artifactDir, "input.json"),
    `${inputJson}\n`,
  );
  const nodeExecution: NodeExecutionRecord = {
    nodeId,
    ...stepIdentityFields,
    nodeExecId,
    executionOrdinal: nextExecutionCounter,
    mailboxInstanceId,
    status: "skipped",
    artifactDir,
    startedAt,
    endedAt,
    ...(stepExecutionAddress.promptVariant === undefined
      ? {}
      : { promptVariant: stepExecutionAddress.promptVariant }),
  };
  const outputRef = buildOutputRefForExecution({
    workflow,
    session,
    execution: nodeExecution,
  });
  const outputJson = stableJson(outputPayload);
  const outputRaw = `${outputJson}\n`;
  const inputHash = sha256Hex(inputJson);
  const outputHash = sha256Hex(outputJson);
  const nextNodes = selected.map((edge) => edge.to);
  await writeRawTextFile(path.join(artifactDir, "output.json"), outputRaw);
  await writeJsonFile(path.join(artifactDir, "meta.json"), {
    nodeId,
    ...stepIdentityFields,
    nodeExecId,
    mailboxInstanceId,
    status: "skipped",
    startedAt,
    endedAt,
    ...(stepExecutionAddress.promptVariant === undefined
      ? {}
      : { promptVariant: stepExecutionAddress.promptVariant }),
    optionalDecision: "skip",
  });
  await writeJsonFile(path.join(artifactDir, "handoff.json"), {
    schemaVersion: 1,
    generatedAt: endedAt,
    nodeId,
    ...stepIdentityFields,
    mailboxInstanceId,
    outputRef,
    inputHash: `sha256:${inputHash}`,
    outputHash: `sha256:${outputHash}`,
    nextNodes,
  });
  await writeRawTextFile(
    path.join(artifactDir, "commit-message.txt"),
    `${buildCommitMessageTemplate(inputHash, outputHash, outputRef, nextNodes)}\n`,
  );
  try {
    await saveNodeExecutionToRuntimeDb(
      {
        sessionId: session.sessionId,
        nodeId,
        ...stepIdentityFields,
        nodeExecId,
        executionOrdinal: nextExecutionCounter,
        mailboxInstanceId,
        status: "skipped",
        artifactDir,
        startedAt,
        endedAt,
        ...(stepExecutionAddress.promptVariant === undefined
          ? {}
          : { promptVariant: stepExecutionAddress.promptVariant }),
        inputJson,
        outputJson,
        inputHash: `sha256:${inputHash}`,
        outputHash: `sha256:${outputHash}`,
      },
      options,
    );
  } catch {
    // runtime DB index is best-effort
  }

  const consumedCommunicationsResult = await markCommunicationsConsumed(
    session,
    upstreamCommunicationIds,
    nodeExecId,
    endedAt,
  );
  if (!consumedCommunicationsResult.ok) {
    const failed: WorkflowSessionState = {
      ...session,
      queue: [...queue],
      status: "failed",
      currentNodeId: nodeId,
      endedAt,
      nodeExecutionCounter: nextExecutionCounter,
      nodeExecutionCounts: updatedCounts,
      nodeExecutions: [...session.nodeExecutions, nodeExecution],
      lastError: consumedCommunicationsResult.error,
    };
    await saveSession(failed, options);
    return {
      kind: "return",
      result: err({
        exitCode: 1,
        message: failed.lastError ?? "mailbox consumption persistence failed",
      }),
    };
  }
  let currentCommunications: readonly CommunicationRecord[] =
    consumedCommunicationsResult.value;
  const transitionCommunications = await Promise.all(
    selected.map((edge, index) => {
      return persistCommunicationArtifact({
        artifactWorkflowRoot,
        runtimeLogOptions: options,
        workflowId: workflow.workflowId,
        workflowExecutionId: session.sessionId,
        communicationCounter: session.communicationCounter + index,
        fromNodeId: edge.from,
        toNodeId: edge.to,
        routingScope: "intra-workflow",
        deliveryKind: edge.to === edge.from ? "loop-back" : "edge-transition",
        transitionWhen: edge.when,
        sourceNodeExecId: nodeExecId,
        payloadRef: outputRef,
        outputRaw,
        deliveredByNodeId: resolveWorkflowManagerStepId(workflow),
        createdAt: endedAt,
      });
    }),
  );
  currentCommunications = [
    ...currentCommunications,
    ...transitionCommunications,
  ];
  const updatedSession: WorkflowSessionState = {
    ...session,
    status: "running",
    queue: dedupeNodeIds([...queue, ...nextNodes]),
    currentNodeId: nodeId,
    nodeExecutionCounter: nextExecutionCounter,
    nodeExecutionCounts: updatedCounts,
    ...(updatedLoopIterationCounts === undefined
      ? {}
      : { loopIterationCounts: updatedLoopIterationCounts }),
    transitions: [
      ...session.transitions,
      ...selected.map((edge) => ({
        from: edge.from,
        to: edge.to,
        when: edge.when,
      })),
    ],
    nodeExecutions: [...session.nodeExecutions, nodeExecution],
    communicationCounter:
      session.communicationCounter + transitionCommunications.length,
    communications: currentCommunications,
    runtimeVariables: isWorkflowOutputKindNode(workflow, nodeId)
      ? {
          ...session.runtimeVariables,
          workflowOutput: outputPayload["payload"],
        }
      : session.runtimeVariables,
    pendingOptionalNodeDecisions: removePendingOptionalNodeDecision(
      session.pendingOptionalNodeDecisions ?? [],
      nodeId,
    ),
  };
  await saveSession(updatedSession, options);
  return { kind: "break", session: updatedSession };
}

export interface HandleUserActionNodeInput {
  readonly session: WorkflowSessionState;
  readonly queue: readonly string[];
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly stepIdentityFields: ReturnType<typeof toStepIdentityFields>;
  readonly stepExecutionAddress: StepExecutionAddress;
  readonly mailboxInstanceId: string;
  readonly nextExecutionCounter: number;
  readonly updatedCounts: Readonly<Record<string, number>>;
  readonly nodePayload: NodePayload;
  readonly assembledPromptText: string;
  readonly baseInputPayload: Readonly<Record<string, unknown>>;
  readonly artifactDir: string;
  readonly workflow: WorkflowJson;
  readonly options: WorkflowRunOptions;
}

export async function handleUserActionNode(
  input: HandleUserActionNodeInput,
): Promise<Result<WorkflowRunResult, WorkflowRunFailure>> {
  const {
    session,
    queue,
    nodeId,
    nodeExecId,
    nextExecutionCounter,
    updatedCounts,
    nodePayload,
    assembledPromptText,
    baseInputPayload,
    artifactDir,
    workflow,
    options,
  } = input;

  const startedAt = nowIso();
  const inputJson = stableJson({
    ...baseInputPayload,
    nodeType: "user-action",
    userAction: nodePayload.userAction,
    outputContract:
      nodePayload.output === undefined
        ? undefined
        : {
            description: nodePayload.output.description,
            jsonSchema: nodePayload.output.jsonSchema,
            maxValidationAttempts: nodePayload.output.maxValidationAttempts,
          },
  });
  await writeRawTextFile(
    path.join(artifactDir, "input.json"),
    `${inputJson}\n`,
  );
  const userActionDir = path.join(artifactDir, "user-action");
  const userActionId = `useract-${nodeExecId}`;
  await mkdir(userActionDir, { recursive: true });
  await writeJsonFile(path.join(userActionDir, "request.json"), {
    userActionId,
    workflowId: workflow.workflowId,
    workflowExecutionId: session.sessionId,
    nodeId,
    nodeExecId,
    promptText: assembledPromptText,
    userAction: nodePayload.userAction,
    outputContract: nodePayload.output,
    createdAt: startedAt,
    status: "waiting-for-reply",
  });
  await writeJsonFile(path.join(userActionDir, "resolution.json"), {
    status: "waiting-for-reply",
    updatedAt: startedAt,
  });
  const { endedAt: _endedAt, lastError: _lastError, ...restSession } = session;
  const paused: WorkflowSessionState = {
    ...restSession,
    status: "paused",
    queue: [...queue],
    currentNodeId: nodeId,
    nodeExecutionCounter: nextExecutionCounter,
    nodeExecutionCounts: updatedCounts,
    pendingOptionalNodeDecisions: removePendingOptionalNodeDecision(
      session.pendingOptionalNodeDecisions ?? [],
      nodeId,
    ),
    activeUserActions: [
      ...(session.activeUserActions ?? []).filter(
        (entry) => entry.nodeId !== nodeId,
      ),
      {
        nodeId,
        nodeExecId,
        userActionId,
        artifactDir: userActionDir,
        status: "waiting-for-reply",
        pausedAt: startedAt,
      },
    ],
  };
  await saveSession(paused, options);
  return ok({ session: paused, exitCode: 4 });
}
