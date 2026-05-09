import { runWorkflow } from "../workflow/engine";
import { loadWorkflowFromCatalog } from "../workflow/load";
import { createSessionId } from "../workflow/session";
import { loadSession } from "../workflow/session-store";
import {
  continueWorkflowFromHistory,
  listMergedWorkflowExecutionStepRuns,
} from "../lib";
import {
  buildGraphqlWorkflowRunOverrides,
  parseWorkflowExecutionStepRunsStatusFilter,
} from "./schema-helpers";
import { resolveWorkflowContextForGraphql } from "./schema-workflow-definitions";
import type {
  ContinueWorkflowExecutionInput,
  ContinueWorkflowExecutionPayload,
  ExecuteWorkflowInput,
  ExecuteWorkflowPayload,
  GraphqlRequestContext,
  RerunWorkflowExecutionInput,
  RerunWorkflowExecutionPayload,
  ResumeWorkflowExecutionInput,
  ResumeWorkflowExecutionPayload,
  WorkflowExecutionStepRunsPayload,
  WorkflowExecutionStepRunsQueryInput,
} from "./types";

export async function executeWorkflowMutation(
  input: ExecuteWorkflowInput,
  context: GraphqlRequestContext,
): Promise<ExecuteWorkflowPayload> {
  const workflowRunOverrides = buildGraphqlWorkflowRunOverrides(input);
  if (!workflowRunOverrides.ok) {
    throw new Error(workflowRunOverrides.error);
  }
  const workflowContext = await resolveWorkflowContextForGraphql(
    input.workflowName,
    context,
  );
  if (input.async === true) {
    const loadedWorkflow = await loadWorkflowFromCatalog(
      input.workflowName,
      workflowContext,
    );
    if (!loadedWorkflow.ok) {
      throw new Error(loadedWorkflow.error.message);
    }
    const workflowExecutionId = createSessionId({
      workflowId: loadedWorkflow.value.bundle.workflow.workflowId,
    });
    void runWorkflow(input.workflowName, {
      ...workflowContext,
      sessionId: workflowExecutionId,
      ...workflowRunOverrides.value,
      ...(input.runtimeVariables === undefined
        ? {}
        : { runtimeVariables: input.runtimeVariables }),
      ...(input.mockScenario === undefined
        ? {}
        : { mockScenario: input.mockScenario }),
    }).catch(() => undefined);
    return {
      workflowExecutionId,
      sessionId: workflowExecutionId,
      status: "running",
      accepted: true,
    };
  }

  const result = await runWorkflow(input.workflowName, {
    ...workflowContext,
    ...workflowRunOverrides.value,
    ...(input.runtimeVariables === undefined
      ? {}
      : { runtimeVariables: input.runtimeVariables }),
    ...(input.mockScenario === undefined
      ? {}
      : { mockScenario: input.mockScenario }),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    workflowExecutionId: result.value.session.sessionId,
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    exitCode: result.value.exitCode,
  };
}

export async function resumeWorkflowExecutionMutation(
  input: ResumeWorkflowExecutionInput,
  context: GraphqlRequestContext,
): Promise<ResumeWorkflowExecutionPayload> {
  const workflowRunOverrides = buildGraphqlWorkflowRunOverrides(input);
  if (!workflowRunOverrides.ok) {
    throw new Error(workflowRunOverrides.error);
  }
  const existing = await loadSession(input.workflowExecutionId, context);
  if (!existing.ok) {
    throw new Error(existing.error.message);
  }
  const workflowContext = await resolveWorkflowContextForGraphql(
    existing.value.workflowName,
    context,
  );
  const result = await runWorkflow(existing.value.workflowName, {
    ...workflowContext,
    resumeSessionId: input.workflowExecutionId,
    ...workflowRunOverrides.value,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    workflowExecutionId: result.value.session.sessionId,
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    exitCode: result.value.exitCode,
  };
}

export async function rerunWorkflowExecutionMutation(
  input: RerunWorkflowExecutionInput,
  context: GraphqlRequestContext,
): Promise<RerunWorkflowExecutionPayload> {
  const rerunFromStepId = input.stepId.trim();
  if (rerunFromStepId.length === 0) {
    throw new Error("stepId is required");
  }
  const workflowRunOverrides = buildGraphqlWorkflowRunOverrides(input);
  if (!workflowRunOverrides.ok) {
    throw new Error(workflowRunOverrides.error);
  }
  const existing = await loadSession(input.workflowExecutionId, context);
  if (!existing.ok) {
    throw new Error(existing.error.message);
  }
  const workflowContext = await resolveWorkflowContextForGraphql(
    existing.value.workflowName,
    context,
  );
  const result = await runWorkflow(existing.value.workflowName, {
    ...workflowContext,
    rerunFromSessionId: input.workflowExecutionId,
    rerunFromStepId,
    ...workflowRunOverrides.value,
    ...(input.runtimeVariables === undefined
      ? {}
      : { runtimeVariables: input.runtimeVariables }),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    workflowExecutionId: result.value.session.sessionId,
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    rerunFromStepId,
    exitCode: result.value.exitCode,
  };
}

export async function workflowExecutionStepRunsQuery(
  input: WorkflowExecutionStepRunsQueryInput,
  context: GraphqlRequestContext,
): Promise<WorkflowExecutionStepRunsPayload> {
  const workflowExecutionId = input.workflowExecutionId.trim();
  if (workflowExecutionId.length === 0) {
    throw new Error("workflowExecutionId is required");
  }
  const stepTrimmed = input.stepId?.trim();
  const filterStepId =
    stepTrimmed === undefined || stepTrimmed.length === 0
      ? undefined
      : stepTrimmed;
  const filterStatus = parseWorkflowExecutionStepRunsStatusFilter(input.status);
  const listed = await listMergedWorkflowExecutionStepRuns({
    workflowExecutionId,
    ...(filterStepId === undefined ? {} : { filterStepId }),
    ...(filterStatus === undefined ? {} : { filterStatus }),
    ...context,
  });
  return {
    workflowExecutionId: listed.workflowExecutionId,
    workflowId: listed.workflowId,
    workflowName: listed.workflowName,
    stepRuns: listed.stepRuns.map((row) => ({
      workflowExecutionId: listed.workflowExecutionId,
      timelineOrdinal: row.timelineOrdinal,
      executionOrdinal: row.executionOrdinal,
      stepRunId: row.stepRunId,
      ...(row.stepId === undefined ? {} : { stepId: row.stepId }),
      ...(row.nodeRegistryId === undefined
        ? {}
        : { nodeRegistryId: row.nodeRegistryId }),
      status: row.status,
      imported: row.imported,
      sourceWorkflowExecutionId: row.persistedWorkflowExecutionId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    })),
  };
}

export async function continueWorkflowExecutionMutation(
  input: ContinueWorkflowExecutionInput,
  context: GraphqlRequestContext,
): Promise<ContinueWorkflowExecutionPayload> {
  if (context.readOnly === true) {
    throw new Error("read-only mode enabled");
  }
  const sourceWorkflowExecutionId = input.sourceWorkflowExecutionId.trim();
  const startStepId = input.startStepId.trim();
  const afterStepRunId = input.afterStepRunId.trim();
  if (sourceWorkflowExecutionId.length === 0) {
    throw new Error("sourceWorkflowExecutionId is required");
  }
  if (startStepId.length === 0) {
    throw new Error("startStepId is required");
  }
  if (afterStepRunId.length === 0) {
    throw new Error("afterStepRunId is required");
  }
  const workflowRunOverrides = buildGraphqlWorkflowRunOverrides(input);
  if (!workflowRunOverrides.ok) {
    throw new Error(workflowRunOverrides.error);
  }
  const existing = await loadSession(sourceWorkflowExecutionId, context);
  if (!existing.ok) {
    throw new Error(existing.error.message);
  }
  const workflowContext = await resolveWorkflowContextForGraphql(
    existing.value.workflowName,
    context,
  );
  const result = await continueWorkflowFromHistory({
    ...workflowContext,
    ...workflowRunOverrides.value,
    sourceWorkflowExecutionId,
    startStepId,
    afterStepRunId,
    ...(input.runtimeVariables === undefined
      ? {}
      : { runtimeVariables: input.runtimeVariables }),
    ...(input.mockScenario === undefined
      ? {}
      : { mockScenario: input.mockScenario }),
  });
  return {
    workflowExecutionId: result.sessionId,
    sessionId: result.sessionId,
    status: result.status,
    exitCode: result.exitCode,
    continuedAfterStepRunId: result.continuedAfterStepRunId,
    continuedStartStepId: result.continuedStartStepId,
  };
}
