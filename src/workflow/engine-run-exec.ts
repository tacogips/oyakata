import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  buildAdapterDivedraHookContext,
  type AdapterAmbientManagerContext,
  type AdapterBackendSessionInput,
  type AdapterProcessLog,
  type NodeAdapter,
} from "./adapter";
import {
  executeAdapterWithTimeout,
  executeNativeNodeWithTimeout,
} from "./adapter-execution";
import {
  buildAmbientManagerControlPlaneEnvironment,
  hashManagerAuthToken,
  mintManagerAuthToken,
  type ManagerSessionStore,
} from "./manager-session-store";
import { isManagerNodeRef } from "./node-role";
import { validateJsonValueAgainstSchema } from "./json-schema";
import type { JsonSchemaValidationError } from "./json-schema";
import { resolveBackendSessionSelection } from "./runtime-addressing";
import type { ResolvedStepExecutionAddress } from "./runtime-addressing";
import { buildSupervisionStallWatch } from "./superviser";
import {
  resolveRequestedBackendSession,
  type NodeExecutionRecord,
  type WorkflowSessionState,
} from "./session";
import { saveSession } from "./session-store";
import type { WorkflowJson, AgentNodePayload, NodePayload } from "./types";
import type { WorkflowNodeRef } from "./types-base";
import type { NodeExecutionMailbox } from "./node-execution-mailbox";
import {
  err,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
} from "./engine-types";
import {
  addMillisecondsToIso,
  buildOutputPromptText,
  buildOutputPublicationPolicy,
  buildReservedCandidateSubmissionPath,
  cleanupReservedCandidateSubmissionPath,
  formatOutputValidationErrors,
  nextManagerSessionId,
  nextOutputAttemptId,
  NON_CONTRACT_CANDIDATE_FILE_ERROR,
  nowIso,
  resolveOutputValidationAttempts,
  resolveTimeoutMs,
} from "./engine-utils";
import { resolveCandidatePayload } from "./engine-output-candidate";
import type { Result } from "./result";
import { resolveNodeExecutionWorkingDirectory } from "./working-directory";
import { atomicWriteJsonFile as writeJsonFile } from "../shared/fs";

export interface NodeExecOutput {
  readonly outputPayload: Readonly<Record<string, unknown>>;
  readonly nodeStatus: NodeExecutionRecord["status"];
  readonly processLogs: readonly AdapterProcessLog[];
  readonly backendSessionId: string | undefined;
  readonly backendSessionProvider: string | undefined;
  readonly outputAttemptCount: number;
  readonly outputValidationErrors: readonly JsonSchemaValidationError[];
  readonly startedAt: string;
  readonly timeoutMs: number;
  readonly ambientManagerContext: AdapterAmbientManagerContext | undefined;
  readonly managerSessionId: string | undefined;
  readonly requestedBackendSessionMode: "new" | "reuse" | undefined;
  readonly backendSession: AdapterBackendSessionInput | undefined;
}

export interface ExecuteNodeAttemptInput {
  readonly session: WorkflowSessionState;
  readonly queue: readonly string[];
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly nodeRef: WorkflowNodeRef;
  readonly stepExecutionAddress: ResolvedStepExecutionAddress;
  readonly artifactDir: string;
  readonly workflow: WorkflowJson;
  readonly workflowWorkingDirectory: string;
  readonly options: WorkflowRunOptions;
  readonly effectiveAdapter: NodeAdapter;
  readonly agentNodePayload: AgentNodePayload | null;
  readonly nativeNodePayload: NodePayload | null;
  readonly executionNodePayload: NodePayload;
  readonly effectivePromptText: string;
  readonly systemPromptText: string | undefined;
  readonly assembledArguments: Readonly<Record<string, unknown>> | null;
  readonly upstreamCommunicationIds: readonly string[];
  readonly executionMailbox: NodeExecutionMailbox;
  readonly restartAttempt: number;
  readonly mergedVariables: Readonly<Record<string, unknown>>;
  readonly nextCount: number;
  readonly managerSessionStore: ManagerSessionStore;
  readonly executionTargetNoun: string;
  readonly workflowDirectory: string;
  readonly loadedArtifactWorkflowRoot: string;
}

export async function executeNodeAttempt(
  input: ExecuteNodeAttemptInput,
): Promise<Result<NodeExecOutput, WorkflowRunFailure>> {
  const {
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
    restartAttempt,
    mergedVariables,
    nextCount,
    managerSessionStore,
    executionTargetNoun,
    workflowDirectory,
    loadedArtifactWorkflowRoot,
  } = input;

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
        queue: [...queue],
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

  const backendSessionSelection =
    agentNodePayload === null
      ? undefined
      : resolveBackendSessionSelection(stepExecutionAddress, agentNodePayload);
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
                inheritFromStepId: backendSessionSelection.inheritFromStepId,
              }),
        });
  const requestedBackendSessionMode = backendSession?.mode;
  let backendSessionId: string | undefined = backendSession?.sessionId;
  let backendSessionProvider: string | undefined;

  const hasOutputContract = executionNodePayload.output !== undefined;
  const maxOutputAttempts =
    resolveOutputValidationAttempts(executionNodePayload);

  let outputPayload: Readonly<Record<string, unknown>> | undefined;
  let nodeStatus: NodeExecutionRecord["status"] = "succeeded";
  let outputValidationErrors: readonly JsonSchemaValidationError[] = [];
  let outputAttemptCount = 1;
  let processLogs: readonly AdapterProcessLog[] = [];

  if (options.dryRun === true) {
    outputPayload = {
      provider: "dry-run",
      model: agentNodePayload?.model ?? executionNodePayload.nodeType ?? "node",
      promptText: input.effectivePromptText,
      completionPassed: true,
      when: { always: true },
      payload: {},
    };
  } else {
    for (
      let outputAttempt = 1;
      outputAttempt <= maxOutputAttempts;
      outputAttempt += 1
    ) {
      outputAttemptCount = outputAttempt;
      const outputAttemptId =
        executionNodePayload.output === undefined
          ? undefined
          : nextOutputAttemptId(outputAttempt);
      const attemptDir =
        outputAttemptId === undefined
          ? undefined
          : path.join(artifactDir, "output-attempts", outputAttemptId);
      const requestPath =
        attemptDir === undefined
          ? undefined
          : path.join(attemptDir, "request.json");
      const validationPath =
        attemptDir === undefined
          ? undefined
          : path.join(attemptDir, "validation.json");
      const candidateArtifactPath =
        attemptDir === undefined
          ? undefined
          : path.join(attemptDir, "candidate.json");
      const currentCandidatePath =
        outputAttemptId === undefined || agentNodePayload === null
          ? undefined
          : buildReservedCandidateSubmissionPath({
              workflowId: workflow.workflowId,
              workflowExecutionId: session.sessionId,
              nodeId,
              nodeExecId,
              outputAttemptId,
            });

      if (
        attemptDir !== undefined &&
        requestPath !== undefined &&
        currentCandidatePath !== undefined
      ) {
        await mkdir(attemptDir, { recursive: true });
        await mkdir(path.dirname(currentCandidatePath), { recursive: true });
        await rm(currentCandidatePath, { force: true });
      }

      const executionPromptText =
        currentCandidatePath === undefined || agentNodePayload === null
          ? input.effectivePromptText
          : buildOutputPromptText({
              basePromptText: input.effectivePromptText,
              node: executionNodePayload,
              candidatePath: currentCandidatePath,
              validationErrors: outputValidationErrors,
            });

      const retryValidationFeedback = formatOutputValidationErrors(
        outputValidationErrors,
      );
      if (requestPath !== undefined && currentCandidatePath !== undefined) {
        await writeJsonFile(requestPath, {
          attempt: outputAttempt,
          promptText: executionPromptText,
          candidatePath: currentCandidatePath,
          validationErrors: retryValidationFeedback,
        });
      }

      const adapterOutputContract =
        hasOutputContract &&
        agentNodePayload !== null &&
        executionNodePayload.output !== undefined &&
        currentCandidatePath !== undefined
          ? {
              ...(executionNodePayload.output.description === undefined
                ? {}
                : { description: executionNodePayload.output.description }),
              ...(executionNodePayload.output.jsonSchema === undefined
                ? {}
                : { jsonSchema: executionNodePayload.output.jsonSchema }),
              maxValidationAttempts: maxOutputAttempts,
              attempt: outputAttempt,
              candidatePath: currentCandidatePath,
              validationErrors: formatOutputValidationErrors(
                outputValidationErrors,
              ),
              publication: buildOutputPublicationPolicy(),
            }
          : undefined;

      const supervisionStall = buildSupervisionStallWatch(session, options);
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
                ...(input.systemPromptText === undefined
                  ? {}
                  : { systemPromptText: input.systemPromptText }),
                promptText: executionPromptText,
                arguments: input.assembledArguments,
                executionIndex: nextCount,
                artifactDir,
                upstreamCommunicationIds: input.upstreamCommunicationIds,
                executionMailbox: input.executionMailbox,
                divedraHookContext: buildAdapterDivedraHookContext({
                  workflowId: workflow.workflowId,
                  workflowExecutionId: session.sessionId,
                  nodeId,
                  nodeExecId,
                  ...(agentNodePayload.executionBackend === undefined
                    ? {}
                    : {
                        agentBackend: agentNodePayload.executionBackend,
                      }),
                }),
                ...(backendSession === undefined ? {} : { backendSession }),
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
              workflowDirectory: workflowDirectory,
              workflowWorkingDirectory,
              artifactWorkflowRoot: loadedArtifactWorkflowRoot,
              workflowId: workflow.workflowId,
              workflowDescription: workflow.description,
              workflowExecutionId: session.sessionId,
              nodeId,
              nodeExecId,
              node: nativeNodePayload ?? executionNodePayload,
              workflowDefaults: workflow.defaults,
              runtimeVariables: session.runtimeVariables,
              mergedVariables,
              arguments: input.assembledArguments,
              artifactDir,
              executionMailbox: input.executionMailbox,
              ...(options.eventReplyDispatcher === undefined
                ? {}
                : { chatReplyDispatcher: options.eventReplyDispatcher }),
              ...(options.env === undefined ? {} : { env: options.env }),
              ...(options.superviserControl === undefined
                ? {}
                : { superviserControl: options.superviserControl }),
              timeoutMs,
              ...(supervisionStall === undefined ? {} : { supervisionStall }),
            });

      if (!execution.ok) {
        processLogs = [...processLogs, ...(execution.error.processLogs ?? [])];
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
            outputPayload = {
              provider: "deterministic-local",
              model:
                agentNodePayload?.model ??
                executionNodePayload.nodeType ??
                "node",
              promptText: input.effectivePromptText,
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
        outputPayload = {
          provider: "deterministic-local",
          model:
            agentNodePayload?.model ?? executionNodePayload.nodeType ?? "node",
          promptText: input.effectivePromptText,
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
      processLogs = [...processLogs, ...(execution.value.processLogs ?? [])];
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
        outputPayload = {
          provider: execution.value.provider,
          model: execution.value.model,
          promptText: input.effectivePromptText,
          completionPassed: false,
          when: {},
          payload: {},
          error: "invalid_output",
          validationErrors: outputValidationErrors,
        };
        break;
      }

      if (!hasOutputContract) {
        outputPayload = {
          provider: execution.value.provider,
          model: execution.value.model,
          promptText: input.effectivePromptText,
          completionPassed: execution.value.completionPassed,
          when: execution.value.when,
          payload: execution.value.payload,
        };
        break;
      }
      const candidateResult =
        currentCandidatePath === undefined
          ? { ok: true as const, value: execution.value.payload }
          : await resolveCandidatePayload({
              expectedCandidatePath: currentCandidatePath,
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
          !candidateResult.error.retryable ||
          outputAttempt >= maxOutputAttempts
        ) {
          if (currentCandidatePath !== undefined) {
            await cleanupReservedCandidateSubmissionPath(currentCandidatePath);
          }
          nodeStatus = "failed";
          outputPayload = {
            provider: execution.value.provider,
            model: execution.value.model,
            promptText: input.effectivePromptText,
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
        if (currentCandidatePath !== undefined) {
          await cleanupReservedCandidateSubmissionPath(currentCandidatePath);
        }
        continue;
      }

      const candidatePayload = candidateResult.value;
      if (candidateArtifactPath !== undefined) {
        await writeJsonFile(candidateArtifactPath, candidatePayload);
      }
      const schema = executionNodePayload.output?.jsonSchema;
      if (schema !== undefined) {
        const validationErrors = validateJsonValueAgainstSchema({
          schema: schema,
          value: candidatePayload,
        });
        outputValidationErrors = validationErrors;
        if (validationErrors.length > 0) {
          if (validationPath !== undefined) {
            await writeJsonFile(validationPath, {
              valid: false,
              errors: validationErrors,
              rejectedAt: nowIso(),
            });
          }
          if (outputAttempt < maxOutputAttempts) {
            if (currentCandidatePath !== undefined) {
              await cleanupReservedCandidateSubmissionPath(
                currentCandidatePath,
              );
            }
            continue;
          }
          if (currentCandidatePath !== undefined) {
            await cleanupReservedCandidateSubmissionPath(currentCandidatePath);
          }
          nodeStatus = "failed";
          outputPayload = {
            provider: execution.value.provider,
            model: execution.value.model,
            promptText: input.effectivePromptText,
            completionPassed: false,
            when: {},
            payload: {},
            error: "output_validation_failed",
            validationErrors,
          };
          break;
        }
        outputValidationErrors = [];
        if (validationPath !== undefined) {
          await writeJsonFile(validationPath, {
            valid: true,
            errors: [],
            validatedAt: nowIso(),
          });
        }
      } else {
        outputValidationErrors = [];
      }
      if (currentCandidatePath !== undefined) {
        await cleanupReservedCandidateSubmissionPath(currentCandidatePath);
      }

      outputPayload = {
        provider: execution.value.provider,
        model: execution.value.model,
        promptText: input.effectivePromptText,
        completionPassed: execution.value.completionPassed,
        when: execution.value.when,
        payload: candidatePayload,
      };
      break;
    }
    if (outputPayload === undefined) {
      nodeStatus = "failed";
      outputPayload = {
        provider: "deterministic-local",
        model:
          agentNodePayload?.model ?? executionNodePayload.nodeType ?? "node",
        promptText: input.effectivePromptText,
        completionPassed: false,
        when: {},
        payload: {},
        error: "provider_error",
      };
    }
  }

  return {
    ok: true,
    value: {
      outputPayload,
      nodeStatus,
      processLogs,
      backendSessionId,
      backendSessionProvider,
      outputAttemptCount,
      outputValidationErrors,
      startedAt,
      timeoutMs,
      ambientManagerContext,
      managerSessionId,
      requestedBackendSessionMode,
      backendSession,
    },
  };
}
