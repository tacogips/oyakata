import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteTextFile as writeRawTextFile } from "../shared/fs";
import { loadContinuationRelatedSnapshots } from "./history-continuation";
import type { NodeAdapter } from "./adapter";
import { loadSession, saveSession } from "./session-store";
import type { WorkflowSessionState } from "./session";
import { assembleNodeInput } from "./input-assembly";
import {
  buildNodeExecutionMailbox,
  writeNodeExecutionMailboxArtifacts,
} from "./node-execution-mailbox";
import { composeExecutionPrompts } from "./prompt-composition";
import { describeWorkflowNodeKind } from "./node-role";
import { getStructuralEdges, getNormalizedNodePayload } from "./types";
import type { WorkflowEdge } from "./types";
import {
  resolveBackendSessionSelection,
  resolveRequiredStepExecutionAddress,
  toStepIdentityFields,
} from "./runtime-addressing";
import { resolveRequestedBackendSession } from "./session";
import {
  ok,
  err,
  workflowRunFailure,
  type EngineExecutionGuards,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./engine-types";
import { isTerminalStatus } from "./engine-session-helpers";
import {
  dedupeNodeIds,
  findOwningManagerNodeId,
  findPendingOptionalNodeDecision,
  upsertPendingOptionalNodeDecision,
} from "./engine-node-helpers";
import {
  mergeVariables,
  nowIso,
  resolveTimeoutRestartBudget,
  sleep,
  stableJson,
  buildOutputPublicationPolicy,
  resolveOutputValidationAttempts,
} from "./engine-utils";
import { buildUpstreamInputs } from "./engine-upstream-inputs";
import { buildScenarioExecutableNodePayload } from "./engine-session-helpers";
import type { Result } from "./result";
import { initRunState } from "./engine-run-init";
import { completeWorkflowRun } from "./engine-run-complete";
import {
  handleSkipOptionalNode,
  handleUserActionNode,
} from "./engine-run-optional-nodes";
import { executeNodeAttempt } from "./engine-run-exec";
import { processPostExecution } from "./engine-run-post";
import { runNestedSuperviserSessionDriver } from "./engine-run-nested-superviser";
import type { RunWorkflowFn } from "./engine-types";

export async function runWorkflowInternal(
  workflowName: string,
  options: WorkflowRunOptions = {},
  adapter?: NodeAdapter,
  guards?: EngineExecutionGuards,
  crossWorkflowInvocationStack: readonly string[] = [],
  runWorkflowFn?: RunWorkflowFn,
): Promise<Result<WorkflowRunResult, WorkflowRunFailure>> {
  const initResult = await initRunState(workflowName, options, adapter, guards);
  if (!initResult.ok) {
    return initResult;
  }
  const {
    workflowWorkingDirectory,
    loaded,
    workflow,
    stepAddressedExecution,
    executionTargetNoun,
    nodeMap,
    workflowNodes,
    loopRuleByJudgeNodeId,
    effectiveAdapter,
    cancellationProbe,
    managerSessionStore,
  } = initResult.value;
  let { session } = initResult.value;

  if (session.status === "completed") {
    return ok({ session, exitCode: 0 });
  }
  if (
    (session.activeUserActions?.length ?? 0) > 0 &&
    session.status === "paused"
  ) {
    return ok({ session, exitCode: 4 });
  }

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
    const runWorkflowFnResolved: RunWorkflowFn =
      runWorkflowFn ??
      ((name, opts, adapterArg, guardsArg) =>
        (module.exports as { runWorkflow: RunWorkflowFn }).runWorkflow(
          name,
          opts,
          adapterArg,
          guardsArg,
        ));
    return runNestedSuperviserSessionDriver(
      workflowName,
      session,
      loaded,
      options,
      adapter,
      guards,
      crossWorkflowInvocationStack,
      runWorkflowInternal,
      runWorkflowFnResolved,
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

    const queue = [...session.queue];
    const nodeId = queue.shift();
    if (nodeId === undefined) break;

    const nodeRef = workflowNodes.get(nodeId);
    const nodePayload = getNormalizedNodePayload(loaded.bundle, nodeId);
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
          failed.lastError ?? "missing step definition",
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
          { nodeId, owningManagerStepId, requestedAt, status: "pending" },
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
          failed.lastError ?? "invalid step execution payload",
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
      const { nextNodeExecId } = await import("./engine-utils");
      const nodeExecId = nextNodeExecId(nextExecutionCounter);
      const workflowExecutionRoot = path.join(
        loaded.artifactWorkflowRoot,
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
      const upstreamOutputRefs = upstreamInputs.map(
        ({ output: _o, outputRaw: _r, ...ref }) => ref,
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
      try {
        await writeNodeExecutionMailboxArtifacts(artifactDir, executionMailbox);
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
        const result = await handleUserActionNode({
          session,
          queue,
          nodeId,
          nodeExecId,
          stepIdentityFields,
          stepExecutionAddress,
          mailboxInstanceId,
          nextExecutionCounter,
          updatedCounts,
          nodePayload,
          assembledPromptText,
          baseInputPayload,
          artifactDir,
          workflow,
          options,
        });
        return result;
      }

      if (skipOptionalNode) {
        const skipResult = await handleSkipOptionalNode({
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
          executionNodePayload,
          agentNodePayload,
          baseInputPayload,
          upstreamCommunicationIds,
          upstreamInputs,
          artifactDir,
          artifactWorkflowRoot: loaded.artifactWorkflowRoot,
          workflow,
          options,
          outgoingEdges,
          maxLoopIterations,
          loopRule,
          pendingOptionalDecisionReason: pendingOptionalDecision?.reason,
        });
        if (skipResult.kind === "return") return skipResult.result;
        session = skipResult.session;
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
            failed.lastError ?? "invalid step execution payload",
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
      const initialBackendSession =
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
          agentNodePayload !== null && initialBackendSession?.mode !== "reuse",
      });
      const effectivePromptText = composedPrompts.promptText;
      const systemPromptText = composedPrompts.systemPromptText;

      const inputPayload = {
        ...baseInputPayload,
        nodeType: executionNodePayload.nodeType ?? "agent",
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
        ...(initialBackendSession === undefined
          ? {}
          : { backendSession: initialBackendSession }),
      };
      const inputJson = stableJson(inputPayload);
      await writeRawTextFile(
        path.join(artifactDir, "input.json"),
        `${inputJson}\n`,
      );

      const execResult = await executeNodeAttempt({
        session,
        queue,
        nodeId,
        nodeExecId,
        nodeRef,
        stepExecutionAddress,
        artifactDir,
        workflow,
        workflowWorkingDirectory,
        options,
        effectiveAdapter,
        agentNodePayload,
        nativeNodePayload,
        executionNodePayload,
        effectivePromptText,
        systemPromptText,
        assembledArguments,
        upstreamCommunicationIds,
        executionMailbox,
        restartAttempt,
        mergedVariables,
        nextCount,
        managerSessionStore,
        executionTargetNoun,
        workflowDirectory: loaded.workflowDirectory,
        loadedArtifactWorkflowRoot: loaded.artifactWorkflowRoot,
      });
      if (!execResult.ok) return execResult;
      const exec = execResult.value;
      const endedAt = nowIso();

      const postResult = await processPostExecution({
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
        artifactWorkflowRoot: loaded.artifactWorkflowRoot,
        workflow,
        workflowName,
        options,
        outgoingEdges,
        maxLoopIterations,
        effectiveAdapter,
        guards,
        crossWorkflowInvocationStack,
        runWorkflowInternalFn: runWorkflowInternal,
        startedAt: exec.startedAt,
        endedAt,
        managerSessionId: exec.managerSessionId,
        ambientManagerContext: exec.ambientManagerContext,
        nodeStatus: exec.nodeStatus,
        outputPayload: exec.outputPayload,
        processLogs: exec.processLogs,
        backendSession: exec.backendSession,
        backendSessionId: exec.backendSessionId,
        backendSessionProvider: exec.backendSessionProvider,
        backendSessionSelection,
        backendSessionIdentityFields,
        agentNodePayload,
        outputAttemptCount: exec.outputAttemptCount,
        outputValidationErrors: exec.outputValidationErrors,
        requestedBackendSessionMode: exec.requestedBackendSessionMode,
        inputJson,
        timeoutMs: exec.timeoutMs,
        restartAttempt,
        previousNodeExecId,
        isOptionalExecutionNode,
        upstreamCommunicationIds,
        managerSessionStore,
      });

      if (postResult.kind === "return") return postResult.result;

      if (postResult.kind === "timed-out") {
        const {
          session: baseSession,
          nodeExecutions,
          updatedCounts: toCounts,
          nextExecutionCounter: toExecCounter,
          communicationCounter,
          communications,
          nodeBackendSessions,
          endedAt: timedOutAt,
        } = postResult;
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
                ...baseSession,
                queue,
                status: "failed",
                currentNodeId: nodeId,
                endedAt: timedOutAt,
                nodeExecutionCounter: toExecCounter,
                nodeExecutionCounts: toCounts,
                nodeExecutions,
                communicationCounter,
                communications,
                nodeBackendSessions,
                lastError: `jump-to-step target '${jumpId}' is not a known ${executionTargetNoun}`,
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
            session = {
              ...baseSession,
              status: "running",
              queue: [...dedupeNodeIds([jumpId, ...queue])],
              currentNodeId: nodeId,
              nodeExecutionCounter: toExecCounter,
              nodeExecutionCounts: toCounts,
              nodeExecutions,
              communicationCounter,
              communications,
              nodeBackendSessions,
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
            (baseSession.restartCounts?.[nodeId] ?? 0) + 1;
          session = {
            ...baseSession,
            status: "running",
            queue,
            currentNodeId: nodeId,
            nodeExecutionCounter: toExecCounter,
            nodeExecutionCounts: toCounts,
            restartCounts: {
              ...(baseSession.restartCounts ?? {}),
              [nodeId]: restartCountForNode,
            },
            restartEvents: [
              ...(baseSession.restartEvents ?? []),
              {
                nodeId,
                fromNodeExecId: nodeExecId,
                restartAttempt: restartAttempt + 1,
                reason: "stuck_timeout" as const,
                at: timedOutAt,
              },
            ],
            nodeExecutions,
            communicationCounter,
            communications,
            nodeBackendSessions,
            lastError: `stuck detected for ${executionTargetNoun} '${nodeId}', restarting attempt ${restartAttempt + 1}`,
          };
          await saveSession(session, options);
          previousNodeExecId = nodeExecId;
          restartAttempt += 1;
          if (stuckRestartBackoffMs > 0) await sleep(stuckRestartBackoffMs);
          continue;
        }
        const failed: WorkflowSessionState = {
          ...baseSession,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: timedOutAt,
          nodeExecutionCounter: toExecCounter,
          nodeExecutionCounts: toCounts,
          nodeExecutions,
          communicationCounter,
          communications,
          nodeBackendSessions,
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

      session = postResult.session;
      break;
    }
  }

  const beforeComplete = await loadSession(session.sessionId, options);
  if (beforeComplete.ok && isTerminalStatus(beforeComplete.value.status)) {
    if (beforeComplete.value.status === "completed") {
      return ok({ session: beforeComplete.value, exitCode: 0 });
    }
    const exitCode = beforeComplete.value.status === "cancelled" ? 130 : 1;
    return err(
      workflowRunFailure(
        exitCode,
        beforeComplete.value.lastError ??
          `session ${beforeComplete.value.status}`,
        beforeComplete.value,
      ),
    );
  }

  return completeWorkflowRun({
    session,
    options,
    loaded,
    workflow,
    stepAddressedExecution,
    executionTargetNoun,
  });
}
