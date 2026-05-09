import path from "node:path";
import {
  atomicWriteJsonFile as writeJsonFile,
  atomicWriteTextFile as writeRawTextFile,
} from "../shared/fs";
import {
  saveNodeExecutionToRuntimeDb,
  saveProcessLogsToRuntimeDb,
} from "./runtime-db";
import {
  buildOutputRefForExecution,
  persistNodeBackendSession,
  type CommunicationRecord,
  type NodeBackendSessionRecord,
  type NodeExecutionRecord,
  type WorkflowSessionState,
} from "./session";
import { saveSession } from "./session-store";
import { parseManagerControlPayload } from "./manager-control";
import type { ParsedManagerControl } from "./manager-control";
import {
  evaluateBranch,
  evaluateCompletion,
  resolveLoopTransition,
} from "./semantics";
import { isSupervisionStallLastError } from "./superviser";
import {
  isWorkflowOutputKindNode,
  type toStepIdentityFields,
} from "./runtime-addressing";
import type {
  StepIdentityFields,
  ResolvedStepExecutionAddress,
  BackendSessionSelection,
} from "./runtime-addressing";
import { resolveWorkflowManagerStepId } from "./types";
import type {
  WorkflowJson,
  WorkflowEdge,
  LoopRule,
  NodePayload,
  AgentNodePayload,
} from "./types";
import type { WorkflowNodeRef } from "./types-base";
import type {
  AdapterAmbientManagerContext,
  AdapterBackendSessionInput,
  AdapterProcessLog,
  NodeAdapter,
} from "./adapter";
import type { JsonSchemaValidationError } from "./json-schema";
import type { ManagerSessionStore } from "./manager-session-store";
import { hashManagerAuthToken } from "./manager-session-store";
import { isManagerNodeRef } from "./node-role";
import {
  err,
  workflowRunFailure,
  type EngineExecutionGuards,
  type RunWorkflowInternalFn,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./engine-types";
import {
  applyOptionalManagerDecisions,
  removePendingOptionalNodeDecision,
} from "./engine-node-helpers";
import { sha256Hex, stableJson } from "./engine-utils";
import {
  buildCommitMessageTemplate,
  markCommunicationsConsumed,
  persistCommunicationArtifact,
} from "./engine-communications";
import { readBusinessPayload } from "./engine-session-helpers";
import { executeCrossWorkflowDispatchesForNode } from "./engine-cross-workflow";
import type { Result } from "./result";

export type PostExecResult =
  | { readonly kind: "break"; readonly session: WorkflowSessionState }
  | {
      readonly kind: "timed-out";
      readonly session: WorkflowSessionState;
      readonly nodeExecutions: readonly NodeExecutionRecord[];
      readonly updatedCounts: Readonly<Record<string, number>>;
      readonly nextExecutionCounter: number;
      readonly communicationCounter: number;
      readonly communications: readonly CommunicationRecord[];
      readonly nodeBackendSessions: Readonly<
        Record<string, NodeBackendSessionRecord>
      >;
      readonly endedAt: string;
    }
  | {
      readonly kind: "return";
      readonly result: Result<WorkflowRunResult, WorkflowRunFailure>;
    };

export interface PostExecInput {
  readonly session: WorkflowSessionState;
  readonly queue: readonly string[];
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly nodeRef: WorkflowNodeRef;
  readonly stepIdentityFields: ReturnType<typeof toStepIdentityFields>;
  readonly stepExecutionAddress: ResolvedStepExecutionAddress;
  readonly mailboxInstanceId: string;
  readonly nextExecutionCounter: number;
  readonly updatedCounts: Readonly<Record<string, number>>;
  readonly executionTargetNoun: string;
  readonly executionNodePayload: NodePayload;
  readonly loopRule: LoopRule | undefined;
  readonly artifactDir: string;
  readonly artifactWorkflowRoot: string;
  readonly workflow: WorkflowJson;
  readonly workflowName: string;
  readonly options: WorkflowRunOptions;
  readonly outgoingEdges: ReadonlyMap<string, readonly WorkflowEdge[]>;
  readonly maxLoopIterations: number | undefined;
  readonly effectiveAdapter: NodeAdapter;
  readonly guards: EngineExecutionGuards | undefined;
  readonly crossWorkflowInvocationStack: readonly string[];
  readonly runWorkflowInternalFn: RunWorkflowInternalFn;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly managerSessionId: string | undefined;
  readonly ambientManagerContext: AdapterAmbientManagerContext | undefined;
  readonly nodeStatus: NodeExecutionRecord["status"];
  readonly outputPayload: Readonly<Record<string, unknown>>;
  readonly processLogs: readonly AdapterProcessLog[];
  readonly backendSession: AdapterBackendSessionInput | undefined;
  readonly backendSessionId: string | undefined;
  readonly backendSessionProvider: string | undefined;
  readonly backendSessionSelection: BackendSessionSelection | undefined;
  readonly backendSessionIdentityFields: StepIdentityFields | undefined;
  readonly agentNodePayload: AgentNodePayload | null;
  readonly outputAttemptCount: number;
  readonly outputValidationErrors: readonly JsonSchemaValidationError[];
  readonly requestedBackendSessionMode: "new" | "reuse" | undefined;
  readonly inputJson: string;
  readonly timeoutMs: number;
  readonly restartAttempt: number;
  readonly previousNodeExecId: string | undefined;
  readonly isOptionalExecutionNode: boolean;
  readonly upstreamCommunicationIds: readonly string[];
  readonly managerSessionStore: ManagerSessionStore;
}

export async function processPostExecution(
  input: PostExecInput,
): Promise<PostExecResult> {
  const {
    session,
    queue,
    nodeId,
    nodeExecId,
    nodeRef,
    stepIdentityFields,
    stepExecutionAddress,
    mailboxInstanceId,
    nextExecutionCounter,
    updatedCounts,
    executionTargetNoun,
    executionNodePayload,
    loopRule,
    artifactDir,
    artifactWorkflowRoot,
    workflow,
    workflowName,
    options,
    outgoingEdges,
    maxLoopIterations,
    effectiveAdapter,
    guards,
    crossWorkflowInvocationStack,
    runWorkflowInternalFn,
    startedAt,
    endedAt,
    managerSessionId,
    ambientManagerContext,
    processLogs,
    backendSession,
    backendSessionId,
    backendSessionProvider,
    backendSessionSelection,
    backendSessionIdentityFields,
    agentNodePayload,
    outputAttemptCount,
    outputValidationErrors,
    requestedBackendSessionMode,
    inputJson,
    timeoutMs,
    restartAttempt,
    previousNodeExecId,
    isOptionalExecutionNode,
    upstreamCommunicationIds,
    managerSessionStore,
  } = input;
  let { nodeStatus, outputPayload } = input;

  const buildBase = (
    extra: Partial<WorkflowSessionState>,
  ): WorkflowSessionState => ({
    ...session,
    queue: [...queue],
    status: "failed" as const,
    currentNodeId: nodeId,
    endedAt,
    nodeExecutionCounter: nextExecutionCounter,
    nodeExecutionCounts: updatedCounts,
    communicationCounter: session.communicationCounter,
    communications: session.communications,
    ...extra,
  });

  try {
    await saveProcessLogsToRuntimeDb(
      {
        sessionId: session.sessionId,
        nodeId,
        nodeExecId,
        processLogs,
        at: endedAt,
        ...(stepExecutionAddress.stepId === undefined
          ? {}
          : { executionLogTarget: "step" as const }),
      },
      options,
    );
  } catch {
    // runtime DB process logs are best-effort
  }
  const nextNodeBackendSessions =
    agentNodePayload === null
      ? (session.nodeBackendSessions ?? {})
      : persistNodeBackendSession({
          session,
          node: agentNodePayload,
          nodeExecId,
          ...(backendSessionIdentityFields ?? {}),
          ...(backendSessionSelection?.inheritFromStepId === undefined
            ? {}
            : { inheritFromStepId: backendSessionSelection.inheritFromStepId }),
          provider:
            backendSessionProvider ??
            outputPayload["provider"]?.toString() ??
            "unknown-provider",
          endedAt,
          backendSession,
          ...(backendSessionId === undefined
            ? {}
            : { returnedSessionId: backendSessionId }),
        });
  const buildNodeExecutionRecord = (
    status: NodeExecutionRecord["status"] = nodeStatus,
  ): NodeExecutionRecord => ({
    nodeId,
    ...stepIdentityFields,
    nodeExecId,
    executionOrdinal: nextExecutionCounter,
    mailboxInstanceId,
    status,
    artifactDir,
    startedAt,
    endedAt,
    ...(restartAttempt === 0 ? {} : { attempt: restartAttempt + 1 }),
    ...(outputAttemptCount === 1 ? {} : { outputAttemptCount }),
    ...(outputValidationErrors.length === 0 ? {} : { outputValidationErrors }),
    ...(backendSessionId === undefined ? {} : { backendSessionId }),
    ...(requestedBackendSessionMode === undefined
      ? {}
      : { backendSessionMode: requestedBackendSessionMode }),
    ...(previousNodeExecId === undefined
      ? {}
      : { restartedFromNodeExecId: previousNodeExecId }),
    ...(stepExecutionAddress.promptVariant === undefined
      ? {}
      : { promptVariant: stepExecutionAddress.promptVariant }),
    timeoutMs,
  });
  const buildNodeExecutions = (
    status: NodeExecutionRecord["status"] = nodeStatus,
  ): readonly NodeExecutionRecord[] => [
    ...session.nodeExecutions,
    buildNodeExecutionRecord(status),
  ];
  const finalizeManagerSession = async (
    finalStatus: "completed" | "failed" | "cancelled",
  ): Promise<void> => {
    if (managerSessionId === undefined || ambientManagerContext === undefined)
      return;
    await managerSessionStore.createOrResumeSession({
      managerSessionId,
      workflowId: workflow.workflowId,
      workflowExecutionId: session.sessionId,
      managerStepId: nodeId,
      managerNodeExecId: nodeExecId,
      status: finalStatus,
      createdAt: startedAt,
      updatedAt: endedAt,
      authTokenHash: hashManagerAuthToken(
        ambientManagerContext.environment.DIVEDRA_MANAGER_AUTH_TOKEN,
      ),
      authTokenExpiresAt: endedAt,
    });
  };
  const tryFinalizeAndSaveFailed = async (
    exitCode: number,
    lastError: string,
    nodeExecutions: readonly NodeExecutionRecord[],
    extra: Partial<WorkflowSessionState> = {},
  ): Promise<PostExecResult> => {
    try {
      await finalizeManagerSession("failed");
    } catch (finalizationError: unknown) {
      const fMsg =
        finalizationError instanceof Error
          ? finalizationError.message
          : "unknown manager session finalization failure";
      const failed = buildBase({
        nodeExecutions,
        nodeBackendSessions: nextNodeBackendSessions,
        lastError: `failed to finalize manager session for ${executionTargetNoun} '${nodeId}': ${fMsg}`,
        ...extra,
      });
      await saveSession(failed, options);
      return {
        kind: "return",
        result: err({
          exitCode: 1,
          message: failed.lastError ?? "failed to finalize manager session",
        }),
      };
    }
    const failed = buildBase({
      nodeExecutions,
      nodeBackendSessions: nextNodeBackendSessions,
      lastError,
      ...extra,
    });
    await saveSession(failed, options);
    return { kind: "return", result: err({ exitCode, message: lastError }) };
  };

  let managerControl: ParsedManagerControl | null = null;
  if (isManagerNodeRef(nodeRef)) {
    try {
      const businessPayload = readBusinessPayload(outputPayload);
      managerControl =
        businessPayload === null
          ? null
          : parseManagerControlPayload(businessPayload, workflow, {
              managerStepId: nodeId,
              ...(nodeRef.role === undefined
                ? {}
                : { managerRole: nodeRef.role }),
            });
    } catch (error: unknown) {
      nodeStatus = "failed";
      const message =
        error instanceof Error
          ? error.message
          : "unknown manager control parsing failure";
      return tryFinalizeAndSaveFailed(
        5,
        `invalid manager control for ${executionTargetNoun} '${nodeId}': ${message}`,
        buildNodeExecutions(),
      );
    }
    if (managerControl !== null && managerSessionId !== undefined) {
      try {
        const claimedMode = await managerSessionStore.claimControlMode({
          managerSessionId,
          controlMode: "payload-manager-control",
          updatedAt: endedAt,
        });
        if (claimedMode !== "payload-manager-control") {
          nodeStatus = "failed";
          return tryFinalizeAndSaveFailed(
            5,
            `invalid manager control for ${executionTargetNoun} '${nodeId}': manager execution cannot mix GraphQL manager messages with payload managerControl`,
            buildNodeExecutions(),
          );
        }
      } catch (error: unknown) {
        nodeStatus = "failed";
        const message =
          error instanceof Error
            ? error.message
            : "unknown manager control mode claim failure";
        return tryFinalizeAndSaveFailed(
          5,
          `invalid manager control for ${executionTargetNoun} '${nodeId}': ${message}`,
          buildNodeExecutions(),
        );
      }
    }
  }
  const optionalManagerDecisionsResult = applyOptionalManagerDecisions({
    managerControl,
    session,
    workflow,
    managerStepId: nodeId,
    managerNodeExecId: nodeExecId,
    decidedAt: endedAt,
  });
  if (!optionalManagerDecisionsResult.ok) {
    nodeStatus = "failed";
    return tryFinalizeAndSaveFailed(
      5,
      optionalManagerDecisionsResult.error,
      buildNodeExecutions(),
    );
  }
  const queuedOptionalDecisionNodeIds =
    optionalManagerDecisionsResult.value.queuedNodeIds;
  const pendingOptionalNodeDecisionsAfterManagerActions =
    optionalManagerDecisionsResult.value.pendingOptionalNodeDecisions;
  const nodeExecutions = buildNodeExecutions();
  try {
    await finalizeManagerSession(
      nodeStatus === "succeeded" ? "completed" : "failed",
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "unknown manager session finalization failure";
    const failed = buildBase({
      nodeExecutions,
      nodeBackendSessions: nextNodeBackendSessions,
      lastError: `failed to finalize manager session for ${executionTargetNoun} '${nodeId}': ${message}`,
    });
    await saveSession(failed, options);
    return {
      kind: "return",
      result: err(
        workflowRunFailure(
          1,
          failed.lastError ?? "failed to finalize manager session",
          failed,
        ),
      ),
    };
  }

  const edges = outgoingEdges.get(nodeId) ?? [];
  const matched = edges.filter((edge) =>
    evaluateBranch({ when: edge.when, output: outputPayload }),
  );
  const loopIterationCounts = session.loopIterationCounts ?? {};
  let selected = matched;
  let updatedLoopIterationCounts = loopIterationCounts;
  if (loopRule !== undefined) {
    const resolvedMax = loopRule.maxIterations ?? maxLoopIterations;
    const effectiveLoopRule: LoopRule =
      resolvedMax !== undefined
        ? { ...loopRule, maxIterations: resolvedMax }
        : { ...loopRule };
    const iteration = loopIterationCounts[loopRule.id] ?? 0;
    const transition = resolveLoopTransition({
      loopRule: effectiveLoopRule,
      output: outputPayload,
      state: { loopId: loopRule.id, iteration },
    });
    if (transition === "continue") {
      selected = edges.filter(
        (edge) => edge.when === effectiveLoopRule.continueWhen,
      );
      updatedLoopIterationCounts = {
        ...loopIterationCounts,
        [loopRule.id]: iteration + 1,
      };
    } else if (transition === "exit") {
      selected = edges.filter(
        (edge) => edge.when === effectiveLoopRule.exitWhen,
      );
    } else {
      selected = matched.filter(
        (edge) =>
          edge.when !== effectiveLoopRule.continueWhen &&
          edge.when !== effectiveLoopRule.exitWhen,
      );
    }
    if (selected.length === 0 && transition !== "none") {
      const failed = buildBase({
        nodeExecutions: [...session.nodeExecutions, buildNodeExecutionRecord()],
        loopIterationCounts: updatedLoopIterationCounts,
        nodeBackendSessions: nextNodeBackendSessions,
        lastError: `loop transition '${transition}' has no matching edge for ${executionTargetNoun} '${nodeId}'`,
      });
      await saveSession(failed, options);
      return {
        kind: "return",
        result: err({
          exitCode: 4,
          message: failed.lastError ?? "invalid loop transition",
        }),
      };
    }
  }
  const nextNodes = selected.map((edge) => edge.to);

  const outputJson = stableJson(outputPayload);
  const outputRaw = `${outputJson}\n`;
  const outputRef = buildOutputRefForExecution({
    workflow,
    session: { ...session, workflowId: workflow.workflowId },
    execution: {
      nodeId,
      ...stepIdentityFields,
      nodeExecId,
      mailboxInstanceId,
      status: nodeStatus,
      artifactDir,
      startedAt,
      endedAt,
      ...(stepExecutionAddress.promptVariant === undefined
        ? {}
        : { promptVariant: stepExecutionAddress.promptVariant }),
      timeoutMs,
    },
  });
  const inputHash = sha256Hex(inputJson);
  const outputHash = sha256Hex(outputJson);
  let currentCommunications: readonly CommunicationRecord[] =
    session.communications;
  let currentCommunicationCounter = session.communicationCounter;
  const currentRuntimeVariables = isWorkflowOutputKindNode(workflow, nodeId)
    ? { ...session.runtimeVariables, workflowOutput: outputPayload["payload"] }
    : session.runtimeVariables;

  await writeRawTextFile(path.join(artifactDir, "output.json"), outputRaw);
  await writeJsonFile(path.join(artifactDir, "meta.json"), {
    nodeId,
    ...stepIdentityFields,
    nodeExecId,
    mailboxInstanceId,
    status: nodeStatus,
    startedAt,
    endedAt,
    model: executionNodePayload.model,
    timeoutMs,
    ...(stepExecutionAddress.promptVariant === undefined
      ? {}
      : { promptVariant: stepExecutionAddress.promptVariant }),
    restartAttempt,
    outputAttemptCount,
    ...(backendSessionId === undefined ? {} : { backendSessionId }),
    ...(requestedBackendSessionMode === undefined
      ? {}
      : { backendSessionMode: requestedBackendSessionMode }),
    ...(outputValidationErrors.length === 0 ? {} : { outputValidationErrors }),
    ...(previousNodeExecId === undefined
      ? {}
      : { restartedFromNodeExecId: previousNodeExecId }),
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
        status: nodeStatus,
        artifactDir,
        startedAt,
        endedAt,
        ...(restartAttempt === 0 ? {} : { attempt: restartAttempt + 1 }),
        ...(outputAttemptCount === 1 ? {} : { outputAttemptCount }),
        ...(outputValidationErrors.length === 0
          ? {}
          : { outputValidationErrors }),
        ...(stepExecutionAddress.promptVariant === undefined
          ? {}
          : { promptVariant: stepExecutionAddress.promptVariant }),
        timeoutMs,
        ...(requestedBackendSessionMode === undefined
          ? {}
          : { backendSessionMode: requestedBackendSessionMode }),
        ...(backendSessionId === undefined ? {} : { backendSessionId }),
        ...(previousNodeExecId === undefined
          ? {}
          : { restartedFromNodeExecId: previousNodeExecId }),
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

  if (nodeStatus === "timed_out") {
    return {
      kind: "timed-out",
      session,
      nodeExecutions,
      updatedCounts,
      nextExecutionCounter,
      communicationCounter: currentCommunicationCounter,
      communications: currentCommunications,
      nodeBackendSessions: nextNodeBackendSessions,
      endedAt,
    };
  }

  if (nodeStatus === "failed") {
    const providerErrMessage = (() => {
      const p = outputPayload["payload"];
      if (typeof p !== "object" || p === null) return undefined;
      const m = (p as Readonly<Record<string, unknown>>)[
        "providerErrorMessage"
      ];
      return typeof m === "string" && m.length > 0 ? m : undefined;
    })();
    const failureReason: string =
      providerErrMessage !== undefined &&
      isSupervisionStallLastError(providerErrMessage)
        ? providerErrMessage
        : outputPayload["error"] === "invalid_output"
          ? `invalid adapter output for ${executionTargetNoun} '${nodeId}'`
          : outputValidationErrors.length > 0
            ? `output validation failed for ${executionTargetNoun} '${nodeId}'`
            : `adapter failure for ${executionTargetNoun} '${nodeId}'`;
    const failed: WorkflowSessionState = {
      ...session,
      queue: [...queue],
      status: "failed",
      currentNodeId: nodeId,
      endedAt,
      nodeExecutionCounter: nextExecutionCounter,
      nodeExecutionCounts: updatedCounts,
      nodeExecutions,
      communicationCounter: currentCommunicationCounter,
      communications: currentCommunications,
      nodeBackendSessions: nextNodeBackendSessions,
      lastError: failureReason,
    };
    await saveSession(failed, options);
    return {
      kind: "return",
      result: err(
        workflowRunFailure(5, failed.lastError ?? "adapter failure", failed),
      ),
    };
  }

  const completion = evaluateCompletion({
    rule: nodeRef.completion,
    output: outputPayload,
  });
  if (!completion.passed) {
    const failed: WorkflowSessionState = {
      ...session,
      queue: [...queue],
      status: "failed",
      currentNodeId: nodeId,
      endedAt,
      nodeExecutionCounter: nextExecutionCounter,
      nodeExecutionCounts: updatedCounts,
      nodeExecutions,
      loopIterationCounts: updatedLoopIterationCounts,
      communicationCounter: currentCommunicationCounter,
      communications: currentCommunications,
      nodeBackendSessions: nextNodeBackendSessions,
      lastError:
        completion.reason === null
          ? `completion condition not met for ${executionTargetNoun} '${nodeId}'`
          : `completion condition not met for ${executionTargetNoun} '${nodeId}': ${completion.reason}`,
    };
    await saveSession(failed, options);
    return {
      kind: "return",
      result: err(
        workflowRunFailure(
          3,
          failed.lastError ?? "completion condition not met",
          failed,
        ),
      ),
    };
  }

  const consumedResult = await markCommunicationsConsumed(
    { ...session, communications: currentCommunications },
    upstreamCommunicationIds,
    nodeExecId,
    endedAt,
  );
  if (!consumedResult.ok) {
    const failed: WorkflowSessionState = {
      ...session,
      queue: [...queue],
      status: "failed",
      currentNodeId: nodeId,
      endedAt,
      nodeExecutionCounter: nextExecutionCounter,
      nodeExecutionCounts: updatedCounts,
      nodeExecutions,
      loopIterationCounts: updatedLoopIterationCounts,
      communicationCounter: currentCommunicationCounter,
      communications: currentCommunications,
      nodeBackendSessions: nextNodeBackendSessions,
      lastError: consumedResult.error,
    };
    await saveSession(failed, options);
    return {
      kind: "return",
      result: err(
        workflowRunFailure(
          1,
          failed.lastError ?? "mailbox consumption persistence failed",
          failed,
        ),
      ),
    };
  }
  currentCommunications = consumedResult.value;
  const transitionComms = await Promise.all(
    selected.map((edge, index) =>
      persistCommunicationArtifact({
        artifactWorkflowRoot,
        runtimeLogOptions: options,
        workflowId: workflow.workflowId,
        workflowExecutionId: session.sessionId,
        communicationCounter: currentCommunicationCounter + index,
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
      }),
    ),
  );
  currentCommunications = [...currentCommunications, ...transitionComms];
  currentCommunicationCounter += transitionComms.length;

  const crossResult = await executeCrossWorkflowDispatchesForNode({
    workflow,
    workflowName,
    session: {
      ...session,
      nodeExecutions,
      communicationCounter: currentCommunicationCounter,
      communications: currentCommunications,
      runtimeVariables: currentRuntimeVariables,
    },
    options,
    artifactWorkflowRoot,
    callerNodeId: nodeId,
    callerStepId: stepExecutionAddress.stepId,
    callerNodeRegistryId: stepExecutionAddress.nodeRegistryId,
    callerNodeExecId: nodeExecId,
    callerArtifactDir: artifactDir,
    callerOutputPayload: outputPayload,
    callerOutputRaw: outputRaw,
    createdAt: endedAt,
    communicationCounter: currentCommunicationCounter,
    currentCommunications,
    adapter: effectiveAdapter,
    guards,
    crossWorkflowInvocationStack,
    runWorkflowInternalFn,
  });
  if (!crossResult.ok) {
    const failed: WorkflowSessionState = {
      ...session,
      queue: [...queue],
      status: "failed",
      currentNodeId: nodeId,
      endedAt,
      nodeExecutionCounter: nextExecutionCounter,
      nodeExecutionCounts: updatedCounts,
      nodeExecutions,
      loopIterationCounts: updatedLoopIterationCounts,
      communicationCounter: currentCommunicationCounter,
      communications: currentCommunications,
      nodeBackendSessions: nextNodeBackendSessions,
      lastError: crossResult.error,
    };
    await saveSession(failed, options);
    return {
      kind: "return",
      result: err(
        workflowRunFailure(
          1,
          failed.lastError ?? "cross-workflow dispatch execution failed",
          failed,
        ),
      ),
    };
  }
  currentCommunications = crossResult.value.communications;
  currentCommunicationCounter = crossResult.value.communicationCounter;

  const retryStepIds = managerControl?.retryStepIds ?? [];
  const nextQueue = [
    ...queue,
    ...selected.map((e) => e.to),
    ...crossResult.value.queuedNodeIds,
    ...queuedOptionalDecisionNodeIds,
  ].filter((v, i, a) => a.indexOf(v) === i);
  const nextQueueWithRetries = [...nextQueue, ...retryStepIds].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  const updatedSession: WorkflowSessionState = {
    ...session,
    status: "running",
    queue: nextQueueWithRetries,
    currentNodeId: nodeId,
    nodeExecutionCounter: nextExecutionCounter,
    nodeExecutionCounts: updatedCounts,
    loopIterationCounts: updatedLoopIterationCounts,
    transitions: [
      ...session.transitions,
      ...selected.map((e) => ({ from: e.from, to: e.to, when: e.when })),
      ...crossResult.value.transitions,
    ],
    nodeExecutions,
    communicationCounter: currentCommunicationCounter,
    communications: currentCommunications,
    ...(session.conversationTurns === undefined
      ? {}
      : { conversationTurns: session.conversationTurns }),
    nodeBackendSessions: nextNodeBackendSessions,
    pendingOptionalNodeDecisions: isOptionalExecutionNode
      ? removePendingOptionalNodeDecision(
          pendingOptionalNodeDecisionsAfterManagerActions,
          nodeId,
        )
      : pendingOptionalNodeDecisionsAfterManagerActions,
    runtimeVariables: currentRuntimeVariables,
  };

  await saveSession(updatedSession, options);
  return { kind: "break", session: updatedSession };
}
