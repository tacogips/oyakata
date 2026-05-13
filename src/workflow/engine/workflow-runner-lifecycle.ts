import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJsonFile as writeJsonFile,
  atomicWriteTextFile as writeRawTextFile,
} from "../../shared/fs";
import {
  buildAdapterDivedraHookContext,
  normalizeOutputContractEnvelope,
  type AdapterAmbientManagerContext,
  type AdapterLlmSessionMessage,
  type AdapterProcessLog,
  type NodeAdapter,
} from "../adapter";
import {
  executeAdapterWithTimeout,
  executeNativeNodeWithTimeout,
} from "../adapter-execution";
import { DispatchingNodeAdapter } from "../adapters/dispatch";
import { claimFanoutStepBudget } from "../engine-fanout";
import {
  loadContinuationRelatedSnapshots,
  resolveContinuationAnchorPlacement,
} from "../history-continuation";
import { assembleNodeInput } from "../input-assembly";
import {
  validateJsonValueAgainstSchema,
  type JsonSchemaValidationError,
} from "../json-schema";
import { loadWorkflowFromDisk } from "../load";
import { appendMailboxPromptGuidance } from "../mailbox-prompt-guidance";
import { parseManagerControlPayload } from "../manager-control";
import {
  buildAmbientManagerControlPlaneEnvironment,
  createManagerSessionStore,
  hashManagerAuthToken,
  mintManagerAuthToken,
} from "../manager-session-store";
import { createExecutionCopyMutableWorkspace } from "../mutable-workspace";
import {
  buildNodeExecutionMailbox,
  writeNodeExecutionMailboxArtifacts,
} from "../node-execution-mailbox";
import { describeWorkflowNodeKind, isManagerNodeRef } from "../node-role";
import { resolveEffectiveRoots } from "../paths";
import { composeExecutionPrompts } from "../prompt-composition";
import { err, ok, type Result } from "../result";
import {
  isWorkflowOutputKindNode,
  resolveBackendSessionSelection,
  resolveRequiredStepExecutionAddress,
  toStepIdentityFields,
} from "../runtime-addressing";
import {
  saveNodeExecutionToRuntimeDb,
  saveProcessLogsToRuntimeDb,
} from "../runtime-db";
import { inspectWorkflowRuntimeReadiness } from "../runtime-readiness";
import { ScenarioNodeAdapter } from "../scenario-adapter";
import { evaluateCompletion, resolveLoopTransition } from "../semantics";
import {
  buildOutputRefForExecution,
  createSessionId,
  createSessionState,
  persistNodeBackendSession,
  resolveRequestedBackendSession,
  type CommunicationRecord,
  type FanoutGroupRunRecord,
  type NodeExecutionRecord,
  type WorkflowSessionState,
} from "../session";
import { loadSession, saveSession } from "../session-store";
import {
  buildSupervisionStallWatch,
  isSupervisionStallLastError,
} from "../superviser";
import type {
  JsonObject,
  LoopRule,
  SupervisionRunState,
  WorkflowEdge,
} from "../types";
import {
  getNormalizedNodePayload,
  getStructuralEdges,
  getStructuralLoops,
  resolveWorkflowManagerStepId,
} from "../types";
import {
  resolveNodeExecutionWorkingDirectory,
  resolveWorkflowExecutionWorkingDirectory,
} from "../working-directory";
import type {
  CancellationProbe,
  EngineExecutionGuards,
  NormalizedWorkflowRunOptions,
  WorkflowRunFailure,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "./types-and-session-state";
import {
  NON_CONTRACT_CANDIDATE_FILE_ERROR,
  addMillisecondsToIso,
  buildOptionalSkipOutput,
  buildOutputPromptText,
  buildOutputPublicationPolicy,
  buildReservedCandidateSubmissionPath,
  buildRetryValidationFeedback,
  cleanupReservedCandidateSubmissionPath,
  dedupeNodeIds,
  describeAmbiguousFanoutBranchRerunTarget,
  emitWorkflowRunEvent,
  evaluateEdge,
  findOwningManagerNodeId,
  findPendingOptionalNodeDecision,
  hasPendingPausedFanoutBranch,
  mergeVariables,
  nextManagerSessionId,
  nextNodeExecId,
  nextOutputAttemptId,
  notifyWorkflowProgress,
  nowIso,
  removePendingOptionalNodeDecision,
  resolveCandidatePayload,
  resolveOutputValidationAttempts,
  resolveTimeoutMs,
  resolveTimeoutRestartBudget,
  sha256Hex,
  sleep,
  stableJson,
  upsertPendingOptionalNodeDecision,
  workflowRunFailure,
} from "./types-and-session-state";
import { applyOptionalManagerDecisions } from "./cross-workflow-dispatch";
import {
  executeCrossWorkflowDispatchesForNode,
  executeLocalFanoutTransition,
} from "./fanout-dispatch";
import { runNestedSuperviserSessionDriver } from "./auto-improve-and-runner";
import {
  buildLatestOutputMailboxIndex,
  buildCommitMessageTemplate,
  buildScenarioExecutableNodePayload,
  buildUpstreamInputs,
  cloneSession,
  cloneSupervisionForContinuedRun,
  createInitialSupervisionRunState,
  isTerminalStatus,
  markCommunicationsConsumed,
  persistCommunicationArtifact,
  persistExternalMailboxInputCommunication,
  readBusinessPayload,
} from "./mailbox-communication-artifacts";
import { finalizeCompletedWorkflowRun } from "./result-finalization";

export async function runWorkflowInternal(
  workflowName: string,
  options: NormalizedWorkflowRunOptions,
  adapter?: NodeAdapter,
  guards?: EngineExecutionGuards,
  crossWorkflowInvocationStack: readonly string[] = [],
): Promise<Result<WorkflowRunResult, WorkflowRunFailure>> {
  let workflowWorkingDirectory: string;
  try {
    workflowWorkingDirectory = resolveWorkflowExecutionWorkingDirectory({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.workflowWorkingDirectory === undefined
        ? {}
        : { workflowWorkingDirectory: options.workflowWorkingDirectory }),
    });
  } catch (error: unknown) {
    return err({
      exitCode: 2,
      message:
        error instanceof Error
          ? error.message
          : "workingDirectory must be a non-empty path when provided",
    });
  }
  const resumeRequested = options.resumeSessionId !== undefined;
  const rerunRequested = options.rerunFromSessionId !== undefined;
  const continuationRequested =
    options.continueFromWorkflowExecutionId !== undefined;
  if (
    [resumeRequested, rerunRequested, continuationRequested].filter(Boolean)
      .length > 1
  ) {
    return err({
      exitCode: 2,
      message:
        "resumeSessionId, rerunFromSessionId, and continueFromWorkflowExecutionId are mutually exclusive",
    });
  }
  const isFreshAutoImproveSeed =
    !resumeRequested && !rerunRequested && !continuationRequested;
  let preloadedForBundlePath: WorkflowSessionState | undefined;
  if (options.resumeSessionId !== undefined) {
    const pre = await loadSession(options.resumeSessionId, options);
    if (!pre.ok) {
      return err({ exitCode: 1, message: pre.error.message });
    }
    if (pre.value.workflowName !== workflowName) {
      return err({
        exitCode: 1,
        message: "session workflow does not match command workflow",
      });
    }
    preloadedForBundlePath = pre.value;
  } else if (options.rerunFromSessionId !== undefined) {
    const pre = await loadSession(options.rerunFromSessionId, options);
    if (!pre.ok) {
      return err({ exitCode: 1, message: pre.error.message });
    }
    if (pre.value.workflowName !== workflowName) {
      return err({
        exitCode: 1,
        message: "source session workflow does not match command workflow",
      });
    }
    preloadedForBundlePath = pre.value;
  } else if (options.continueFromWorkflowExecutionId !== undefined) {
    const pre = await loadSession(
      options.continueFromWorkflowExecutionId,
      options,
    );
    if (!pre.ok) {
      return err({ exitCode: 1, message: pre.error.message });
    }
    if (pre.value.workflowName !== workflowName) {
      return err({
        exitCode: 1,
        message:
          "source workflow execution workflow does not match command workflow",
      });
    }
    preloadedForBundlePath = pre.value;
  }
  const bundlePathOverrideFromSession =
    preloadedForBundlePath?.supervision?.mutableWorkflowDir;
  const firstLoadOptions: WorkflowRunOptions = {
    ...options,
    ...(options.workflowBundleDirectoryOverride === undefined &&
    bundlePathOverrideFromSession !== undefined
      ? { workflowBundleDirectoryOverride: bundlePathOverrideFromSession }
      : {}),
  };
  let loaded = await loadWorkflowFromDisk(workflowName, firstLoadOptions);
  if (!loaded.ok) {
    return err({
      exitCode:
        loaded.error.code === "VALIDATION" ||
        loaded.error.code === "INVALID_WORKFLOW_NAME"
          ? 2
          : 1,
      message: loaded.error.message,
    });
  }
  let precomputedSupervision: SupervisionRunState | undefined;
  if (isFreshAutoImproveSeed && options.autoImprove !== undefined) {
    const policy = options.autoImprove;
    const initial = createInitialSupervisionRunState({
      policy,
      targetWorkflowId: loaded.value.bundle.workflow.workflowId,
    });
    const roots = resolveEffectiveRoots(options);
    const workspace = await createExecutionCopyMutableWorkspace({
      workflowId: loaded.value.bundle.workflow.workflowId,
      sourceWorkflowDir: loaded.value.workflowDirectory,
      artifactRoot: roots.artifactRoot,
      supervisionRunId: initial.supervisionRunId,
      mutationMode: policy.workflowMutationMode,
    });
    if (!workspace.ok) {
      return err({
        exitCode: 1,
        message: `supervision workspace: ${workspace.error.message}`,
      });
    }
    precomputedSupervision = {
      ...initial,
      mutableWorkflowDir: workspace.value.mutableWorkflowDir,
    };
    if (workspace.value.mutationMode === "execution-copy") {
      const reloaded = await loadWorkflowFromDisk(workflowName, {
        ...options,
        workflowBundleDirectoryOverride: workspace.value.mutableWorkflowDir,
      });
      if (!reloaded.ok) {
        return err({
          exitCode:
            reloaded.error.code === "VALIDATION" ||
            reloaded.error.code === "INVALID_WORKFLOW_NAME"
              ? 2
              : 1,
          message: reloaded.error.message,
        });
      }
      loaded = reloaded;
    }
  }
  const runtimeVariables = options.runtimeVariables ?? {};
  const workflow = loaded.value.bundle.workflow;
  const stepAddressedExecution = true;
  const executionTargetNoun = "step";
  const nodeMap = loaded.value.bundle.nodePayloads;
  const workflowNodes = new Map(
    workflow.nodes.map((entry) => [entry.id, entry]),
  );
  const loopRuleByJudgeNodeId = new Map<string, LoopRule>(
    getStructuralLoops(workflow).map((entry) => [entry.judgeNodeId, entry]),
  );
  const effectiveAdapter =
    adapter ??
    (options.mockScenario === undefined
      ? new DispatchingNodeAdapter()
      : new ScenarioNodeAdapter(options.mockScenario));
  if (
    adapter === undefined &&
    options.mockScenario === undefined &&
    options.dryRun !== true
  ) {
    const readiness = await inspectWorkflowRuntimeReadiness(
      loaded.value.bundle,
      options,
    );
    if (!readiness.ready) {
      return err({
        exitCode: 1,
        message: `workflow runtime readiness failed: ${readiness.blockers.join("; ")}`,
      });
    }
  }
  const cancellationProbe =
    guards?.cancellationProbe ??
    ({
      async isCancelled(sessionId: string): Promise<boolean> {
        const current = await loadSession(sessionId, options);
        return current.ok && current.value.status === "cancelled";
      },
    } satisfies CancellationProbe);
  const managerSessionStore = createManagerSessionStore(options);
  let session: WorkflowSessionState;
  if (options.rerunFromSessionId !== undefined) {
    if (preloadedForBundlePath === undefined) {
      return err({
        exitCode: 1,
        message: "internal: rerun source session missing",
      });
    }
    const source = preloadedForBundlePath;
    const rerunTargetLabel = workflow.steps === undefined ? "node" : "step";
    const rerunTargetId = options.rerunFromStepId;
    if (rerunTargetId === undefined) {
      return err({
        exitCode: 1,
        message: `rerun ${rerunTargetLabel} id is required when rerunFromSessionId is set`,
      });
    }
    const stepIdSet =
      workflow.steps === undefined
        ? undefined
        : new Set(workflow.steps.map((st) => st.id));
    const rerunIdKnown =
      stepIdSet === undefined
        ? workflowNodes.has(rerunTargetId)
        : stepIdSet.has(rerunTargetId);
    if (!rerunIdKnown) {
      return err({
        exitCode: 1,
        message: `unknown rerun ${rerunTargetLabel} '${rerunTargetId}'`,
      });
    }
    const ambiguousFanoutBranchRerun = describeAmbiguousFanoutBranchRerunTarget(
      source,
      rerunTargetId,
    );
    if (ambiguousFanoutBranchRerun !== undefined) {
      return err({ exitCode: 2, message: ambiguousFanoutBranchRerun });
    }
    session = createSessionState({
      sessionId:
        options.sessionId ??
        createSessionId({ workflowId: workflow.workflowId }),
      workflowName,
      workflowId: workflow.workflowId,
      initialNodeId: rerunTargetId,
      runtimeVariables: { ...source.runtimeVariables, ...runtimeVariables },
    });
    if (options.supervisionLoopExecution === true) {
      session = {
        ...session,
        nodeExecutionCounter: source.nodeExecutionCounter,
        nodeExecutionCounts: { ...source.nodeExecutionCounts },
      };
    }
  } else if (options.continueFromWorkflowExecutionId !== undefined) {
    if (preloadedForBundlePath === undefined) {
      return err({
        exitCode: 1,
        message: "internal: continuation source workflow execution missing",
      });
    }
    const sourceSession = preloadedForBundlePath;
    const continueAfterStepRunId = options.continueAfterStepRunId;
    const continueStartStepId = options.continueStartStepId;
    if (
      continueAfterStepRunId === undefined ||
      continueAfterStepRunId.trim().length === 0 ||
      continueStartStepId === undefined ||
      continueStartStepId.trim().length === 0
    ) {
      return err({
        exitCode: 2,
        message:
          "continueAfterStepRunId and continueStartStepId are required when continueFromWorkflowExecutionId is set",
      });
    }
    const continueTargetLabel = workflow.steps === undefined ? "node" : "step";
    const trimmedStart = continueStartStepId.trim();
    const stepIdSetContinue =
      workflow.steps === undefined
        ? undefined
        : new Set(workflow.steps.map((st) => st.id));
    const continuationStartKnown =
      stepIdSetContinue === undefined
        ? workflowNodes.has(trimmedStart)
        : stepIdSetContinue.has(trimmedStart);
    if (!continuationStartKnown) {
      return err({
        exitCode: 1,
        message: `unknown continuation ${continueTargetLabel} '${trimmedStart}'`,
      });
    }
    const snapshotsResult = await loadContinuationRelatedSnapshots(
      [sourceSession],
      options,
    );
    if (!snapshotsResult.ok) {
      return err({ exitCode: 1, message: snapshotsResult.error });
    }
    const snapshotsForAnchor = snapshotsResult.value;
    const anchorResult = resolveContinuationAnchorPlacement({
      snapshots: snapshotsForAnchor,
      sourceWorkflowExecutionId: sourceSession.sessionId,
      anchorStepRunId: continueAfterStepRunId.trim(),
      expectedWorkflowId: workflow.workflowId,
    });
    if (!anchorResult.ok) {
      return err({
        exitCode: 1,
        message: anchorResult.error.message,
      });
    }
    session = createSessionState({
      sessionId:
        options.sessionId ??
        createSessionId({ workflowId: workflow.workflowId }),
      workflowName,
      workflowId: workflow.workflowId,
      initialNodeId: trimmedStart,
      runtimeVariables: {
        ...sourceSession.runtimeVariables,
        ...runtimeVariables,
      },
    });
    session = {
      ...session,
      continuedFromWorkflowExecutionId: sourceSession.sessionId,
      continuedAfterStepRunId: anchorResult.value.anchor.stepRunId,
      continuedAfterExecutionOrdinal:
        anchorResult.value.anchor.executionOrdinal,
      continuedStartStepId: trimmedStart,
      continuationMode: "rerun-from-history",
      historyImports: anchorResult.value.flattenedHistoryImports,
    };
  } else if (options.resumeSessionId !== undefined) {
    if (preloadedForBundlePath === undefined) {
      return err({ exitCode: 1, message: "internal: resume session missing" });
    }
    const existing = preloadedForBundlePath;
    session = cloneSession(existing);
    if (options.autoImprove !== undefined) {
      const policy = options.autoImprove;
      if (session.supervision === undefined) {
        return err(
          workflowRunFailure(
            2,
            "autoImprove on resume requires supervision state on the session (start with workflow run --auto-improve, or omit --auto-improve when resuming a non-supervised session)",
            existing,
          ),
        );
      }
      session = {
        ...session,
        supervision: cloneSupervisionForContinuedRun(
          session.supervision,
          policy,
        ),
      };
    }
    if (session.status === "completed") {
      if (options.autoImprove !== undefined) {
        await saveSession(session, options);
      }
      return ok({ session, exitCode: 0 });
    }
    if ((session.activeUserActions?.length ?? 0) > 0) {
      if (options.autoImprove !== undefined) {
        await saveSession(session, options);
      }
      return ok({ session, exitCode: 4 });
    }
    if (hasPendingPausedFanoutBranch(session)) {
      if (options.autoImprove !== undefined) {
        await saveSession(session, options);
      }
      return ok({ session, exitCode: 4 });
    }
    session = {
      ...session,
      status: "running",
      runtimeVariables: { ...session.runtimeVariables, ...runtimeVariables },
    };
  } else {
    session = createSessionState({
      sessionId:
        options.sessionId ??
        createSessionId({ workflowId: workflow.workflowId }),
      workflowName,
      workflowId: workflow.workflowId,
      initialNodeId:
        options.fanoutBranchStartStepId ??
        resolveWorkflowManagerStepId(workflow),
      runtimeVariables,
    });
  }
  if (
    options.autoImprove !== undefined &&
    options.continueFromWorkflowExecutionId !== undefined
  ) {
    return err({
      exitCode: 2,
      message:
        "autoImprove cannot be combined with history-linked continuation (continueFromWorkflowExecutionId); omit autoImprove for this entry mode",
    });
  }
  if (
    options.autoImprove !== undefined &&
    options.resumeSessionId === undefined
  ) {
    const policy = options.autoImprove;
    let nextSupervision: SupervisionRunState;
    if (precomputedSupervision !== undefined) {
      nextSupervision = precomputedSupervision;
    } else if (preloadedForBundlePath?.supervision !== undefined) {
      nextSupervision = cloneSupervisionForContinuedRun(
        preloadedForBundlePath.supervision,
        policy,
      );
    } else if (options.rerunFromSessionId !== undefined) {
      return err({
        exitCode: 2,
        message:
          "autoImprove on rerun requires supervision state on the source session (for example, use workflow run with --auto-improve first, then rerun with the same policy)",
      });
    } else {
      return err({
        exitCode: 1,
        message:
          "internal: auto-improve supervision was not precomputed; report this as a bug",
      });
    }
    session = {
      ...session,
      supervision: nextSupervision,
    };
  }
  if (options.resumeSessionId === undefined) {
    const humanInput = session.runtimeVariables["humanInput"];
    if (humanInput !== undefined) {
      const bootstrapCommunication =
        await persistExternalMailboxInputCommunication({
          artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
          runtimeLogOptions: options,
          workflowId: workflow.workflowId,
          workflowExecutionId: session.sessionId,
          communicationCounter: session.communicationCounter,
          deliveredByNodeId: resolveWorkflowManagerStepId(workflow),
          toNodeId: resolveWorkflowManagerStepId(workflow),
          humanInput,
          createdAt: session.startedAt,
        });
      session = {
        ...session,
        communicationCounter: session.communicationCounter + 1,
        communications: [...session.communications, bootstrapCommunication],
      };
    }
  }
  await saveSession(session, options);
  if (options.nestedSuperviserDriver === true) {
    if (options.autoImprove === undefined) {
      return err(
        workflowRunFailure(
          2,
          "nestedSuperviserDriver requires an auto-improve policy",
          session,
        ),
      );
    }
    if (options.rerunFromSessionId !== undefined) {
      return err(
        workflowRunFailure(
          2,
          "nestedSuperviserDriver is not valid when rerunning from a source session",
          session,
        ),
      );
    }
    if (options.continueFromWorkflowExecutionId !== undefined) {
      return err(
        workflowRunFailure(
          2,
          "nestedSuperviserDriver is not valid when continuing from imported workflow history",
          session,
        ),
      );
    }
    if (options.resumeSessionId !== undefined) {
      if (session.supervision?.nestedSuperviserSessionId === undefined) {
        return err(
          workflowRunFailure(
            2,
            "nestedSuperviserDriver on resume requires nestedSuperviserSessionId on supervision (start the workflow with --nested-superviser first)",
            session,
          ),
        );
      }
    }
    if (session.supervision === undefined) {
      return err(
        workflowRunFailure(
          2,
          "nestedSuperviserDriver requires seed supervision on the session",
          session,
        ),
      );
    }
    return runNestedSuperviserSessionDriver(
      workflowName,
      session,
      loaded.value,
      options,
      adapter,
      guards,
      crossWorkflowInvocationStack,
    );
  }
  const outgoingEdges = new Map<string, WorkflowEdge[]>();
  getStructuralEdges(workflow).forEach((edge) => {
    const current = outgoingEdges.get(edge.from);
    if (current) {
      current.push(edge);
      return;
    }
    outgoingEdges.set(edge.from, [edge]);
  });
  const maxLoopIterations =
    options.maxLoopIterations ?? workflow.defaults.maxLoopIterations;
  const maxSteps = options.maxSteps;
  const stuckRestartBackoffMs = options.stuckRestartBackoffMs ?? 250;
  if (
    (session.activeUserActions?.length ?? 0) > 0 &&
    session.status === "paused"
  ) {
    return ok({ session, exitCode: 4 });
  }
  let continuationSnapshotsForMergedReads:
    | ReadonlyMap<string, WorkflowSessionState>
    | undefined;
  if (
    session.historyImports !== undefined &&
    session.historyImports.length > 0
  ) {
    const snapLoad = await loadContinuationRelatedSnapshots([session], options);
    if (!snapLoad.ok) {
      return err(
        workflowRunFailure(
          1,
          `history-linked continuation snapshot load failed: ${snapLoad.error}`,
          session,
        ),
      );
    }
    continuationSnapshotsForMergedReads = snapLoad.value;
  }
  while (session.queue.length > 0) {
    const persisted = await loadSession(session.sessionId, options);
    if (persisted.ok && isTerminalStatus(persisted.value.status)) {
      if (persisted.value.status === "completed") {
        return ok({ session: persisted.value, exitCode: 0 });
      }
      const exitCode = persisted.value.status === "cancelled" ? 130 : 1;
      return err(
        workflowRunFailure(
          exitCode,
          persisted.value.lastError ?? `session ${persisted.value.status}`,
          persisted.value,
        ),
      );
    }
    if (await cancellationProbe.isCancelled(session.sessionId)) {
      const cancelled: WorkflowSessionState = {
        ...session,
        status: "cancelled",
        ...(session.queue[0] === undefined
          ? {}
          : { currentNodeId: session.queue[0] }),
        endedAt: nowIso(),
        lastError: "cancelled by external request",
      };
      await saveSession(cancelled, options);
      return err(
        workflowRunFailure(130, cancelled.lastError ?? "cancelled", cancelled),
      );
    }
    if (maxSteps !== undefined && session.nodeExecutionCounter >= maxSteps) {
      const paused: WorkflowSessionState = {
        ...session,
        status: "paused",
        ...(session.queue[0] === undefined
          ? {}
          : { currentNodeId: session.queue[0] }),
        endedAt: nowIso(),
        lastError: `max steps reached (${maxSteps})`,
      };
      await saveSession(paused, options);
      return ok({ session: paused, exitCode: 4 });
    }
    if (!claimFanoutStepBudget(options.fanoutStepBudget)) {
      const paused: WorkflowSessionState = {
        ...session,
        status: "paused",
        ...(session.queue[0] === undefined
          ? {}
          : { currentNodeId: session.queue[0] }),
        endedAt: nowIso(),
        lastError:
          maxSteps === undefined
            ? "fanout step budget reached"
            : `fanout max steps reached (${maxSteps})`,
      };
      await saveSession(paused, options);
      return ok({ session: paused, exitCode: 4 });
    }
    const queue = [...session.queue];
    const nodeId = queue.shift();
    if (nodeId === undefined) {
      break;
    }
    const nodeRef = workflowNodes.get(nodeId);
    const nodePayload = getNormalizedNodePayload(loaded.value.bundle, nodeId);
    if (!nodeRef || !nodePayload) {
      const failed: WorkflowSessionState = {
        ...session,
        queue,
        status: "failed",
        currentNodeId: nodeId,
        endedAt: nowIso(),
        lastError: stepAddressedExecution
          ? `missing step definition for '${nodeId}'`
          : `missing node definition for '${nodeId}'`,
      };
      await saveSession(failed, options);
      return err(
        workflowRunFailure(
          1,
          failed.lastError ??
            (stepAddressedExecution
              ? "missing step definition"
              : "missing node definition"),
          failed,
        ),
      );
    }
    const pendingOptionalDecision = findPendingOptionalNodeDecision(
      session,
      nodeId,
    );
    const isOptionalExecutionNode = nodeRef.execution?.mode === "optional";
    if (
      isOptionalExecutionNode &&
      (pendingOptionalDecision === undefined ||
        pendingOptionalDecision.status === "pending")
    ) {
      const requestedAt = nowIso();
      const owningManagerStepId = findOwningManagerNodeId(workflow, nodeId);
      session = {
        ...session,
        status: "running",
        queue: dedupeNodeIds([...queue, owningManagerStepId]),
        currentNodeId: owningManagerStepId,
        pendingOptionalNodeDecisions: upsertPendingOptionalNodeDecision(
          session.pendingOptionalNodeDecisions ?? [],
          {
            nodeId,
            owningManagerStepId,
            requestedAt,
            status: "pending",
          },
        ),
      };
      await saveSession(session, options);
      continue;
    }
    const skipOptionalNode =
      isOptionalExecutionNode && pendingOptionalDecision?.status === "skip";
    const executableNodePayload = buildScenarioExecutableNodePayload(
      nodePayload,
      options.mockScenario?.[nodeId] !== undefined,
      options.mockScenario !== undefined,
      options.dryRun === true,
    );
    const agentNodePayload = executableNodePayload;
    const nativeNodePayload =
      executableNodePayload === null &&
      (nodePayload.nodeType === "command" ||
        nodePayload.nodeType === "container" ||
        nodePayload.nodeType === "addon")
        ? nodePayload
        : null;
    if (
      agentNodePayload === null &&
      nativeNodePayload === null &&
      nodePayload.nodeType !== "user-action" &&
      !skipOptionalNode
    ) {
      const failed: WorkflowSessionState = {
        ...session,
        queue,
        status: "failed",
        currentNodeId: nodeId,
        endedAt: nowIso(),
        lastError: stepAddressedExecution
          ? `step '${nodeId}' is missing executable fields`
          : `node '${nodeId}' is missing executable node fields`,
      };
      await saveSession(failed, options);
      return err(
        workflowRunFailure(
          1,
          failed.lastError ??
            (stepAddressedExecution
              ? "invalid step execution payload"
              : "invalid node execution payload"),
          failed,
        ),
      );
    }
    let restartAttempt = 0;
    let previousNodeExecId: string | undefined;
    for (;;) {
      const nextCount = (session.nodeExecutionCounts[nodeId] ?? 0) + 1;
      const updatedCounts = {
        ...session.nodeExecutionCounts,
        [nodeId]: nextCount,
      };
      const loopRule = loopRuleByJudgeNodeId.get(nodeId);
      const nextExecutionCounter = session.nodeExecutionCounter + 1;
      const nodeExecId = nextNodeExecId(nextExecutionCounter);
      const workflowExecutionRoot = path.join(
        loaded.value.artifactWorkflowRoot,
        "executions",
        session.sessionId,
      );
      const artifactDir = path.join(
        workflowExecutionRoot,
        "nodes",
        nodeId,
        nodeExecId,
      );
      await mkdir(artifactDir, { recursive: true });
      const executionNodePayload = agentNodePayload ?? nodePayload;
      const stepExecutionAddress = resolveRequiredStepExecutionAddress(
        workflow,
        nodeId,
      );
      if (stepExecutionAddress === undefined) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: `normalized workflow runtime node '${nodeId}' is missing its authored step definition`,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ?? "missing step execution address",
            failed,
          ),
        );
      }
      await emitWorkflowRunEvent(options, {
        type: "step-started",
        workflowExecutionId: session.sessionId,
        stepId: stepExecutionAddress.stepId,
        nodeExecId,
        workflowName,
        workflowId: workflow.workflowId,
        nodeId,
        attempt: nextCount,
        queuedStepIds: queue,
      });
      notifyWorkflowProgress(options, {
        type: "step-start",
        sessionId: session.sessionId,
        workflowName,
        workflowId: workflow.workflowId,
        stepId: stepExecutionAddress.stepId,
        nodeId,
        nodeExecId,
        attempt: nextCount,
        queuedStepIds: queue,
      });
      const stepIdentityFields = toStepIdentityFields(stepExecutionAddress);
      const mailboxInstanceId = nodeExecId;
      const mergedVariables = mergeVariables(
        executionNodePayload.variables,
        session.runtimeVariables,
      );
      const upstreamInputsResult = await buildUpstreamInputs(
        workflow,
        session,
        nodeId,
        continuationSnapshotsForMergedReads,
      );
      if (!upstreamInputsResult.ok) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: upstreamInputsResult.error,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ?? "upstream communication resolution failed",
            failed,
          ),
        );
      }
      const upstreamInputs = upstreamInputsResult.value;
      const latestOutputsResult = await buildLatestOutputMailboxIndex(session);
      if (!latestOutputsResult.ok) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: latestOutputsResult.error,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ?? "latest output context resolution failed",
            failed,
          ),
        );
      }
      const latestOutputs = latestOutputsResult.value;
      const upstreamOutputRefs = upstreamInputs.map(
        ({ output, outputRaw, ...ref }) => ref,
      );
      const upstreamBindingInputs = upstreamInputs.map((entry) => ({
        fromNodeId: entry.fromNodeId,
        transitionWhen: entry.transitionWhen,
        status: entry.status,
        communicationId: entry.communicationId,
        output: entry.output,
      }));
      const upstreamCommunicationIds = upstreamInputs.map(
        (entry) => entry.communicationId,
      );
      const transcriptInput = (session.conversationTurns ?? []).map((turn) => ({
        conversationId: turn.conversationId,
        turnIndex: turn.turnIndex,
        fromManagerStepId: turn.fromManagerStepId,
        toManagerStepId: turn.toManagerStepId,
        communicationId: turn.communicationId,
        outputRef: turn.outputRef,
        sentAt: turn.sentAt,
      }));
      let assembledPromptText: string;
      let assembledArguments: Readonly<Record<string, unknown>> | null;
      let executionMailbox:
        | ReturnType<typeof buildNodeExecutionMailbox>
        | undefined;
      try {
        const assembled = assembleNodeInput({
          runtimeVariables: session.runtimeVariables,
          node: executionNodePayload,
          workflowId: workflow.workflowId,
          workflowDescription: workflow.description,
          nodeKind: describeWorkflowNodeKind(nodeRef),
          upstream: upstreamBindingInputs,
          transcript: transcriptInput,
        });
        executionMailbox = buildNodeExecutionMailbox({
          workflow,
          nodeRef,
          node: executionNodePayload,
          ...stepIdentityFields,
          mailboxInstanceId,
          nodePayloads: nodeMap,
          runtimeVariables: session.runtimeVariables,
          basePromptText: assembled.promptText,
          assembledArguments: assembled.arguments,
          upstreamInputs,
          latestOutputs,
        });
        assembledPromptText = assembled.promptText;
        assembledArguments = assembled.arguments;
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "unknown input assembly failure";
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: `input assembly failed for ${executionTargetNoun} '${nodeId}': ${message}`,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            3,
            failed.lastError ?? "input assembly failed",
            failed,
          ),
        );
      }
      if (executionMailbox === undefined) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: `input assembly failed for ${executionTargetNoun} '${nodeId}': execution mailbox was not created`,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            3,
            failed.lastError ?? "execution mailbox creation failed",
            failed,
          ),
        );
      }
      let mailboxDir: string;
      try {
        const mailboxPaths = await writeNodeExecutionMailboxArtifacts(
          artifactDir,
          executionMailbox,
        );
        mailboxDir = mailboxPaths.rootDir;
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "unknown execution mailbox persistence failure";
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: `failed to persist execution mailbox for ${executionTargetNoun} '${nodeId}': ${message}`,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ?? "execution mailbox persistence failed",
            failed,
          ),
        );
      }
      const baseInputPayload = {
        sessionId: session.sessionId,
        workflowExecutionId: session.sessionId,
        workflowId: workflow.workflowId,
        nodeId,
        ...stepIdentityFields,
        nodeExecId,
        mailboxInstanceId,
        promptTemplate: executionNodePayload.promptTemplate,
        promptText: assembledPromptText,
        arguments: assembledArguments,
        variables: mergedVariables,
        upstreamOutputRefs,
        upstreamCommunications: upstreamCommunicationIds,
        executionMailbox,
        ...(stepExecutionAddress.promptVariant === undefined
          ? {}
          : { promptVariant: stepExecutionAddress.promptVariant }),
        restartAttempt,
        ...(previousNodeExecId === undefined
          ? {}
          : { restartedFromNodeExecId: previousNodeExecId }),
        dryRun: options.dryRun ?? false,
      };
      if (nodePayload.nodeType === "user-action") {
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
                  maxValidationAttempts:
                    nodePayload.output.maxValidationAttempts,
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
        const {
          endedAt: _endedAt,
          lastError: _lastError,
          ...restSession
        } = session;
        const paused: WorkflowSessionState = {
          ...restSession,
          status: "paused",
          queue,
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
      if (skipOptionalNode) {
        const startedAt = nowIso();
        const endedAt = startedAt;
        const outputPayload = buildOptionalSkipOutput(
          pendingOptionalDecision?.reason,
        );
        const loopRule = loopRuleByJudgeNodeId.get(nodeId);
        let selected = (outgoingEdges.get(nodeId) ?? []).filter((edge) =>
          evaluateEdge(edge, outputPayload),
        );
        let updatedLoopIterationCounts = session.loopIterationCounts ?? {};
        if (loopRule !== undefined) {
          const effectiveLoopRule: LoopRule = {
            ...loopRule,
            maxIterations: loopRule.maxIterations ?? maxLoopIterations,
          };
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
        await writeRawTextFile(
          path.join(artifactDir, "output.json"),
          outputRaw,
        );
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
        } catch {}
        const consumedCommunicationsResult = await markCommunicationsConsumed(
          session,
          upstreamCommunicationIds,
          nodeExecId,
          endedAt,
        );
        if (!consumedCommunicationsResult.ok) {
          const failed: WorkflowSessionState = {
            ...session,
            queue,
            status: "failed",
            currentNodeId: nodeId,
            endedAt,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            nodeExecutions: [...session.nodeExecutions, nodeExecution],
            lastError: consumedCommunicationsResult.error,
          };
          await saveSession(failed, options);
          return err({
            exitCode: 1,
            message:
              failed.lastError ?? "mailbox consumption persistence failed",
          });
        }
        let currentCommunications = consumedCommunicationsResult.value;
        const transitionCommunications = await Promise.all(
          selected.map((edge, index) => {
            return persistCommunicationArtifact({
              artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
              runtimeLogOptions: options,
              workflowId: workflow.workflowId,
              workflowExecutionId: session.sessionId,
              communicationCounter: session.communicationCounter + index,
              fromNodeId: edge.from,
              toNodeId: edge.to,
              routingScope: "intra-workflow",
              deliveryKind:
                edge.to === edge.from ? "loop-back" : "edge-transition",
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
        session = {
          ...session,
          status: "running",
          queue: dedupeNodeIds([...queue, ...nextNodes]),
          currentNodeId: nodeId,
          nodeExecutionCounter: nextExecutionCounter,
          nodeExecutionCounts: updatedCounts,
          loopIterationCounts: updatedLoopIterationCounts,
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
        await saveSession(session, options);
        break;
      }
      if (agentNodePayload === null && nativeNodePayload === null) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: stepAddressedExecution
            ? `step '${nodeId}' is missing agent execution fields`
            : `node '${nodeId}' is missing agent execution fields`,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ??
              (stepAddressedExecution
                ? "invalid step execution payload"
                : "invalid node execution payload"),
            failed,
          ),
        );
      }
      const backendSessionSelection =
        agentNodePayload === null
          ? undefined
          : resolveBackendSessionSelection(
              stepExecutionAddress,
              agentNodePayload,
            );
      const backendSessionIdentityFields =
        backendSessionSelection === undefined
          ? undefined
          : toStepIdentityFields(backendSessionSelection);
      let backendSession =
        agentNodePayload === null
          ? undefined
          : resolveRequestedBackendSession({
              session,
              node: agentNodePayload,
              ...(backendSessionSelection?.sessionLookupNodeId === undefined
                ? {}
                : {
                    sessionLookupNodeId:
                      backendSessionSelection.sessionLookupNodeId,
                  }),
              ...(backendSessionSelection?.nodeRegistryId === undefined
                ? {}
                : { nodeRegistryId: backendSessionSelection.nodeRegistryId }),
              ...(backendSessionSelection?.inheritFromStepId === undefined
                ? {}
                : {
                    inheritFromStepId:
                      backendSessionSelection.inheritFromStepId,
                  }),
            });
      const composedPrompts = composeExecutionPrompts({
        promptComposition: {
          workflow,
          nodeRef,
          node: executionNodePayload,
          nodePayloads: nodeMap,
          runtimeVariables: session.runtimeVariables,
          basePromptText: assembledPromptText,
          assembledArguments,
          upstreamInputs,
          executionMailbox,
        },
        includeSessionStartPrompt:
          agentNodePayload !== null && backendSession?.mode !== "reuse",
      });
      const effectivePromptText = appendMailboxPromptGuidance({
        promptText: composedPrompts.promptText,
      });
      const systemPromptText = composedPrompts.systemPromptText;
      const requestedBackendSessionMode = backendSession?.mode;
      let backendSessionId: string | undefined = backendSession?.sessionId;
      let backendSessionProvider: string | undefined;
      const inputPayload = {
        ...baseInputPayload,
        nodeType: executionNodePayload.nodeType ?? "agent",
        ...(agentNodePayload === null
          ? {}
          : { executionBackend: agentNodePayload.executionBackend }),
        ...(agentNodePayload === null ? {} : { model: agentNodePayload.model }),
        ...(agentNodePayload?.systemPromptTemplate === undefined
          ? {}
          : { systemPromptTemplate: agentNodePayload.systemPromptTemplate }),
        ...(agentNodePayload?.sessionStartPromptTemplate === undefined
          ? {}
          : {
              sessionStartPromptTemplate:
                agentNodePayload.sessionStartPromptTemplate,
            }),
        ...(systemPromptText === undefined ? {} : { systemPromptText }),
        promptText: effectivePromptText,
        outputContract:
          executionNodePayload.output === undefined
            ? undefined
            : {
                description: executionNodePayload.output.description,
                jsonSchema: executionNodePayload.output.jsonSchema,
                maxValidationAttempts:
                  resolveOutputValidationAttempts(executionNodePayload),
                publication: buildOutputPublicationPolicy(),
              },
        ...(backendSession === undefined ? {} : { backendSession }),
      };
      const inputJson = stableJson(inputPayload);
      await writeRawTextFile(
        path.join(artifactDir, "input.json"),
        `${inputJson}\n`,
      );
      const startedAt = nowIso();
      const resolvedTimeout = resolveTimeoutMs({
        node: executionNodePayload,
        workflowTimeoutMs:
          options.defaultTimeoutMs ?? workflow.defaults.nodeTimeoutMs,
        ...(stepExecutionAddress.timeoutMs === undefined
          ? {}
          : { stepTimeoutMs: stepExecutionAddress.timeoutMs }),
      });
      const baseTimeoutMs = resolvedTimeout.timeoutMs;
      const timeoutPolicy = workflow.defaults.timeoutPolicy;
      const timeoutIncrementMs = timeoutPolicy?.retryTimeoutIncrementMs ?? 0;
      const applyTimeoutIncrement =
        timeoutIncrementMs > 0 &&
        restartAttempt > 0 &&
        timeoutPolicy !== undefined &&
        (timeoutPolicy.onTimeout === "retry-same-step" ||
          timeoutPolicy.onTimeout === "jump-to-step");
      const timeoutMs =
        baseTimeoutMs +
        (applyTimeoutIncrement ? timeoutIncrementMs * restartAttempt : 0);
      let ambientManagerContext: AdapterAmbientManagerContext | undefined;
      let managerSessionId: string | undefined;
      if (isManagerNodeRef(nodeRef) && options.dryRun !== true) {
        managerSessionId = nextManagerSessionId(nodeExecId);
        const managerAuthToken = mintManagerAuthToken();
        const activeManagerSessionExpiresAt = addMillisecondsToIso(
          startedAt,
          timeoutMs + 5 * 60_000,
        );
        ambientManagerContext = {
          environment: buildAmbientManagerControlPlaneEnvironment({
            workflowId: workflow.workflowId,
            workflowExecutionId: session.sessionId,
            managerStepId: nodeId,
            managerNodeExecId: nodeExecId,
            managerSessionId,
            authToken: managerAuthToken,
            ...(options.env === undefined ? {} : { env: options.env }),
          }),
        };
        try {
          await managerSessionStore.createOrResumeSession({
            managerSessionId,
            workflowId: workflow.workflowId,
            workflowExecutionId: session.sessionId,
            managerStepId: nodeId,
            managerNodeExecId: nodeExecId,
            status: "active",
            createdAt: startedAt,
            updatedAt: startedAt,
            authTokenHash: hashManagerAuthToken(managerAuthToken),
            authTokenExpiresAt: activeManagerSessionExpiresAt,
          });
        } catch (error: unknown) {
          const message =
            error instanceof Error
              ? error.message
              : "unknown manager session persistence failure";
          const failed: WorkflowSessionState = {
            ...session,
            queue,
            status: "failed",
            currentNodeId: nodeId,
            endedAt: startedAt,
            lastError: `failed to start manager session for ${executionTargetNoun} '${nodeId}': ${message}`,
          };
          await saveSession(failed, options);
          return err({
            exitCode: 1,
            message: failed.lastError ?? "failed to start manager session",
          });
        }
      }
      let outputPayload: Readonly<Record<string, unknown>>;
      let nodeStatus: NodeExecutionRecord["status"] = "succeeded";
      let outputValidationErrors: readonly JsonSchemaValidationError[] = [];
      let outputAttemptCount = 1;
      let processLogs: readonly AdapterProcessLog[] = [];
      let llmMessages: readonly AdapterLlmSessionMessage[] = [];
      if (options.dryRun === true) {
        outputPayload = {
          provider: "dry-run",
          model:
            agentNodePayload?.model ??
            `${executionNodePayload.nodeType ?? "agent"}-dry-run`,
          ...(systemPromptText === undefined ? {} : { systemPromptText }),
          promptText: effectivePromptText,
          completionPassed: true,
          when: { always: true },
          payload: { skippedExecution: true },
        };
      } else {
        let finalizedOutput: Readonly<Record<string, unknown>> | undefined;
        const hasOutputContract = executionNodePayload.output !== undefined;
        const maxOutputAttempts = hasOutputContract
          ? resolveOutputValidationAttempts(executionNodePayload)
          : 1;
        for (
          let outputAttempt = 1;
          outputAttempt <= maxOutputAttempts;
          outputAttempt += 1
        ) {
          outputAttemptCount = outputAttempt;
          const outputAttemptId = hasOutputContract
            ? nextOutputAttemptId(outputAttempt)
            : undefined;
          const attemptDir =
            outputAttemptId === undefined
              ? undefined
              : path.join(artifactDir, "output-attempts", outputAttemptId);
          const candidateArtifactPath =
            attemptDir === undefined
              ? undefined
              : path.join(attemptDir, "candidate.json");
          const candidatePath =
            outputAttemptId === undefined || agentNodePayload === null
              ? undefined
              : buildReservedCandidateSubmissionPath({
                  workflowId: workflow.workflowId,
                  workflowExecutionId: session.sessionId,
                  nodeId,
                  nodeExecId,
                  outputAttemptId,
                });
          const requestPath =
            attemptDir === undefined
              ? undefined
              : path.join(attemptDir, "request.json");
          const validationPath =
            attemptDir === undefined
              ? undefined
              : path.join(attemptDir, "validation.json");
          if (
            attemptDir !== undefined &&
            candidatePath !== undefined &&
            requestPath !== undefined
          ) {
            await mkdir(attemptDir, { recursive: true });
            await mkdir(path.dirname(candidatePath), { recursive: true });
            await rm(candidatePath, { force: true });
          }
          const executionPromptText =
            candidatePath === undefined || agentNodePayload === null
              ? effectivePromptText
              : buildOutputPromptText({
                  basePromptText: effectivePromptText,
                  node: agentNodePayload,
                  candidatePath,
                  validationErrors: outputValidationErrors,
                });
          const retryValidationFeedback = buildRetryValidationFeedback(
            outputValidationErrors,
          );
          if (requestPath !== undefined && candidatePath !== undefined) {
            await writeJsonFile(requestPath, {
              attempt: outputAttempt,
              executionBackend:
                agentNodePayload?.executionBackend ??
                executionNodePayload.nodeType ??
                "agent",
              model: agentNodePayload?.model ?? executionNodePayload.nodeType,
              promptText: executionPromptText,
              candidatePath,
              validationErrors: retryValidationFeedback,
            });
          }
          try {
            const contractCandidatePath = hasOutputContract
              ? candidatePath
              : undefined;
            const outputCandidatePath = contractCandidatePath;
            if (
              hasOutputContract &&
              agentNodePayload !== null &&
              outputCandidatePath === undefined
            ) {
              throw new Error(
                "candidate path must exist when node.output is configured",
              );
            }
            const adapterOutputContract =
              !hasOutputContract ||
              agentNodePayload === null ||
              agentNodePayload.output === undefined
                ? undefined
                : (() => {
                    if (outputCandidatePath === undefined) {
                      throw new Error(
                        "candidate path must exist when node.output is configured",
                      );
                    }
                    return {
                      ...(agentNodePayload.output.description === undefined
                        ? {}
                        : { description: agentNodePayload.output.description }),
                      ...(agentNodePayload.output.jsonSchema === undefined
                        ? {}
                        : { jsonSchema: agentNodePayload.output.jsonSchema }),
                      maxValidationAttempts: maxOutputAttempts,
                      attempt: outputAttempt,
                      candidatePath: outputCandidatePath,
                      validationErrors: retryValidationFeedback,
                      publication: buildOutputPublicationPolicy(),
                    };
                  })();
            const supervisionStall = buildSupervisionStallWatch(
              session,
              options,
              {
                ...(executionNodePayload.stallTimeoutMs === undefined
                  ? {}
                  : { stallTimeoutMs: executionNodePayload.stallTimeoutMs }),
              },
            );
            const execution =
              agentNodePayload !== null
                ? await executeAdapterWithTimeout(
                    effectiveAdapter,
                    {
                      workflowId: workflow.workflowId,
                      workflowExecutionId: session.sessionId,
                      nodeId,
                      nodeExecId,
                      node: agentNodePayload,
                      workingDirectory: resolveNodeExecutionWorkingDirectory(
                        workflowWorkingDirectory,
                        agentNodePayload.workingDirectory,
                      ),
                      mergedVariables,
                      ...(systemPromptText === undefined
                        ? {}
                        : { systemPromptText }),
                      promptText: executionPromptText,
                      arguments: assembledArguments,
                      executionIndex: nextCount,
                      artifactDir,
                      upstreamCommunicationIds,
                      executionMailbox,
                      divedraHookContext: buildAdapterDivedraHookContext({
                        workflowId: workflow.workflowId,
                        workflowExecutionId: session.sessionId,
                        nodeId,
                        nodeExecId,
                        mailboxDir,
                        ...(agentNodePayload.executionBackend === undefined
                          ? {}
                          : {
                              agentBackend: agentNodePayload.executionBackend,
                            }),
                      }),
                      ...(backendSession === undefined
                        ? {}
                        : { backendSession }),
                      ...(ambientManagerContext === undefined
                        ? {}
                        : { ambientManagerContext }),
                      ...(adapterOutputContract === undefined
                        ? {}
                        : { output: adapterOutputContract }),
                    },
                    timeoutMs,
                    supervisionStall,
                  )
                : await executeNativeNodeWithTimeout({
                    workflowDirectory: loaded.value.workflowDirectory,
                    workflowWorkingDirectory,
                    artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
                    workflowId: workflow.workflowId,
                    workflowDescription: workflow.description,
                    workflowExecutionId: session.sessionId,
                    nodeId,
                    nodeExecId,
                    node: executionNodePayload,
                    workflowDefaults: workflow.defaults,
                    runtimeVariables: session.runtimeVariables,
                    mergedVariables,
                    arguments: assembledArguments,
                    artifactDir,
                    executionMailbox,
                    ...(options.eventReplyDispatcher === undefined
                      ? {}
                      : { chatReplyDispatcher: options.eventReplyDispatcher }),
                    ...(options.env === undefined ? {} : { env: options.env }),
                    ...(options.superviserControl === undefined
                      ? {}
                      : { superviserControl: options.superviserControl }),
                    timeoutMs,
                    ...(supervisionStall === undefined
                      ? {}
                      : { supervisionStall }),
                  });
            if (!execution.ok) {
              processLogs = [
                ...processLogs,
                ...(execution.error.processLogs ?? []),
              ];
              if (
                execution.error.code === "invalid_output" &&
                hasOutputContract &&
                validationPath !== undefined
              ) {
                outputValidationErrors = [
                  { path: "$", message: execution.error.message },
                ];
                await writeJsonFile(validationPath, {
                  valid: false,
                  errors: outputValidationErrors,
                  rejectedAt: nowIso(),
                });
                if (outputAttempt === maxOutputAttempts) {
                  nodeStatus = "failed";
                  finalizedOutput = {
                    provider: "deterministic-local",
                    model:
                      agentNodePayload?.model ??
                      executionNodePayload.nodeType ??
                      "node",
                    promptText: effectivePromptText,
                    completionPassed: false,
                    when: {},
                    payload: {},
                    error: "output_validation_failed",
                    validationErrors: outputValidationErrors,
                  };
                  break;
                }
                continue;
              }
              outputValidationErrors = [];
              nodeStatus =
                execution.error.code === "timeout" ? "timed_out" : "failed";
              finalizedOutput = {
                provider: "deterministic-local",
                model:
                  agentNodePayload?.model ??
                  executionNodePayload.nodeType ??
                  "node",
                promptText: effectivePromptText,
                completionPassed: false,
                when: {},
                payload:
                  execution.error.code === "provider_error" &&
                  execution.error.message.length > 0
                    ? { providerErrorMessage: execution.error.message }
                    : {},
                error: execution.error.code,
              };
              break;
            }
            backendSessionProvider = execution.value.provider;
            processLogs = [
              ...processLogs,
              ...(execution.value.processLogs ?? []),
            ];
            llmMessages = [
              ...llmMessages,
              ...(execution.value.llmMessages ?? []),
            ];
            if (execution.value.backendSession?.sessionId !== undefined) {
              backendSession = {
                mode: "reuse",
                sessionId: execution.value.backendSession.sessionId,
              };
              backendSessionId = execution.value.backendSession.sessionId;
            }
            if (
              !hasOutputContract &&
              execution.value.candidateFilePath !== undefined
            ) {
              outputValidationErrors = [
                { path: "$", message: NON_CONTRACT_CANDIDATE_FILE_ERROR },
              ];
              nodeStatus = "failed";
              finalizedOutput = {
                provider: execution.value.provider,
                model: execution.value.model,
                promptText: effectivePromptText,
                completionPassed: false,
                when: {},
                payload: {},
                error: "invalid_output",
                validationErrors: outputValidationErrors,
              };
              break;
            }
            if (!hasOutputContract) {
              finalizedOutput = {
                provider: execution.value.provider,
                model: execution.value.model,
                promptText: effectivePromptText,
                completionPassed: execution.value.completionPassed,
                when: execution.value.when,
                payload: execution.value.payload,
              };
              break;
            }
            const candidateResult =
              contractCandidatePath === undefined
                ? ok(execution.value.payload)
                : await resolveCandidatePayload({
                    expectedCandidatePath: contractCandidatePath,
                    execution: execution.value,
                  });
            if (!candidateResult.ok) {
              outputValidationErrors = [
                { path: "$", message: candidateResult.error.message },
              ];
              if (validationPath !== undefined) {
                await writeJsonFile(validationPath, {
                  valid: false,
                  errors: outputValidationErrors,
                  rejectedAt: nowIso(),
                });
              }
              if (
                candidateResult.error.retryable &&
                outputAttempt < maxOutputAttempts
              ) {
                continue;
              }
              nodeStatus = "failed";
              finalizedOutput = {
                provider: execution.value.provider,
                model: execution.value.model,
                promptText: effectivePromptText,
                completionPassed: false,
                when: {},
                payload: {},
                error: candidateResult.error.retryable
                  ? "output_validation_failed"
                  : "invalid_output",
                validationErrors: outputValidationErrors,
              };
              break;
            }
            let normalizedContractPayload: ReturnType<
              typeof normalizeOutputContractEnvelope
            >;
            try {
              normalizedContractPayload = normalizeOutputContractEnvelope(
                candidateResult.value,
                "node output candidate",
                {
                  completionPassed: execution.value.completionPassed,
                  when: execution.value.when,
                },
              );
            } catch (error: unknown) {
              const message =
                error instanceof Error
                  ? error.message
                  : "invalid output contract envelope";
              outputValidationErrors = [{ path: "$", message }];
              if (validationPath !== undefined) {
                await writeJsonFile(validationPath, {
                  valid: false,
                  errors: outputValidationErrors,
                  rejectedAt: nowIso(),
                });
              }
              if (outputAttempt < maxOutputAttempts) {
                continue;
              }
              nodeStatus = "failed";
              finalizedOutput = {
                provider: execution.value.provider,
                model: execution.value.model,
                promptText: effectivePromptText,
                completionPassed: false,
                when: {},
                payload: {},
                error: "output_validation_failed",
                validationErrors: outputValidationErrors,
              };
              break;
            }
            if (candidateArtifactPath !== undefined) {
              await writeJsonFile(
                candidateArtifactPath,
                normalizedContractPayload.payload,
              );
            }
            const schema = executionNodePayload.output?.jsonSchema;
            const validationErrors =
              schema === undefined
                ? []
                : validateJsonValueAgainstSchema({
                    schema: schema as JsonObject,
                    value: normalizedContractPayload.payload,
                  });
            outputValidationErrors = validationErrors;
            if (validationPath !== undefined) {
              await writeJsonFile(validationPath, {
                valid: validationErrors.length === 0,
                errors: validationErrors,
                validatedAt: nowIso(),
              });
            }
            if (validationErrors.length === 0) {
              finalizedOutput = {
                provider: execution.value.provider,
                model: execution.value.model,
                promptText: effectivePromptText,
                completionPassed: normalizedContractPayload.completionPassed,
                when: normalizedContractPayload.when,
                payload: normalizedContractPayload.payload,
              };
              break;
            }
            if (outputAttempt === maxOutputAttempts) {
              nodeStatus = "failed";
              finalizedOutput = {
                provider: execution.value.provider,
                model: execution.value.model,
                promptText: effectivePromptText,
                completionPassed: false,
                when: {},
                payload: {},
                error: "output_validation_failed",
                validationErrors,
              };
              break;
            }
          } finally {
            if (candidatePath !== undefined) {
              await cleanupReservedCandidateSubmissionPath(candidatePath);
            }
          }
        }
        outputPayload = finalizedOutput ?? {
          provider: "deterministic-local",
          model:
            agentNodePayload?.model ?? executionNodePayload.nodeType ?? "node",
          promptText: effectivePromptText,
          completionPassed: false,
          when: {},
          payload: {},
          error: "provider_error",
        };
      }
      const endedAt = nowIso();
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
      } catch {}
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
                : {
                    inheritFromStepId:
                      backendSessionSelection.inheritFromStepId,
                  }),
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
        ...(outputValidationErrors.length === 0
          ? {}
          : { outputValidationErrors }),
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
        if (
          managerSessionId === undefined ||
          ambientManagerContext === undefined
        ) {
          return;
        }
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
      let managerControl = null;
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
          const nodeExecutions = buildNodeExecutions();
          try {
            await finalizeManagerSession("failed");
          } catch (finalizationError: unknown) {
            const message =
              finalizationError instanceof Error
                ? finalizationError.message
                : "unknown manager session finalization failure";
            const failed: WorkflowSessionState = {
              ...session,
              queue,
              status: "failed",
              currentNodeId: nodeId,
              endedAt,
              nodeExecutionCounter: nextExecutionCounter,
              nodeExecutionCounts: updatedCounts,
              nodeExecutions,
              communicationCounter: session.communicationCounter,
              communications: session.communications,
              nodeBackendSessions: nextNodeBackendSessions,
              lastError: `failed to finalize manager session for ${executionTargetNoun} '${nodeId}': ${message}`,
            };
            await saveSession(failed, options);
            return err({
              exitCode: 1,
              message: failed.lastError ?? "failed to finalize manager session",
            });
          }
          const message =
            error instanceof Error
              ? error.message
              : "unknown manager control parsing failure";
          const failed: WorkflowSessionState = {
            ...session,
            queue,
            status: "failed",
            currentNodeId: nodeId,
            endedAt,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            nodeExecutions,
            communicationCounter: session.communicationCounter,
            communications: session.communications,
            nodeBackendSessions: nextNodeBackendSessions,
            lastError: `invalid manager control for ${executionTargetNoun} '${nodeId}': ${message}`,
          };
          await saveSession(failed, options);
          return err({
            exitCode: 5,
            message: failed.lastError ?? "invalid manager control",
          });
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
              const nodeExecutions = buildNodeExecutions();
              try {
                await finalizeManagerSession("failed");
              } catch (finalizationError: unknown) {
                const message =
                  finalizationError instanceof Error
                    ? finalizationError.message
                    : "unknown manager session finalization failure";
                const failed: WorkflowSessionState = {
                  ...session,
                  queue,
                  status: "failed",
                  currentNodeId: nodeId,
                  endedAt,
                  nodeExecutionCounter: nextExecutionCounter,
                  nodeExecutionCounts: updatedCounts,
                  nodeExecutions,
                  communicationCounter: session.communicationCounter,
                  communications: session.communications,
                  nodeBackendSessions: nextNodeBackendSessions,
                  lastError: `failed to finalize manager session for ${executionTargetNoun} '${nodeId}': ${message}`,
                };
                await saveSession(failed, options);
                return err({
                  exitCode: 1,
                  message:
                    failed.lastError ?? "failed to finalize manager session",
                });
              }
              const failed: WorkflowSessionState = {
                ...session,
                queue,
                status: "failed",
                currentNodeId: nodeId,
                endedAt,
                nodeExecutionCounter: nextExecutionCounter,
                nodeExecutionCounts: updatedCounts,
                nodeExecutions,
                communicationCounter: session.communicationCounter,
                communications: session.communications,
                nodeBackendSessions: nextNodeBackendSessions,
                lastError: `invalid manager control for ${executionTargetNoun} '${nodeId}': manager execution cannot mix GraphQL manager messages with payload managerControl`,
              };
              await saveSession(failed, options);
              return err({
                exitCode: 5,
                message: failed.lastError ?? "invalid manager control",
              });
            }
          } catch (error: unknown) {
            nodeStatus = "failed";
            const nodeExecutions = buildNodeExecutions();
            try {
              await finalizeManagerSession("failed");
            } catch (finalizationError: unknown) {
              const message =
                finalizationError instanceof Error
                  ? finalizationError.message
                  : "unknown manager session finalization failure";
              const failed: WorkflowSessionState = {
                ...session,
                queue,
                status: "failed",
                currentNodeId: nodeId,
                endedAt,
                nodeExecutionCounter: nextExecutionCounter,
                nodeExecutionCounts: updatedCounts,
                nodeExecutions,
                communicationCounter: session.communicationCounter,
                communications: session.communications,
                nodeBackendSessions: nextNodeBackendSessions,
                lastError: `failed to finalize manager session for ${executionTargetNoun} '${nodeId}': ${message}`,
              };
              await saveSession(failed, options);
              return err({
                exitCode: 1,
                message:
                  failed.lastError ?? "failed to finalize manager session",
              });
            }
            const message =
              error instanceof Error
                ? error.message
                : "unknown manager control mode claim failure";
            const failed: WorkflowSessionState = {
              ...session,
              queue,
              status: "failed",
              currentNodeId: nodeId,
              endedAt,
              nodeExecutionCounter: nextExecutionCounter,
              nodeExecutionCounts: updatedCounts,
              nodeExecutions,
              communicationCounter: session.communicationCounter,
              communications: session.communications,
              nodeBackendSessions: nextNodeBackendSessions,
              lastError: `invalid manager control for ${executionTargetNoun} '${nodeId}': ${message}`,
            };
            await saveSession(failed, options);
            return err({
              exitCode: 5,
              message: failed.lastError ?? "invalid manager control",
            });
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
        const nodeExecutions = buildNodeExecutions();
        try {
          await finalizeManagerSession("failed");
        } catch (finalizationError: unknown) {
          const message =
            finalizationError instanceof Error
              ? finalizationError.message
              : "unknown manager session finalization failure";
          const failed: WorkflowSessionState = {
            ...session,
            queue,
            status: "failed",
            currentNodeId: nodeId,
            endedAt,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            nodeExecutions,
            communicationCounter: session.communicationCounter,
            communications: session.communications,
            nodeBackendSessions: nextNodeBackendSessions,
            lastError: `failed to finalize manager session for ${executionTargetNoun} '${nodeId}': ${message}`,
          };
          await saveSession(failed, options);
          return err({
            exitCode: 1,
            message: failed.lastError ?? "failed to finalize manager session",
          });
        }
        await saveSession(
          {
            ...session,
            queue,
            status: "failed",
            currentNodeId: nodeId,
            endedAt,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            nodeExecutions,
            communicationCounter: session.communicationCounter,
            communications: session.communications,
            nodeBackendSessions: nextNodeBackendSessions,
            lastError: optionalManagerDecisionsResult.error,
          },
          options,
        );
        return err({
          exitCode: 5,
          message: optionalManagerDecisionsResult.error,
        });
      }
      const queuedOptionalDecisionNodeIds =
        optionalManagerDecisionsResult.value.queuedNodeIds;
      const pendingOptionalNodeDecisionsAfterManagerActions =
        optionalManagerDecisionsResult.value.pendingOptionalNodeDecisions;
      const nodeExecutions = buildNodeExecutions();
      let currentNodeExecutionCounter = nextExecutionCounter;
      let currentNodeExecutionCounts = updatedCounts;
      let currentNodeExecutions = nodeExecutions;
      let currentNodeBackendSessions = nextNodeBackendSessions;
      try {
        await finalizeManagerSession(
          nodeStatus === "succeeded" ? "completed" : "failed",
        );
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "unknown manager session finalization failure";
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: nextExecutionCounter,
          nodeExecutionCounts: updatedCounts,
          nodeExecutions,
          communicationCounter: session.communicationCounter,
          communications: session.communications,
          nodeBackendSessions: nextNodeBackendSessions,
          lastError: `failed to finalize manager session for ${executionTargetNoun} '${nodeId}': ${message}`,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ?? "failed to finalize manager session",
            failed,
          ),
        );
      }
      const edges = outgoingEdges.get(nodeId) ?? [];
      const matched = edges.filter((edge) => evaluateEdge(edge, outputPayload));
      const loopIterationCounts = session.loopIterationCounts ?? {};
      let selected = matched;
      let updatedLoopIterationCounts = loopIterationCounts;
      if (loopRule !== undefined) {
        const effectiveLoopRule: LoopRule = {
          ...loopRule,
          maxIterations: loopRule.maxIterations ?? maxLoopIterations,
        };
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
          const failed: WorkflowSessionState = {
            ...session,
            queue,
            status: "failed",
            currentNodeId: nodeId,
            endedAt,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            nodeExecutions: [
              ...session.nodeExecutions,
              buildNodeExecutionRecord(),
            ],
            loopIterationCounts: updatedLoopIterationCounts,
            nodeBackendSessions: nextNodeBackendSessions,
            lastError: `loop transition '${transition}' has no matching edge for ${executionTargetNoun} '${nodeId}'`,
          };
          await saveSession(failed, options);
          return err({
            exitCode: 4,
            message: failed.lastError ?? "invalid loop transition",
          });
        }
      }
      const localFanoutEdges = selected.filter(
        (edge) => edge.fanout !== undefined,
      );
      const regularSelected = selected.filter(
        (edge) => edge.fanout === undefined,
      );
      const nextNodes = regularSelected.map((edge) => edge.to);
      const outputJson = stableJson(outputPayload);
      const outputRaw = `${outputJson}\n`;
      const metaPayload = {
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
        ...(outputValidationErrors.length === 0
          ? {}
          : { outputValidationErrors }),
        ...(previousNodeExecId === undefined
          ? {}
          : { restartedFromNodeExecId: previousNodeExecId }),
      };
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
      let currentRuntimeVariables = isWorkflowOutputKindNode(workflow, nodeId)
        ? {
            ...session.runtimeVariables,
            workflowOutput: outputPayload["payload"],
          }
        : session.runtimeVariables;
      const handoffPayload = {
        schemaVersion: 1,
        generatedAt: endedAt,
        nodeId,
        ...stepIdentityFields,
        mailboxInstanceId,
        outputRef,
        inputHash: `sha256:${inputHash}`,
        outputHash: `sha256:${outputHash}`,
        nextNodes,
      };
      const commitMessageTemplate = buildCommitMessageTemplate(
        inputHash,
        outputHash,
        outputRef,
        nextNodes,
      );
      await writeRawTextFile(path.join(artifactDir, "output.json"), outputRaw);
      await writeJsonFile(path.join(artifactDir, "meta.json"), metaPayload);
      await writeJsonFile(
        path.join(artifactDir, "handoff.json"),
        handoffPayload,
      );
      await writeRawTextFile(
        path.join(artifactDir, "commit-message.txt"),
        `${commitMessageTemplate}\n`,
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
            ...(llmMessages.length === 0 ? {} : { llmMessages }),
            inputJson,
            outputJson,
            inputHash: `sha256:${inputHash}`,
            outputHash: `sha256:${outputHash}`,
          },
          options,
        );
      } catch {}
      await emitWorkflowRunEvent(options, {
        type: "step-completed",
        workflowExecutionId: session.sessionId,
        stepId: stepExecutionAddress.stepId,
        nodeExecId,
        status: nodeStatus,
      });
      if (nodeStatus === "timed_out") {
        const authoredTimeoutPolicy = workflow.defaults.timeoutPolicy;
        if (
          options.restartOnStuck !== false &&
          authoredTimeoutPolicy?.onTimeout === "jump-to-step" &&
          authoredTimeoutPolicy.jumpStepId !== undefined
        ) {
          const retriesBeforeJump = authoredTimeoutPolicy.maxRetries ?? 0;
          if (restartAttempt >= retriesBeforeJump) {
            const jumpId = authoredTimeoutPolicy.jumpStepId;
            if (!workflowNodes.has(jumpId)) {
              const failed: WorkflowSessionState = {
                ...session,
                queue,
                status: "failed",
                currentNodeId: nodeId,
                endedAt,
                nodeExecutionCounter: nextExecutionCounter,
                nodeExecutionCounts: updatedCounts,
                nodeExecutions,
                communicationCounter: currentCommunicationCounter,
                communications: currentCommunications,
                nodeBackendSessions: nextNodeBackendSessions,
                lastError: `${executionTargetNoun} timeout at '${nodeId}': timeout policy jump target '${jumpId}' is not a known workflow ${executionTargetNoun}`,
              };
              await saveSession(failed, options);
              return err({
                exitCode: 6,
                message: failed.lastError ?? `${executionTargetNoun} timeout`,
              });
            }
            session = {
              ...session,
              status: "running",
              queue: [...dedupeNodeIds([jumpId, ...queue])],
              currentNodeId: nodeId,
              nodeExecutionCounter: nextExecutionCounter,
              nodeExecutionCounts: updatedCounts,
              nodeExecutions,
              communicationCounter: currentCommunicationCounter,
              communications: currentCommunications,
              nodeBackendSessions: nextNodeBackendSessions,
              lastError: `${executionTargetNoun} timeout at '${nodeId}', jumping to '${jumpId}'`,
            };
            await saveSession(session, options);
            break;
          }
        }
        const { allowRestart, maxRestarts } = resolveTimeoutRestartBudget(
          authoredTimeoutPolicy,
          options,
          restartAttempt,
        );
        if (allowRestart && restartAttempt < maxRestarts) {
          const restartCountForNode =
            (session.restartCounts?.[nodeId] ?? 0) + 1;
          const restartEvents = [
            ...(session.restartEvents ?? []),
            {
              nodeId,
              fromNodeExecId: nodeExecId,
              restartAttempt: restartAttempt + 1,
              reason: "stuck_timeout" as const,
              at: endedAt,
            },
          ];
          session = {
            ...session,
            status: "running",
            queue,
            currentNodeId: nodeId,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            restartCounts: {
              ...(session.restartCounts ?? {}),
              [nodeId]: restartCountForNode,
            },
            restartEvents,
            nodeExecutions,
            communicationCounter: currentCommunicationCounter,
            communications: currentCommunications,
            nodeBackendSessions: nextNodeBackendSessions,
            lastError: `stuck detected for ${executionTargetNoun} '${nodeId}', restarting attempt ${restartAttempt + 1}`,
          };
          await saveSession(session, options);
          previousNodeExecId = nodeExecId;
          restartAttempt += 1;
          if (stuckRestartBackoffMs > 0) {
            await sleep(stuckRestartBackoffMs);
          }
          continue;
        }
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: nextExecutionCounter,
          nodeExecutionCounts: updatedCounts,
          nodeExecutions,
          communicationCounter: currentCommunicationCounter,
          communications: currentCommunications,
          nodeBackendSessions: nextNodeBackendSessions,
          lastError: `${executionTargetNoun} timeout at '${nodeId}'`,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            6,
            failed.lastError ?? `${executionTargetNoun} timeout`,
            failed,
          ),
        );
      }
      if (nodeStatus === "failed") {
        const providerErrMessage = (() => {
          const p = outputPayload["payload"];
          if (typeof p !== "object" || p === null) {
            return undefined;
          }
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
          queue,
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
        return err(
          workflowRunFailure(5, failed.lastError ?? "adapter failure", failed),
        );
      }
      const completion = evaluateCompletion({
        rule: nodeRef.completion,
        output: outputPayload,
      });
      if (!completion.passed) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
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
        return err(
          workflowRunFailure(
            3,
            failed.lastError ?? "completion condition not met",
            failed,
          ),
        );
      }
      const consumedCommunicationsResult = await markCommunicationsConsumed(
        { ...session, communications: currentCommunications },
        upstreamCommunicationIds,
        nodeExecId,
        endedAt,
      );
      if (!consumedCommunicationsResult.ok) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
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
          lastError: consumedCommunicationsResult.error,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ?? "mailbox consumption persistence failed",
            failed,
          ),
        );
      }
      currentCommunications = consumedCommunicationsResult.value;
      const transitionCommunications = await Promise.all(
        regularSelected.map((edge, index) => {
          return persistCommunicationArtifact({
            artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
            runtimeLogOptions: options,
            workflowId: workflow.workflowId,
            workflowExecutionId: session.sessionId,
            communicationCounter: currentCommunicationCounter + index,
            fromNodeId: edge.from,
            toNodeId: edge.to,
            routingScope: "intra-workflow",
            deliveryKind:
              edge.to === edge.from ? "loop-back" : "edge-transition",
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
      currentCommunicationCounter += transitionCommunications.length;
      let currentFanoutGroups: readonly FanoutGroupRunRecord[] | undefined =
        session.fanoutGroups;
      const localFanoutQueuedNodeIds: string[] = [];
      const localFanoutTransitions: Array<{
        readonly from: string;
        readonly to: string;
        readonly when: string;
      }> = [];
      for (const edge of localFanoutEdges) {
        const localFanoutResult = await executeLocalFanoutTransition({
          workflowName,
          workflow,
          session: {
            ...session,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            nodeExecutions,
            communicationCounter: currentCommunicationCounter,
            communications: currentCommunications,
            nodeBackendSessions: nextNodeBackendSessions,
            runtimeVariables: currentRuntimeVariables,
            ...(currentFanoutGroups === undefined
              ? {}
              : { fanoutGroups: currentFanoutGroups }),
          },
          options,
          artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
          callerNodeId: nodeId,
          callerStepId: stepExecutionAddress.stepId,
          callerNodeExecId: nodeExecId,
          callerArtifactDir: artifactDir,
          callerOutputPayload: outputPayload,
          createdAt: endedAt,
          communicationCounter: currentCommunicationCounter,
          currentCommunications,
          adapter: effectiveAdapter,
          guards,
          crossWorkflowInvocationStack,
          edge,
          nodePayloads: nodeMap,
        });
        if (!localFanoutResult.ok) {
          const failed: WorkflowSessionState = {
            ...session,
            queue,
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
            runtimeVariables: currentRuntimeVariables,
            ...(currentFanoutGroups === undefined
              ? {}
              : { fanoutGroups: currentFanoutGroups }),
            lastError: localFanoutResult.error,
          };
          await saveSession(failed, options);
          return err(
            workflowRunFailure(
              1,
              failed.lastError ?? "local fanout execution failed",
              failed,
            ),
          );
        }
        currentCommunications = localFanoutResult.value.communications;
        currentCommunicationCounter =
          localFanoutResult.value.communicationCounter;
        currentRuntimeVariables =
          localFanoutResult.value.runtimeVariables ?? currentRuntimeVariables;
        currentFanoutGroups = localFanoutResult.value.fanoutGroups;
        if (localFanoutResult.value.session !== undefined) {
          currentNodeExecutionCounter =
            localFanoutResult.value.session.nodeExecutionCounter;
          currentNodeExecutionCounts =
            localFanoutResult.value.session.nodeExecutionCounts;
          currentNodeExecutions =
            localFanoutResult.value.session.nodeExecutions;
          currentNodeBackendSessions =
            localFanoutResult.value.session.nodeBackendSessions ??
            currentNodeBackendSessions;
        }
        if (localFanoutResult.value.pausedMessage !== undefined) {
          const paused = localFanoutResult.value.session;
          if (paused === undefined) {
            const failed: WorkflowSessionState = {
              ...session,
              queue,
              status: "failed",
              currentNodeId: nodeId,
              endedAt,
              nodeExecutionCounter: currentNodeExecutionCounter,
              nodeExecutionCounts: currentNodeExecutionCounts,
              nodeExecutions: currentNodeExecutions,
              loopIterationCounts: updatedLoopIterationCounts,
              communicationCounter: currentCommunicationCounter,
              communications: currentCommunications,
              nodeBackendSessions: currentNodeBackendSessions,
              runtimeVariables: currentRuntimeVariables,
              ...(currentFanoutGroups === undefined
                ? {}
                : { fanoutGroups: currentFanoutGroups }),
              lastError:
                "internal: local fanout pause missing paused session state",
            };
            await saveSession(failed, options);
            return err(
              workflowRunFailure(
                1,
                failed.lastError ?? "local fanout pause failed",
                failed,
              ),
            );
          }
          await saveSession(paused, options);
          return ok({ session: paused, exitCode: 4 });
        }
        localFanoutQueuedNodeIds.push(...localFanoutResult.value.queuedNodeIds);
        localFanoutTransitions.push(...localFanoutResult.value.transitions);
        if (localFanoutResult.value.failureMessage !== undefined) {
          const resultSession = localFanoutResult.value.session;
          const terminalStatus =
            resultSession?.status === "cancelled" ? "cancelled" : "failed";
          const failed: WorkflowSessionState = {
            ...session,
            queue,
            status: terminalStatus,
            currentNodeId: nodeId,
            endedAt,
            nodeExecutionCounter: currentNodeExecutionCounter,
            nodeExecutionCounts: currentNodeExecutionCounts,
            nodeExecutions: currentNodeExecutions,
            loopIterationCounts: updatedLoopIterationCounts,
            communicationCounter: currentCommunicationCounter,
            communications: currentCommunications,
            nodeBackendSessions: currentNodeBackendSessions,
            runtimeVariables: currentRuntimeVariables,
            ...(currentFanoutGroups === undefined
              ? {}
              : { fanoutGroups: currentFanoutGroups }),
            lastError: localFanoutResult.value.failureMessage,
          };
          await saveSession(failed, options);
          return err(
            workflowRunFailure(
              terminalStatus === "cancelled" ? 130 : 1,
              failed.lastError ?? "local fanout execution failed",
              failed,
            ),
          );
        }
      }
      const crossWorkflowDispatchResult =
        await executeCrossWorkflowDispatchesForNode({
          workflow,
          workflowName,
          session: {
            ...session,
            nodeExecutionCounter: currentNodeExecutionCounter,
            nodeExecutions: currentNodeExecutions,
            communicationCounter: currentCommunicationCounter,
            communications: currentCommunications,
            runtimeVariables: currentRuntimeVariables,
            ...(currentFanoutGroups === undefined
              ? {}
              : { fanoutGroups: currentFanoutGroups }),
          },
          options,
          artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
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
        });
      if (!crossWorkflowDispatchResult.ok) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: currentNodeExecutionCounter,
          nodeExecutionCounts: currentNodeExecutionCounts,
          nodeExecutions: currentNodeExecutions,
          loopIterationCounts: updatedLoopIterationCounts,
          communicationCounter: currentCommunicationCounter,
          communications: currentCommunications,
          nodeBackendSessions: currentNodeBackendSessions,
          lastError: crossWorkflowDispatchResult.error,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ?? "cross-workflow dispatch execution failed",
            failed,
          ),
        );
      }
      currentCommunications = crossWorkflowDispatchResult.value.communications;
      currentCommunicationCounter =
        crossWorkflowDispatchResult.value.communicationCounter;
      currentRuntimeVariables =
        crossWorkflowDispatchResult.value.runtimeVariables ??
        currentRuntimeVariables;
      if (crossWorkflowDispatchResult.value.failureMessage !== undefined) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: currentNodeExecutionCounter,
          nodeExecutionCounts: currentNodeExecutionCounts,
          nodeExecutions: currentNodeExecutions,
          loopIterationCounts: updatedLoopIterationCounts,
          communicationCounter: currentCommunicationCounter,
          communications: currentCommunications,
          nodeBackendSessions: currentNodeBackendSessions,
          runtimeVariables: currentRuntimeVariables,
          ...(crossWorkflowDispatchResult.value.fanoutGroups === undefined
            ? {}
            : { fanoutGroups: crossWorkflowDispatchResult.value.fanoutGroups }),
          lastError: crossWorkflowDispatchResult.value.failureMessage,
        };
        await saveSession(failed, options);
        return err(
          workflowRunFailure(
            1,
            failed.lastError ?? "cross-workflow dispatch execution failed",
            failed,
          ),
        );
      }
      const transitions = [
        ...session.transitions,
        ...regularSelected.map((edge) => ({
          from: edge.from,
          to: edge.to,
          when: edge.when,
        })),
        ...localFanoutTransitions,
        ...crossWorkflowDispatchResult.value.transitions,
      ];
      const transitionNextNodes = regularSelected.map((edge) => edge.to);
      const retryStepIds = managerControl?.retryStepIds ?? [];
      const nextQueue = [
        ...queue,
        ...transitionNextNodes,
        ...localFanoutQueuedNodeIds,
        ...crossWorkflowDispatchResult.value.queuedNodeIds,
        ...queuedOptionalDecisionNodeIds,
      ].filter((value, index, all) => all.indexOf(value) === index);
      const nextQueueWithRetries = [...nextQueue, ...retryStepIds].filter(
        (value, index, all) => all.indexOf(value) === index,
      );
      session = {
        ...session,
        status: "running",
        queue: nextQueueWithRetries,
        currentNodeId: nodeId,
        nodeExecutionCounter: currentNodeExecutionCounter,
        nodeExecutionCounts: currentNodeExecutionCounts,
        loopIterationCounts: updatedLoopIterationCounts,
        transitions,
        nodeExecutions: currentNodeExecutions,
        communicationCounter: currentCommunicationCounter,
        communications: currentCommunications,
        ...(crossWorkflowDispatchResult.value.fanoutGroups === undefined
          ? currentFanoutGroups === undefined
            ? {}
            : { fanoutGroups: currentFanoutGroups }
          : { fanoutGroups: crossWorkflowDispatchResult.value.fanoutGroups }),
        ...(session.conversationTurns === undefined
          ? {}
          : { conversationTurns: session.conversationTurns }),
        nodeBackendSessions: currentNodeBackendSessions,
        pendingOptionalNodeDecisions: isOptionalExecutionNode
          ? removePendingOptionalNodeDecision(
              pendingOptionalNodeDecisionsAfterManagerActions,
              nodeId,
            )
          : pendingOptionalNodeDecisionsAfterManagerActions,
        runtimeVariables: currentRuntimeVariables,
      };
      await saveSession(session, options);
      break;
    }
  }
  return await finalizeCompletedWorkflowRun({
    session,
    workflow,
    loaded: loaded.value,
    options,
  });
}
