import { runWorkflow, type WorkflowRunOptions } from "../workflow/engine";
import { callStep } from "../workflow/call-step";
import {
  buildInspectionSummary,
  type WorkflowInspectionSummary,
} from "../workflow/inspect";
import { loadWorkflowFromCatalog } from "../workflow/load";
import { withResolvedWorkflowSourceOptions } from "../workflow/catalog";
import { loadSession } from "../workflow/session-store";
import type { WorkflowSessionState } from "../workflow/session";
import { normalizeWorkflowWorkingDirectoryOverride } from "../workflow/working-directory";
import type {
  DivedraOptions,
  ExecuteWorkflowInput,
  ResumeWorkflowInput,
  RerunWorkflowInput,
  ContinueWorkflowFromHistoryInput,
  CallWorkflowStepInput,
} from "./types";

export async function resolveWorkflowCatalogOptions<T extends DivedraOptions>(
  workflowName: string,
  options: T,
): Promise<T> {
  const loaded = await loadWorkflowFromCatalog(workflowName, options);
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  return loaded.value.source === undefined
    ? options
    : withResolvedWorkflowSourceOptions(loaded.value.source, options);
}

export async function inspectWorkflow(
  workflowName: string,
  options: DivedraOptions = {},
): Promise<WorkflowInspectionSummary> {
  const loaded = await loadWorkflowFromCatalog(workflowName, options);
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  const inspectionOptions =
    loaded.value.source === undefined
      ? options
      : withResolvedWorkflowSourceOptions(loaded.value.source, options);
  return await buildInspectionSummary(loaded.value, inspectionOptions);
}

export async function executeWorkflow(input: ExecuteWorkflowInput): Promise<{
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
  readonly exitCode: number;
}> {
  const workflowWorkingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    input.workflowWorkingDirectory,
  );
  const options: WorkflowRunOptions = {
    ...(input.workflowRoot === undefined
      ? {}
      : { workflowRoot: input.workflowRoot }),
    ...(input.workflowScope === undefined
      ? {}
      : { workflowScope: input.workflowScope }),
    ...(input.userRoot === undefined ? {} : { userRoot: input.userRoot }),
    ...(input.projectRoot === undefined
      ? {}
      : { projectRoot: input.projectRoot }),
    ...(input.artifactRoot === undefined
      ? {}
      : { artifactRoot: input.artifactRoot }),
    ...(input.rootDataDir === undefined
      ? {}
      : { rootDataDir: input.rootDataDir }),
    ...(input.sessionStoreRoot === undefined
      ? {}
      : { sessionStoreRoot: input.sessionStoreRoot }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.nodeAddons === undefined ? {} : { nodeAddons: input.nodeAddons }),
    ...(input.asyncNodeAddonResolvers === undefined
      ? {}
      : { asyncNodeAddonResolvers: input.asyncNodeAddonResolvers }),
    ...(input.nodeAddonResolvers === undefined
      ? {}
      : { nodeAddonResolvers: input.nodeAddonResolvers }),
    ...(workflowWorkingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory }),
    ...(input.runtimeVariables === undefined
      ? {}
      : { runtimeVariables: input.runtimeVariables }),
    ...(input.mockScenario === undefined
      ? {}
      : { mockScenario: input.mockScenario }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.eventReplyDispatcher === undefined
      ? {}
      : { eventReplyDispatcher: input.eventReplyDispatcher }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: input.maxLoopIterations }),
    ...(input.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: input.defaultTimeoutMs }),
    ...(input.autoImprove === undefined
      ? {}
      : { autoImprove: input.autoImprove }),
    ...(input.nestedSuperviserDriver === true
      ? { nestedSuperviserDriver: true as const }
      : {}),
  };
  const executionOptions = await resolveWorkflowCatalogOptions(
    input.workflowName,
    options,
  );
  const result = await runWorkflow(input.workflowName, executionOptions);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    exitCode: result.value.exitCode,
  };
}

export async function resumeWorkflow(input: ResumeWorkflowInput): Promise<{
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
  readonly exitCode: number;
}> {
  const workflowWorkingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    input.workflowWorkingDirectory,
  );
  const existing = await loadSession(input.sessionId, input);
  if (!existing.ok) {
    throw new Error(existing.error.message);
  }
  const result = await runWorkflow(existing.value.workflowName, {
    ...(input.workflowRoot === undefined
      ? {}
      : { workflowRoot: input.workflowRoot }),
    ...(input.artifactRoot === undefined
      ? {}
      : { artifactRoot: input.artifactRoot }),
    ...(input.rootDataDir === undefined
      ? {}
      : { rootDataDir: input.rootDataDir }),
    ...(input.sessionStoreRoot === undefined
      ? {}
      : { sessionStoreRoot: input.sessionStoreRoot }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.nodeAddons === undefined ? {} : { nodeAddons: input.nodeAddons }),
    ...(input.asyncNodeAddonResolvers === undefined
      ? {}
      : { asyncNodeAddonResolvers: input.asyncNodeAddonResolvers }),
    ...(input.nodeAddonResolvers === undefined
      ? {}
      : { nodeAddonResolvers: input.nodeAddonResolvers }),
    ...(workflowWorkingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory }),
    ...(input.mockScenario === undefined
      ? {}
      : { mockScenario: input.mockScenario }),
    ...(input.autoImprove === undefined
      ? {}
      : { autoImprove: input.autoImprove }),
    ...(input.nestedSuperviserDriver === true
      ? { nestedSuperviserDriver: true as const }
      : {}),
    resumeSessionId: existing.value.sessionId,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    exitCode: result.value.exitCode,
  };
}

export async function rerunWorkflow(input: RerunWorkflowInput): Promise<{
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
  readonly rerunFromStepId: string;
  readonly exitCode: number;
}> {
  const workflowWorkingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    input.workflowWorkingDirectory,
  );
  const source = await loadSession(input.sourceSessionId, input);
  if (!source.ok) {
    throw new Error(source.error.message);
  }
  const result = await runWorkflow(source.value.workflowName, {
    ...(input.workflowRoot === undefined
      ? {}
      : { workflowRoot: input.workflowRoot }),
    ...(input.artifactRoot === undefined
      ? {}
      : { artifactRoot: input.artifactRoot }),
    ...(input.rootDataDir === undefined
      ? {}
      : { rootDataDir: input.rootDataDir }),
    ...(input.sessionStoreRoot === undefined
      ? {}
      : { sessionStoreRoot: input.sessionStoreRoot }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.nodeAddons === undefined ? {} : { nodeAddons: input.nodeAddons }),
    ...(input.asyncNodeAddonResolvers === undefined
      ? {}
      : { asyncNodeAddonResolvers: input.asyncNodeAddonResolvers }),
    ...(input.nodeAddonResolvers === undefined
      ? {}
      : { nodeAddonResolvers: input.nodeAddonResolvers }),
    ...(workflowWorkingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory }),
    ...(input.runtimeVariables === undefined
      ? {}
      : { runtimeVariables: input.runtimeVariables }),
    ...(input.mockScenario === undefined
      ? {}
      : { mockScenario: input.mockScenario }),
    rerunFromSessionId: source.value.sessionId,
    rerunFromStepId: input.fromStepId,
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: input.maxLoopIterations }),
    ...(input.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: input.defaultTimeoutMs }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.autoImprove === undefined
      ? {}
      : { autoImprove: input.autoImprove }),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    rerunFromStepId: input.fromStepId,
    exitCode: result.value.exitCode,
  };
}

export async function continueWorkflowFromHistory(
  input: ContinueWorkflowFromHistoryInput,
): Promise<{
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
  readonly exitCode: number;
  readonly continuedAfterStepRunId: string;
  readonly continuedStartStepId: string;
}> {
  const workflowWorkingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    input.workflowWorkingDirectory,
  );
  const source = await loadSession(input.sourceWorkflowExecutionId, input);
  if (!source.ok) {
    throw new Error(source.error.message);
  }
  const result = await runWorkflow(source.value.workflowName, {
    ...(input.workflowRoot === undefined
      ? {}
      : { workflowRoot: input.workflowRoot }),
    ...(input.artifactRoot === undefined
      ? {}
      : { artifactRoot: input.artifactRoot }),
    ...(input.rootDataDir === undefined
      ? {}
      : { rootDataDir: input.rootDataDir }),
    ...(input.sessionStoreRoot === undefined
      ? {}
      : { sessionStoreRoot: input.sessionStoreRoot }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.nodeAddons === undefined ? {} : { nodeAddons: input.nodeAddons }),
    ...(input.asyncNodeAddonResolvers === undefined
      ? {}
      : { asyncNodeAddonResolvers: input.asyncNodeAddonResolvers }),
    ...(input.nodeAddonResolvers === undefined
      ? {}
      : { nodeAddonResolvers: input.nodeAddonResolvers }),
    ...(workflowWorkingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory }),
    ...(input.runtimeVariables === undefined
      ? {}
      : { runtimeVariables: input.runtimeVariables }),
    ...(input.mockScenario === undefined
      ? {}
      : { mockScenario: input.mockScenario }),
    continueFromWorkflowExecutionId: source.value.sessionId,
    continueAfterStepRunId: input.afterStepRunId,
    continueStartStepId: input.startStepId,
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: input.maxLoopIterations }),
    ...(input.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: input.defaultTimeoutMs }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.autoImprove === undefined
      ? {}
      : { autoImprove: input.autoImprove }),
    ...(input.nestedSuperviserDriver === true
      ? { nestedSuperviserDriver: true as const }
      : {}),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    exitCode: result.value.exitCode,
    continuedAfterStepRunId: input.afterStepRunId.trim(),
    continuedStartStepId: input.startStepId.trim(),
  };
}

export async function callWorkflowStep(input: CallWorkflowStepInput): Promise<{
  readonly sessionId: string;
  readonly stepId: string;
  readonly nodeExecId: string;
  readonly status: "succeeded";
  readonly exitCode: number;
  readonly output: Readonly<Record<string, unknown>>;
}> {
  const result = await callStep(input);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    sessionId: result.value.session.sessionId,
    stepId: result.value.stepId,
    nodeExecId: result.value.nodeExecution.nodeExecId,
    status: "succeeded",
    exitCode: result.value.exitCode,
    output: result.value.output,
  };
}
