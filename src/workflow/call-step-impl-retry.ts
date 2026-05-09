import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJsonFile as writeJsonFile } from "../shared/fs";
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
import type { NodeExecutionMailbox } from "./node-execution-mailbox";
import type { JsonSchemaValidationError } from "./json-schema";
import { buildSupervisionStallWatch } from "./superviser";
import { resolveNodeExecutionWorkingDirectory } from "./working-directory";
import type {
  AgentNodePayload,
  ChatReplyDispatcher,
  LoadOptions,
  NodePayload,
  WorkflowJson,
} from "./types";
import type { WorkflowSessionState, NodeExecutionRecord } from "./session";
import type { SuperviserRuntimeControl } from "./superviser-control";
import {
  buildOutputPromptText,
  buildOutputPublicationPolicy,
  buildReservedCandidateSubmissionPath,
  cleanupReservedCandidateSubmissionPath,
  formatOutputValidationErrors,
  NON_CONTRACT_CANDIDATE_FILE_ERROR,
  nowIso,
  nextOutputAttemptId,
  type OutputValidator,
  resolveOutputValidationAttempts,
} from "./call-step-impl-helpers";

export interface NodeExecutionAttemptsInput {
  readonly adapter: NodeAdapter;
  readonly validator: OutputValidator;
  readonly agentNodePayload: AgentNodePayload | null;
  readonly nativeNodePayload: NodePayload | null;
  readonly executionNodePayload: NodePayload;
  readonly session: WorkflowSessionState;
  readonly workflowId: string;
  readonly workflowDescription: string;
  readonly workflowDirectory: string;
  readonly workflowWorkingDirectory: string;
  readonly artifactWorkflowRoot: string;
  readonly workflowDefaults: WorkflowJson["defaults"];
  readonly sessionId: string;
  readonly stepId: string;
  readonly nodeExecId: string;
  readonly artifactDir: string;
  readonly executionIndex: number;
  readonly mergedVariables: Readonly<Record<string, unknown>>;
  readonly runtimeVariables: Readonly<Record<string, unknown>>;
  readonly assembledArguments: Readonly<Record<string, unknown>> | null;
  readonly executionMailbox: NodeExecutionMailbox;
  readonly promptText: string;
  readonly systemPromptText: string | undefined;
  readonly initialBackendSession: AdapterBackendSessionInput | undefined;
  readonly ambientManagerContext: AdapterAmbientManagerContext | undefined;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
  readonly eventReplyDispatcher?: ChatReplyDispatcher;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly superviserControl?: SuperviserRuntimeControl;
  readonly loadOptions: LoadOptions;
}

export interface NodeExecutionAttemptsResult {
  readonly nodeStatus: NodeExecutionRecord["status"];
  readonly outputValidationErrors: readonly JsonSchemaValidationError[];
  readonly outputAttemptCount: number;
  readonly finalOutputPayload: Readonly<Record<string, unknown>> | undefined;
  readonly processLogs: readonly AdapterProcessLog[];
  readonly backendSession: AdapterBackendSessionInput | undefined;
  readonly backendSessionId: string | undefined;
  readonly backendSessionProvider: string | undefined;
}

export async function runNodeExecutionAttempts(
  ctx: NodeExecutionAttemptsInput,
): Promise<NodeExecutionAttemptsResult> {
  let nodeStatus: NodeExecutionRecord["status"] = "succeeded";
  let outputValidationErrors: readonly JsonSchemaValidationError[] = [];
  let outputAttemptCount = 1;
  let finalOutputPayload: Readonly<Record<string, unknown>> | undefined;
  let processLogs: readonly AdapterProcessLog[] = [];
  let backendSession = ctx.initialBackendSession;
  let backendSessionId = ctx.initialBackendSession?.sessionId;
  let backendSessionProvider: string | undefined;

  if (ctx.dryRun) {
    finalOutputPayload = {
      provider: "dry-run",
      model:
        ctx.agentNodePayload?.model ??
        `${ctx.executionNodePayload.nodeType ?? "agent"}-dry-run`,
      ...(ctx.systemPromptText === undefined
        ? {}
        : { systemPromptText: ctx.systemPromptText }),
      promptText: ctx.promptText,
      completionPassed: true,
      when: { always: true },
      payload: { skippedExecution: true },
    };
  } else {
    const maxAttempts = resolveOutputValidationAttempts(
      ctx.executionNodePayload,
    );
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      outputAttemptCount = attempt;
      const outputAttemptId =
        ctx.executionNodePayload.output === undefined
          ? undefined
          : nextOutputAttemptId(attempt);
      const attemptDir =
        outputAttemptId === undefined
          ? undefined
          : path.join(ctx.artifactDir, "output-attempts", outputAttemptId);
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
      const candidatePath =
        outputAttemptId === undefined || ctx.agentNodePayload === null
          ? undefined
          : buildReservedCandidateSubmissionPath({
              workflowId: ctx.workflowId,
              workflowExecutionId: ctx.sessionId,
              nodeId: ctx.stepId,
              nodeExecId: ctx.nodeExecId,
              outputAttemptId,
            });
      if (
        attemptDir !== undefined &&
        requestPath !== undefined &&
        candidatePath !== undefined
      ) {
        await mkdir(attemptDir, { recursive: true });
        await mkdir(path.dirname(candidatePath), { recursive: true });
        await rm(candidatePath, { force: true });
      }
      const executionPromptText =
        candidatePath === undefined || ctx.agentNodePayload === null
          ? ctx.promptText
          : buildOutputPromptText({
              basePromptText: ctx.promptText,
              node: ctx.agentNodePayload,
              candidatePath,
              validationErrors: outputValidationErrors,
            });
      const retryValidationFeedback = formatOutputValidationErrors(
        outputValidationErrors,
      );
      if (requestPath !== undefined && candidatePath !== undefined) {
        await writeJsonFile(requestPath, {
          attempt,
          promptText: executionPromptText,
          candidatePath,
          validationErrors: retryValidationFeedback,
        });
      }

      const supervisionStall = buildSupervisionStallWatch(
        ctx.session,
        ctx.loadOptions,
      );
      const execution =
        ctx.agentNodePayload !== null
          ? await executeAdapterWithTimeout(
              ctx.adapter,
              {
                workflowId: ctx.workflowId,
                workflowExecutionId: ctx.sessionId,
                nodeId: ctx.stepId,
                nodeExecId: ctx.nodeExecId,
                node: ctx.agentNodePayload,
                workingDirectory: resolveNodeExecutionWorkingDirectory(
                  ctx.workflowWorkingDirectory,
                  ctx.agentNodePayload.workingDirectory,
                ),
                mergedVariables: ctx.mergedVariables,
                ...(ctx.systemPromptText === undefined
                  ? {}
                  : { systemPromptText: ctx.systemPromptText }),
                promptText: executionPromptText,
                arguments: ctx.assembledArguments,
                executionIndex: ctx.executionIndex,
                artifactDir: ctx.artifactDir,
                upstreamCommunicationIds: [],
                executionMailbox: ctx.executionMailbox,
                divedraHookContext: buildAdapterDivedraHookContext({
                  workflowId: ctx.workflowId,
                  workflowExecutionId: ctx.sessionId,
                  nodeId: ctx.stepId,
                  nodeExecId: ctx.nodeExecId,
                  ...(ctx.agentNodePayload.executionBackend === undefined
                    ? {}
                    : { agentBackend: ctx.agentNodePayload.executionBackend }),
                }),
                ...(backendSession === undefined ? {} : { backendSession }),
                ...(ctx.ambientManagerContext === undefined
                  ? {}
                  : { ambientManagerContext: ctx.ambientManagerContext }),
                ...(candidatePath === undefined ||
                ctx.agentNodePayload.output === undefined
                  ? {}
                  : {
                      output: {
                        ...(ctx.agentNodePayload.output.description ===
                        undefined
                          ? {}
                          : {
                              description:
                                ctx.agentNodePayload.output.description,
                            }),
                        ...(ctx.agentNodePayload.output.jsonSchema === undefined
                          ? {}
                          : {
                              jsonSchema:
                                ctx.agentNodePayload.output.jsonSchema,
                            }),
                        maxValidationAttempts: maxAttempts,
                        attempt,
                        candidatePath,
                        validationErrors: formatOutputValidationErrors(
                          outputValidationErrors,
                        ),
                        publication: buildOutputPublicationPolicy(),
                      },
                    }),
              },
              ctx.timeoutMs,
              supervisionStall,
            )
          : await executeNativeNodeWithTimeout({
              workflowDirectory: ctx.workflowDirectory,
              workflowWorkingDirectory: ctx.workflowWorkingDirectory,
              artifactWorkflowRoot: ctx.artifactWorkflowRoot,
              workflowId: ctx.workflowId,
              workflowDescription: ctx.workflowDescription,
              workflowExecutionId: ctx.sessionId,
              nodeId: ctx.stepId,
              nodeExecId: ctx.nodeExecId,
              node: ctx.executionNodePayload,
              workflowDefaults: ctx.workflowDefaults,
              runtimeVariables: ctx.runtimeVariables,
              mergedVariables: ctx.mergedVariables,
              arguments: ctx.assembledArguments,
              artifactDir: ctx.artifactDir,
              executionMailbox: ctx.executionMailbox,
              ...(ctx.eventReplyDispatcher === undefined
                ? {}
                : { chatReplyDispatcher: ctx.eventReplyDispatcher }),
              ...(ctx.env === undefined ? {} : { env: ctx.env }),
              ...(ctx.superviserControl === undefined
                ? {}
                : { superviserControl: ctx.superviserControl }),
              timeoutMs: ctx.timeoutMs,
              ...(supervisionStall === undefined ? {} : { supervisionStall }),
            });

      try {
        if (!execution.ok) {
          processLogs = [
            ...processLogs,
            ...(execution.error.processLogs ?? []),
          ];
          if (
            execution.error.code === "invalid_output" &&
            ctx.executionNodePayload.output !== undefined &&
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
            if (attempt < maxAttempts) {
              continue;
            }
            nodeStatus = "failed";
            finalOutputPayload = {
              provider: "deterministic-local",
              model:
                ctx.agentNodePayload?.model ??
                ctx.executionNodePayload.nodeType ??
                "node",
              promptText: ctx.promptText,
              completionPassed: false,
              when: {},
              payload: {},
              error: "output_validation_failed",
              validationErrors: outputValidationErrors,
            };
            break;
          }
          nodeStatus =
            execution.error.code === "timeout" ? "timed_out" : "failed";
          finalOutputPayload = {
            provider: "deterministic-local",
            model:
              ctx.agentNodePayload?.model ??
              ctx.executionNodePayload.nodeType ??
              "node",
            promptText: ctx.promptText,
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
          ctx.executionNodePayload.output === undefined &&
          execution.value.candidateFilePath !== undefined
        ) {
          outputValidationErrors = [
            { path: "$", message: NON_CONTRACT_CANDIDATE_FILE_ERROR },
          ];
          nodeStatus = "failed";
          finalOutputPayload = {
            provider: execution.value.provider,
            model: execution.value.model,
            promptText: ctx.promptText,
            completionPassed: false,
            when: {},
            payload: {},
            error: "invalid_output",
            validationErrors: outputValidationErrors,
          };
          break;
        }

        const validation = await ctx.validator.validate({
          node: ctx.executionNodePayload,
          execution: execution.value,
          ...(candidatePath === undefined
            ? {}
            : { expectedCandidatePath: candidatePath }),
        });
        if (!validation.ok && validation.error.payload !== undefined) {
          if (candidateArtifactPath !== undefined) {
            await writeJsonFile(
              candidateArtifactPath,
              validation.error.payload,
            );
          }
        }
        if (!validation.ok) {
          outputValidationErrors = validation.error.errors;
          if (validationPath !== undefined) {
            await writeJsonFile(validationPath, {
              valid: false,
              errors: outputValidationErrors,
              rejectedAt: nowIso(),
            });
          }
          if (attempt < maxAttempts && validation.error.retryable) {
            continue;
          }
          nodeStatus = "failed";
          finalOutputPayload = {
            provider: execution.value.provider,
            model: execution.value.model,
            promptText: ctx.promptText,
            completionPassed: false,
            when: {},
            payload: {},
            error: validation.error.retryable
              ? "output_validation_failed"
              : "invalid_output",
            validationErrors: validation.error.errors,
          };
          break;
        }
        if (candidateArtifactPath !== undefined) {
          await writeJsonFile(candidateArtifactPath, validation.value.payload);
        }
        if (validationPath !== undefined) {
          await writeJsonFile(validationPath, {
            valid: true,
            errors: [],
            validatedAt: nowIso(),
          });
        }

        finalOutputPayload = {
          provider: execution.value.provider,
          model: execution.value.model,
          promptText: ctx.promptText,
          completionPassed: execution.value.completionPassed,
          when: execution.value.when,
          payload: validation.value.payload,
        };
        outputValidationErrors = validation.value.errors;
        break;
      } finally {
        if (candidatePath !== undefined) {
          await cleanupReservedCandidateSubmissionPath(candidatePath);
        }
      }
    }
  }

  return {
    nodeStatus,
    outputValidationErrors,
    outputAttemptCount,
    finalOutputPayload,
    processLogs,
    backendSession,
    backendSessionId,
    backendSessionProvider,
  };
}
