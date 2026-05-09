import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJsonFile as writeJsonFile,
  atomicWriteTextFile as writeRawTextFile,
} from "../shared/fs";
import {
  ScenarioNodeAdapter,
  type AdapterAmbientManagerContext,
  type NodeAdapter,
} from "./adapter";
import { DispatchingNodeAdapter } from "./adapters/dispatch";
import { assembleNodeInput } from "./input-assembly";
import {
  loadWorkflowFromDisk,
  mergeLoadOptionsForSessionMutableBundle,
} from "./load";
import {
  buildAmbientManagerControlPlaneEnvironment,
  createManagerSessionStore,
  hashManagerAuthToken,
  mintManagerAuthToken,
} from "./manager-session-store";
import {
  buildNodeExecutionMailbox,
  writeNodeExecutionMailboxArtifacts,
} from "./node-execution-mailbox";
import { describeWorkflowNodeKind, isManagerNodeRef } from "./node-role";
import { composeExecutionPrompts } from "./prompt-composition";
import { err, ok, type Result } from "./result";
import {
  isWorkflowOutputKindNode,
  resolveBackendSessionSelection,
  resolveRequiredStepExecutionAddress,
  toStepIdentityFields,
} from "./runtime-addressing";
import { saveProcessLogsToRuntimeDb } from "./runtime-db";
import { inspectWorkflowRuntimeReadiness } from "./runtime-readiness";
import {
  isTerminalWorkflowSessionStatus,
  persistNodeBackendSession,
  resolveRequestedBackendSession,
  type NodeExecutionRecord,
  type OutputRef,
  type WorkflowSessionState,
} from "./session";
import { loadSession, saveSession } from "./session-store";
import { getNormalizedNodePayload, type LoadOptions } from "./types";
import { resolveWorkflowExecutionWorkingDirectory } from "./working-directory";
import {
  type CallStepExecutionInput,
  type CallStepExecutionSuccess,
  type CallStepExecutionFailure,
  applyDirectExecutionOverrides,
  buildScenarioExecutableNodePayload,
  buildOutputPublicationPolicy,
  nextNodeExecId,
  nextManagerSessionId,
  nowIso,
  OutputValidator,
  MailboxPublisher,
  resolveOutputValidationAttempts,
  resolveTimeoutMs,
  stableJson,
} from "./call-step-impl-helpers";
import { runNodeExecutionAttempts } from "./call-step-impl-retry";

class ExecutionDispatcher {
  readonly #adapter: NodeAdapter;
  readonly #validator = new OutputValidator();
  readonly #publisher: MailboxPublisher;

  constructor(adapter: NodeAdapter, options: LoadOptions) {
    this.#adapter = adapter;
    this.#publisher = new MailboxPublisher(options);
  }

  async dispatch(
    input: CallStepExecutionInput,
  ): Promise<Result<CallStepExecutionSuccess, CallStepExecutionFailure>> {
    const sessionResult = await loadSession(input.workflowRunId, input);
    if (!sessionResult.ok) {
      const session = {
        sessionId: input.workflowRunId,
        workflowName: "",
        workflowId: input.workflowId,
        status: "running" as const,
        startedAt: nowIso(),
        queue: [],
        nodeExecutionCounter: 0,
        nodeExecutionCounts: {},
        transitions: [],
        nodeExecutions: [],
        communicationCounter: 0,
        communications: [],
        runtimeVariables: {},
      } as WorkflowSessionState;
      return err({
        session,
        exitCode: 1,
        message: sessionResult.error.message,
      });
    }

    let session = sessionResult.value;
    if (isTerminalWorkflowSessionStatus(session.status)) {
      return err({
        session,
        exitCode: 1,
        message: `cannot call step '${input.stepId}' on terminal session '${session.sessionId}' with status '${session.status}'`,
      });
    }
    if (session.workflowId !== input.workflowId) {
      return err({
        session,
        exitCode: 1,
        message: `workflow id mismatch: session '${session.sessionId}' belongs to '${session.workflowId}', not '${input.workflowId}'`,
      });
    }

    const loaded = await loadWorkflowFromDisk(
      session.workflowName,
      mergeLoadOptionsForSessionMutableBundle(input, session),
    );
    if (!loaded.ok) {
      return err({
        session,
        exitCode: loaded.error.code === "VALIDATION" ? 2 : 1,
        message: loaded.error.message,
      });
    }
    if (loaded.value.bundle.workflow.workflowId !== input.workflowId) {
      return err({
        session,
        exitCode: 1,
        message: `workflow '${session.workflowName}' resolved to workflowId '${loaded.value.bundle.workflow.workflowId}', not '${input.workflowId}'`,
      });
    }

    const workflow = loaded.value.bundle.workflow;
    const nodeRef = workflow.nodes.find((entry) => entry.id === input.stepId);
    const nodePayload = getNormalizedNodePayload(
      loaded.value.bundle,
      input.stepId,
    );
    if (nodeRef === undefined || nodePayload === undefined) {
      return err({
        session,
        exitCode: 1,
        message: `missing step definition for '${input.stepId}'`,
      });
    }
    const stepExecutionAddress = resolveRequiredStepExecutionAddress(
      workflow,
      input.stepId,
    );
    if (stepExecutionAddress === undefined) {
      return err({
        session,
        exitCode: 1,
        message: `missing step definition for '${input.stepId}'`,
      });
    }
    const stepIdentityFields = toStepIdentityFields(stepExecutionAddress);
    if (nodeRef.execution?.mode === "optional") {
      return err({
        session,
        exitCode: 1,
        message: `step '${input.stepId}' is optional and must be executed through the workflow scheduler after an owning-manager decision`,
      });
    }
    if (nodePayload.nodeType === "user-action") {
      return err({
        session,
        exitCode: 1,
        message: `step '${input.stepId}' requests nodeType='user-action', but direct step execution is not supported`,
      });
    }

    const nodeWithOverrides = applyDirectExecutionOverrides(
      nodePayload,
      input.overrides,
    );
    if (!nodeWithOverrides.ok) {
      return err({
        session,
        exitCode: 2,
        message: nodeWithOverrides.error,
      });
    }
    const executionTargetNode = nodeWithOverrides.value;

    if (
      this.#adapter instanceof DispatchingNodeAdapter &&
      input.mockScenario === undefined &&
      input.dryRun !== true
    ) {
      const readiness = await inspectWorkflowRuntimeReadiness(
        loaded.value.bundle,
        {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.env === undefined ? {} : { env: input.env }),
          onlyStepIds: new Set([input.stepId]),
        },
      );
      if (!readiness.ready) {
        return err({
          session,
          exitCode: 1,
          message: `workflow runtime readiness failed: ${readiness.blockers.join("; ")}`,
        });
      }
    }
    const agentNodePayload = buildScenarioExecutableNodePayload({
      node: executionTargetNode,
      hasScenarioEntry: input.mockScenario?.[input.stepId] !== undefined,
      allowScenarioFallback: input.mockScenario !== undefined,
      allowDryRun: input.dryRun === true,
    });
    const nativeNodePayload =
      agentNodePayload === null &&
      (executionTargetNode.nodeType === "command" ||
        executionTargetNode.nodeType === "container" ||
        executionTargetNode.nodeType === "addon")
        ? executionTargetNode
        : null;
    const executionNodePayload = agentNodePayload ?? executionTargetNode;
    if (agentNodePayload === null && nativeNodePayload === null) {
      return err({
        session,
        exitCode: 1,
        message: `step '${input.stepId}' is missing executable fields`,
      });
    }
    let workflowWorkingDirectory: string;
    try {
      workflowWorkingDirectory = resolveWorkflowExecutionWorkingDirectory({
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.workflowWorkingDirectory === undefined
          ? {}
          : { workflowWorkingDirectory: input.workflowWorkingDirectory }),
      });
    } catch (error: unknown) {
      return err({
        session,
        exitCode: 2,
        message:
          error instanceof Error
            ? error.message
            : "workingDirectory must be a non-empty path when provided",
      });
    }

    const nextExecutionCounter = session.nodeExecutionCounter + 1;
    const executionIndex = (session.nodeExecutionCounts[input.stepId] ?? 0) + 1;
    const nodeExecId = nextNodeExecId(nextExecutionCounter);
    const mailboxInstanceId = nodeExecId;
    const artifactDir = path.join(
      loaded.value.artifactWorkflowRoot,
      "executions",
      session.sessionId,
      "nodes",
      input.stepId,
      nodeExecId,
    );
    await mkdir(artifactDir, { recursive: true });

    const mergedVariables = {
      ...executionNodePayload.variables,
      ...session.runtimeVariables,
    };

    const assembled = assembleNodeInput({
      runtimeVariables: session.runtimeVariables,
      node: executionNodePayload,
      workflowId: workflow.workflowId,
      workflowDescription: workflow.description,
      nodeKind: describeWorkflowNodeKind(nodeRef),
      upstream: [],
      transcript: (session.conversationTurns ?? []).map((turn) => ({
        conversationId: turn.conversationId,
        turnIndex: turn.turnIndex,
        fromManagerStepId: turn.fromManagerStepId,
        toManagerStepId: turn.toManagerStepId,
        communicationId: turn.communicationId,
        sentAt: turn.sentAt,
      })),
    });
    const executionMailbox = buildNodeExecutionMailbox({
      workflow,
      nodeRef,
      node: executionNodePayload,
      ...stepIdentityFields,
      mailboxInstanceId,
      nodePayloads: loaded.value.bundle.nodePayloads,
      runtimeVariables: session.runtimeVariables,
      basePromptText: assembled.promptText,
      assembledArguments: assembled.arguments,
      upstreamInputs: [],
      ...(input.message === undefined ? {} : { managerMessage: input.message }),
    });
    try {
      await writeNodeExecutionMailboxArtifacts(artifactDir, executionMailbox);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "unknown execution mailbox persistence failure";
      const failedSession: WorkflowSessionState = {
        ...session,
        status: "failed",
        currentNodeId: input.stepId,
        endedAt: nowIso(),
        lastError: `failed to persist execution mailbox for step '${input.stepId}': ${message}`,
      };
      const persisted = await saveSession(failedSession, input);
      return err({
        session: failedSession,
        exitCode: 1,
        message: persisted.ok
          ? (failedSession.lastError ?? "failed to persist execution mailbox")
          : persisted.error.message,
      });
    }
    const timeoutMs = resolveTimeoutMs(
      executionNodePayload,
      workflow.defaults.nodeTimeoutMs,
      input.defaultTimeoutMs,
      input.overrides?.timeoutMs,
    );
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
            ...(backendSessionIdentityFields ?? {}),
            ...(backendSessionSelection?.inheritFromStepId === undefined
              ? {}
              : {
                  inheritFromStepId: backendSessionSelection.inheritFromStepId,
                }),
          });
    const composedPrompts = composeExecutionPrompts({
      promptComposition: {
        workflow,
        nodeRef,
        node: executionNodePayload,
        nodePayloads: loaded.value.bundle.nodePayloads,
        runtimeVariables: session.runtimeVariables,
        basePromptText: assembled.promptText,
        assembledArguments: assembled.arguments,
        upstreamInputs: [],
        executionMailbox,
        ...(input.message === undefined
          ? {}
          : { managerMessage: input.message }),
      },
      includeSessionStartPrompt:
        agentNodePayload !== null && initialBackendSession?.mode !== "reuse",
    });
    const promptText = composedPrompts.promptText;
    const systemPromptText = composedPrompts.systemPromptText;
    const requestedBackendSessionMode = initialBackendSession?.mode;
    const startedAt = nowIso();
    let ambientManagerContext: AdapterAmbientManagerContext | undefined;
    let managerSessionId: string | undefined;
    const managerSessionStore = createManagerSessionStore(input);

    if (isManagerNodeRef(nodeRef) && input.dryRun !== true) {
      managerSessionId = nextManagerSessionId(nodeExecId);
      const managerAuthToken = mintManagerAuthToken();
      ambientManagerContext = {
        environment: buildAmbientManagerControlPlaneEnvironment({
          workflowId: workflow.workflowId,
          workflowExecutionId: session.sessionId,
          managerStepId: input.stepId,
          managerNodeExecId: nodeExecId,
          managerSessionId,
          authToken: managerAuthToken,
          ...(input.env === undefined ? {} : { env: input.env }),
        }),
      };
      await managerSessionStore.createOrResumeSession({
        managerSessionId,
        workflowId: workflow.workflowId,
        workflowExecutionId: session.sessionId,
        managerStepId: input.stepId,
        managerNodeExecId: nodeExecId,
        status: "active",
        createdAt: startedAt,
        updatedAt: startedAt,
        authTokenHash: hashManagerAuthToken(managerAuthToken),
        authTokenExpiresAt: new Date(
          new Date(startedAt).getTime() + timeoutMs + 5 * 60_000,
        ).toISOString(),
      });
    }

    const inputPayload = {
      sessionId: session.sessionId,
      workflowExecutionId: session.sessionId,
      workflowId: workflow.workflowId,
      nodeId: input.stepId,
      ...stepIdentityFields,
      nodeExecId,
      mailboxInstanceId,
      nodeType: executionNodePayload.nodeType ?? "agent",
      ...(agentNodePayload === null ? {} : { model: agentNodePayload.model }),
      ...(agentNodePayload?.systemPromptTemplate === undefined
        ? {}
        : { systemPromptTemplate: agentNodePayload.systemPromptTemplate }),
      promptTemplate: executionNodePayload.promptTemplate,
      ...(agentNodePayload?.sessionStartPromptTemplate === undefined
        ? {}
        : {
            sessionStartPromptTemplate:
              agentNodePayload.sessionStartPromptTemplate,
          }),
      ...(systemPromptText === undefined ? {} : { systemPromptText }),
      promptText,
      arguments: assembled.arguments,
      variables: mergedVariables,
      upstreamOutputRefs: [],
      upstreamCommunications: [],
      executionMailbox,
      ...(input.overrides?.promptVariant === undefined
        ? {}
        : { promptVariant: input.overrides.promptVariant }),
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
      ...(input.overrides?.resumeStepExecId === undefined
        ? {}
        : { resumedFromNodeExecId: input.overrides.resumeStepExecId }),
      ...(input.message === undefined ? {} : { managerMessage: input.message }),
      dryRun: input.dryRun ?? false,
    };
    const inputJson = stableJson(inputPayload);
    await writeRawTextFile(
      path.join(artifactDir, "input.json"),
      `${inputJson}\n`,
    );

    const executionResult = await runNodeExecutionAttempts({
      adapter: this.#adapter,
      validator: this.#validator,
      agentNodePayload,
      nativeNodePayload,
      executionNodePayload,
      session,
      workflowId: workflow.workflowId,
      workflowDescription: workflow.description,
      workflowDirectory: loaded.value.workflowDirectory,
      workflowWorkingDirectory,
      artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
      workflowDefaults: workflow.defaults,
      sessionId: session.sessionId,
      stepId: input.stepId,
      nodeExecId,
      artifactDir,
      executionIndex,
      mergedVariables,
      runtimeVariables: session.runtimeVariables,
      assembledArguments: assembled.arguments,
      executionMailbox,
      promptText,
      systemPromptText,
      initialBackendSession,
      ambientManagerContext,
      timeoutMs,
      dryRun: input.dryRun ?? false,
      ...(input.eventReplyDispatcher === undefined
        ? {}
        : { eventReplyDispatcher: input.eventReplyDispatcher }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.superviserControl === undefined
        ? {}
        : { superviserControl: input.superviserControl }),
      loadOptions: input,
    });

    const {
      nodeStatus,
      outputValidationErrors,
      outputAttemptCount,
      finalOutputPayload,
      processLogs,
      backendSession,
      backendSessionId,
      backendSessionProvider,
    } = executionResult;

    const endedAt = nowIso();
    try {
      await saveProcessLogsToRuntimeDb(
        {
          sessionId: session.sessionId,
          nodeId: input.stepId,
          nodeExecId,
          processLogs,
          at: endedAt,
          ...(stepExecutionAddress.stepId === undefined
            ? {}
            : { executionLogTarget: "step" as const }),
        },
        input,
      );
    } catch {
      // runtime DB process logs are best-effort
    }
    const nodeExecution: NodeExecutionRecord = {
      nodeId: input.stepId,
      ...stepIdentityFields,
      nodeExecId,
      executionOrdinal: nextExecutionCounter,
      mailboxInstanceId,
      status: nodeStatus,
      artifactDir,
      startedAt,
      endedAt,
      ...(outputAttemptCount === 1 ? {} : { outputAttemptCount }),
      ...(outputValidationErrors.length === 0
        ? {}
        : { outputValidationErrors }),
      ...(input.overrides?.promptVariant === undefined
        ? {}
        : { promptVariant: input.overrides.promptVariant }),
      timeoutMs,
      ...(backendSessionId === undefined ? {} : { backendSessionId }),
      ...(requestedBackendSessionMode === undefined
        ? {}
        : { backendSessionMode: requestedBackendSessionMode }),
    };

    const nextNodeBackendSessions =
      agentNodePayload === null
        ? (session.nodeBackendSessions ?? {})
        : persistNodeBackendSession({
            session,
            node: agentNodePayload,
            nodeExecId,
            ...stepIdentityFields,
            ...(stepExecutionAddress.inheritFromStepId === undefined
              ? {}
              : { inheritFromStepId: stepExecutionAddress.inheritFromStepId }),
            provider:
              backendSessionProvider ??
              finalOutputPayload?.["provider"]?.toString() ??
              "unknown-provider",
            endedAt,
            backendSession,
            ...(backendSessionId === undefined
              ? {}
              : { returnedSessionId: backendSessionId }),
          });

    if (managerSessionId !== undefined && ambientManagerContext !== undefined) {
      await managerSessionStore.createOrResumeSession({
        managerSessionId,
        workflowId: workflow.workflowId,
        workflowExecutionId: session.sessionId,
        managerStepId: input.stepId,
        managerNodeExecId: nodeExecId,
        status: nodeStatus === "succeeded" ? "completed" : "failed",
        createdAt: startedAt,
        updatedAt: endedAt,
        authTokenHash: hashManagerAuthToken(
          ambientManagerContext.environment.DIVEDRA_MANAGER_AUTH_TOKEN,
        ),
        authTokenExpiresAt: endedAt,
      });
    }

    session = {
      ...session,
      status: "running",
      currentNodeId: input.stepId,
      nodeExecutionCounter: nextExecutionCounter,
      nodeExecutionCounts: {
        ...session.nodeExecutionCounts,
        [input.stepId]: executionIndex,
      },
      nodeExecutions: [...session.nodeExecutions, nodeExecution],
      nodeBackendSessions: nextNodeBackendSessions,
      ...(finalOutputPayload !== undefined &&
      isWorkflowOutputKindNode(workflow, input.stepId)
        ? {
            runtimeVariables: {
              ...session.runtimeVariables,
              workflowOutput: finalOutputPayload["payload"],
            },
          }
        : {}),
      ...(nodeStatus === "succeeded"
        ? {}
        : {
            lastError: (() => {
              const p = finalOutputPayload?.["payload"];
              if (typeof p === "object" && p !== null) {
                const m = (p as Readonly<Record<string, unknown>>)[
                  "providerErrorMessage"
                ];
                if (typeof m === "string" && m.length > 0) {
                  return m;
                }
              }
              return (
                finalOutputPayload?.["error"]?.toString() ?? "step call failed"
              );
            })(),
          }),
    };

    if (finalOutputPayload === undefined) {
      session = {
        ...session,
        lastError: "step execution produced no output",
      };
      const persisted = await saveSession(session, input);
      return err({
        session,
        nodeExecution,
        exitCode: 1,
        message: persisted.ok
          ? "step execution produced no output"
          : persisted.error.message,
      });
    }

    let outputRef: OutputRef | undefined;
    if (nodeStatus === "succeeded") {
      outputRef = await this.#publisher.publish({
        workflow,
        session,
        node: executionNodePayload,
        nodeExecution,
        artifactDir,
        inputJson,
        outputPayload: finalOutputPayload,
        timeoutMs,
        requestedBackendSessionMode,
      });
    } else {
      await writeRawTextFile(
        path.join(artifactDir, "output.json"),
        `${stableJson(finalOutputPayload)}\n`,
      );
      await writeJsonFile(path.join(artifactDir, "meta.json"), {
        nodeId: input.stepId,
        ...stepIdentityFields,
        nodeExecId,
        mailboxInstanceId,
        status: nodeStatus,
        startedAt,
        endedAt,
        model: executionNodePayload.model,
        ...(input.overrides?.promptVariant === undefined
          ? {}
          : { promptVariant: input.overrides.promptVariant }),
        timeoutMs,
        ...(outputAttemptCount === 1 ? {} : { outputAttemptCount }),
        ...(outputValidationErrors.length === 0
          ? {}
          : { outputValidationErrors }),
      });
    }

    const persisted = await saveSession(session, input);
    if (!persisted.ok) {
      return err({
        session,
        nodeExecution,
        exitCode: 1,
        message: persisted.error.message,
      });
    }

    if (nodeStatus !== "succeeded" || outputRef === undefined) {
      return err({
        session,
        nodeExecution,
        exitCode: nodeStatus === "timed_out" ? 6 : 5,
        message:
          finalOutputPayload["error"]?.toString() ?? "step execution failed",
      });
    }

    return ok({
      session,
      nodeExecution,
      output: finalOutputPayload,
      outputRef,
      exitCode: 0,
    });
  }
}

export async function callStepExecution(
  input: CallStepExecutionInput,
  adapter?: NodeAdapter,
): Promise<Result<CallStepExecutionSuccess, CallStepExecutionFailure>> {
  const effectiveAdapter =
    adapter ??
    (input.mockScenario === undefined
      ? new DispatchingNodeAdapter()
      : new ScenarioNodeAdapter(input.mockScenario));
  return new ExecutionDispatcher(effectiveAdapter, input).dispatch(input);
}
