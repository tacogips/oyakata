import { loadWorkflowFromDisk, type LoadedWorkflow } from "./load";
import { createExecutionCopyMutableWorkspace } from "./mutable-workspace";
import { resolveEffectiveRoots } from "./paths";
import {
  loadContinuationRelatedSnapshots,
  resolveContinuationAnchorPlacement,
} from "./history-continuation";
import { ScenarioNodeAdapter, type NodeAdapter } from "./adapter";
import { DispatchingNodeAdapter } from "./adapters/dispatch";
import { inspectWorkflowRuntimeReadiness } from "./runtime-readiness";
import { loadSession, saveSession } from "./session-store";
import {
  createSessionId,
  createSessionState,
  type WorkflowSessionState,
} from "./session";
import { createManagerSessionStore } from "./manager-session-store";
import { resolveWorkflowExecutionWorkingDirectory } from "./working-directory";
import { getStructuralLoops, resolveWorkflowManagerStepId } from "./types";
import type { LoopRule, NodePayload, WorkflowJson } from "./types";
import type { WorkflowNodeRef } from "./types-base";
import {
  err,
  ok,
  workflowRunFailure,
  type CancellationProbe,
  type EngineExecutionGuards,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
} from "./engine-types";
import {
  cloneSession,
  cloneSupervisionForContinuedRun,
  createInitialSupervisionRunState,
} from "./engine-session-helpers";
import { persistExternalMailboxInputCommunication } from "./engine-communications";
import type { Result } from "./result";
import type { SupervisionRunState } from "./types";
import type { ManagerSessionStore } from "./manager-session-store";

export interface EngineRunInitResult {
  readonly workflowWorkingDirectory: string;
  readonly loaded: LoadedWorkflow;
  readonly workflow: WorkflowJson;
  readonly stepAddressedExecution: boolean;
  readonly executionTargetNoun: string;
  readonly nodeMap: Readonly<Record<string, NodePayload>>;
  readonly workflowNodes: Map<string, WorkflowNodeRef>;
  readonly loopRuleByJudgeNodeId: Map<string, LoopRule>;
  readonly effectiveAdapter: NodeAdapter;
  readonly cancellationProbe: CancellationProbe;
  readonly managerSessionStore: ManagerSessionStore;
  readonly session: WorkflowSessionState;
}

export async function initRunState(
  workflowName: string,
  options: WorkflowRunOptions,
  adapter: NodeAdapter | undefined,
  guards: EngineExecutionGuards | undefined,
): Promise<Result<EngineRunInitResult, WorkflowRunFailure>> {
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

    session = createSessionState({
      sessionId: createSessionId({ workflowId: workflow.workflowId }),
      workflowName,
      workflowId: workflow.workflowId,
      initialNodeId: rerunTargetId,
      runtimeVariables: {
        ...source.runtimeVariables,
        ...runtimeVariables,
      },
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
      sessionId: createSessionId({ workflowId: workflow.workflowId }),
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
      return ok({
        workflowWorkingDirectory,
        loaded: loaded.value,
        workflow,
        stepAddressedExecution,
        executionTargetNoun,
        nodeMap,
        workflowNodes,
        loopRuleByJudgeNodeId,
        effectiveAdapter,
        cancellationProbe,
        managerSessionStore,
        session,
      });
    }
    if ((session.activeUserActions?.length ?? 0) > 0) {
      if (options.autoImprove !== undefined) {
        await saveSession(session, options);
      }
      return ok({
        workflowWorkingDirectory,
        loaded: loaded.value,
        workflow,
        stepAddressedExecution,
        executionTargetNoun,
        nodeMap,
        workflowNodes,
        loopRuleByJudgeNodeId,
        effectiveAdapter,
        cancellationProbe,
        managerSessionStore,
        session,
      });
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
      initialNodeId: resolveWorkflowManagerStepId(workflow),
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

  return ok({
    workflowWorkingDirectory,
    loaded: loaded.value,
    workflow,
    stepAddressedExecution,
    executionTargetNoun,
    nodeMap,
    workflowNodes,
    loopRuleByJudgeNodeId,
    effectiveAdapter,
    cancellationProbe,
    managerSessionStore,
    session,
  });
}
