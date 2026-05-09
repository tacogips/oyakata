import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJsonFile as writeJsonFile } from "../shared/fs";
import {
  effectiveCrossWorkflowDispatches,
  crossWorkflowDispatchesForExecutionMatch,
  type CrossWorkflowDispatch,
} from "./cross-workflow-from-steps";
import { loadWorkflowByIdFromDisk } from "./load";
import type { WorkflowJson } from "./types";
import type { WorkflowSessionState, CommunicationRecord } from "./session";
import type { OutputRef, NodeExecutionRecord } from "./session";
import type { NodeAdapter } from "./adapter";
import { resolveWorkflowManagerStepId } from "./types";
import { evaluateBranch } from "./semantics";
import {
  err,
  ok,
  type Result,
  type WorkflowRunOptions,
  type CrossWorkflowDispatchExecutionResult,
  type RunWorkflowInternalFn,
} from "./engine-types";
import { buildOutputRefForExecution } from "./session";
import { persistCommunicationArtifact } from "./engine-communications";
import { readOutputPayloadArtifact } from "./engine-output-candidate";
import { findLatestPublishedWorkflowResult } from "./engine-node-helpers";

export const CROSS_WORKFLOW_DISPATCH_TRANSITION_WHEN_PREFIX = "workflow-call:";

export function findLatestCrossWorkflowCalleeResultExecution(
  workflow: WorkflowJson,
  session: WorkflowSessionState,
): NodeExecutionRecord | undefined {
  const published = findLatestPublishedWorkflowResult(workflow, session);
  if (published !== undefined) {
    return published;
  }

  if (workflow.hasManagerNode !== false) {
    return undefined;
  }

  return [...session.nodeExecutions]
    .reverse()
    .find((entry) => entry.status === "succeeded");
}

export function buildCrossWorkflowCalleeRuntimeVariables(input: {
  readonly callerRuntimeVariables: Readonly<Record<string, unknown>>;
  readonly callerWorkflowId: string;
  readonly callerWorkflowExecutionId: string;
  readonly callerNodeRegistryId: string;
  readonly callerStepId: string;
  readonly crossWorkflowDispatchId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  const filteredCallerRuntimeVariables = Object.fromEntries(
    Object.entries(input.callerRuntimeVariables).filter(
      ([key]) =>
        key !== "humanInput" &&
        key !== "workflowOutput" &&
        key !== "workflowCall",
    ),
  );

  return {
    ...filteredCallerRuntimeVariables,
    workflowCall: {
      id: input.crossWorkflowDispatchId,
      parentWorkflowId: input.callerWorkflowId,
      parentWorkflowExecutionId: input.callerWorkflowExecutionId,
      callerNodeId: input.callerNodeRegistryId,
      callerStepId: input.callerStepId,
      input: input.payload,
    },
  };
}

export function buildCrossWorkflowCalleeRunOptions(
  options: WorkflowRunOptions,
  runtimeVariables: Readonly<Record<string, unknown>>,
): WorkflowRunOptions {
  return {
    ...(options.workflowRoot === undefined
      ? {}
      : { workflowRoot: options.workflowRoot }),
    ...(options.workflowScope === undefined
      ? {}
      : { workflowScope: options.workflowScope }),
    ...(options.userRoot === undefined ? {} : { userRoot: options.userRoot }),
    ...(options.projectRoot === undefined
      ? {}
      : { projectRoot: options.projectRoot }),
    ...(options.addonRoot === undefined
      ? {}
      : { addonRoot: options.addonRoot }),
    ...(options.resolvedWorkflowSource === undefined
      ? {}
      : { resolvedWorkflowSource: options.resolvedWorkflowSource }),
    ...(options.artifactRoot === undefined
      ? {}
      : { artifactRoot: options.artifactRoot }),
    ...(options.rootDataDir === undefined
      ? {}
      : { rootDataDir: options.rootDataDir }),
    ...(options.sessionStoreRoot === undefined
      ? {}
      : { sessionStoreRoot: options.sessionStoreRoot }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.nodeAddons === undefined
      ? {}
      : { nodeAddons: options.nodeAddons }),
    ...(options.asyncNodeAddonResolvers === undefined
      ? {}
      : { asyncNodeAddonResolvers: options.asyncNodeAddonResolvers }),
    ...(options.nodeAddonResolvers === undefined
      ? {}
      : { nodeAddonResolvers: options.nodeAddonResolvers }),
    ...(options.workflowWorkingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory: options.workflowWorkingDirectory }),
    runtimeVariables,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: options.maxLoopIterations }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.mockScenario === undefined
      ? {}
      : { mockScenario: options.mockScenario }),
    ...(options.restartOnStuck === undefined
      ? {}
      : { restartOnStuck: options.restartOnStuck }),
    ...(options.maxStuckRestarts === undefined
      ? {}
      : { maxStuckRestarts: options.maxStuckRestarts }),
    ...(options.stuckRestartBackoffMs === undefined
      ? {}
      : { stuckRestartBackoffMs: options.stuckRestartBackoffMs }),
  };
}

export async function persistCrossWorkflowDispatchArtifact(input: {
  readonly artifactDir: string;
  readonly callId: string;
  readonly callerStepId: string;
  readonly calleeWorkflowName: string;
  readonly calleeWorkflowId: string;
  readonly calleeSession: WorkflowSessionState;
  readonly callerNodeExecId: string;
  readonly resumeStepId: string;
  readonly resultOutputRef?: OutputRef;
}): Promise<void> {
  await mkdir(path.join(input.artifactDir, "workflow-calls"), {
    recursive: true,
  });
  const callerExecId = input.callerNodeExecId;
  const calleeName = input.calleeWorkflowName;
  const calleeId = input.calleeWorkflowId;
  const calleeSessionId = input.calleeSession.sessionId;
  const calleeSessionStatus = input.calleeSession.status;
  await writeJsonFile(
    path.join(input.artifactDir, "workflow-calls", `${input.callId}.json`),
    {
      crossWorkflowDispatchId: input.callId,
      callerStepId: input.callerStepId,
      callerNodeExecId: callerExecId,
      calleeWorkflowName: calleeName,
      calleeWorkflowId: calleeId,
      calleeSessionId,
      calleeSessionStatus,
      resumeStepId: input.resumeStepId,
      ...(input.resultOutputRef === undefined
        ? {}
        : { resultOutputRef: input.resultOutputRef }),
    },
  );
}

export function crossWorkflowDispatchMatchesCallerExecution(input: {
  readonly entry: CrossWorkflowDispatch;
  readonly callerStepId: string;
  readonly callerOutputPayload: Readonly<Record<string, unknown>>;
}): boolean {
  const { entry } = input;
  if (entry.callerStepId !== input.callerStepId) {
    return false;
  }
  if (entry.when !== undefined) {
    if (
      !evaluateBranch({
        when: entry.when,
        output: input.callerOutputPayload,
      })
    ) {
      return false;
    }
  }
  return true;
}

export async function executeCrossWorkflowDispatchesForNode(input: {
  readonly workflow: WorkflowJson;
  readonly workflowName: string;
  readonly session: WorkflowSessionState;
  readonly options: WorkflowRunOptions;
  readonly artifactWorkflowRoot: string;
  readonly callerNodeId: string;
  readonly callerStepId: string;
  readonly callerNodeRegistryId: string;
  readonly callerNodeExecId: string;
  readonly callerArtifactDir: string;
  readonly callerOutputPayload: Readonly<Record<string, unknown>>;
  readonly callerOutputRaw: string;
  readonly createdAt: string;
  readonly communicationCounter: number;
  readonly currentCommunications: readonly CommunicationRecord[];
  readonly adapter: NodeAdapter;
  readonly guards: import("./engine-types").EngineExecutionGuards | undefined;
  readonly crossWorkflowInvocationStack: readonly string[];
  readonly runWorkflowInternalFn: RunWorkflowInternalFn;
}): Promise<Result<CrossWorkflowDispatchExecutionResult, string>> {
  const workflowDispatches = effectiveCrossWorkflowDispatches(input.workflow);
  if (workflowDispatches.length === 0) {
    return ok({
      communications: input.currentCommunications,
      communicationCounter: input.communicationCounter,
      queuedNodeIds: [],
      transitions: [],
    });
  }
  const relevantDispatches = crossWorkflowDispatchesForExecutionMatch(
    input.workflow,
    (entry) =>
      crossWorkflowDispatchMatchesCallerExecution({
        entry,
        callerStepId: input.callerStepId,
        callerOutputPayload: input.callerOutputPayload,
      }),
  );
  if (relevantDispatches.length === 0) {
    return ok({
      communications: input.currentCommunications,
      communicationCounter: input.communicationCounter,
      queuedNodeIds: [],
      transitions: [],
    });
  }

  const currentCommunications = [...input.currentCommunications];
  let currentCommunicationCounter = input.communicationCounter;
  const queuedNodeIds: string[] = [];
  const transitions: Array<{
    readonly from: string;
    readonly to: string;
    readonly when: string;
  }> = [];

  for (const dispatch of relevantDispatches) {
    if (
      input.crossWorkflowInvocationStack.includes(dispatch.workflowId) ||
      input.workflow.workflowId === dispatch.workflowId
    ) {
      return err(
        `cross-workflow dispatch '${dispatch.id}' would recurse into '${dispatch.workflowId}', which is not supported`,
      );
    }

    const loadedCallee = await loadWorkflowByIdFromDisk(
      dispatch.workflowId,
      input.options,
    );
    if (!loadedCallee.ok) {
      return err(
        `cross-workflow dispatch '${dispatch.id}' target '${dispatch.workflowId}' could not be loaded: ${loadedCallee.error.message}`,
      );
    }

    const calleeRun = await input.runWorkflowInternalFn(
      loadedCallee.value.workflowName,
      buildCrossWorkflowCalleeRunOptions(
        input.options,
        buildCrossWorkflowCalleeRuntimeVariables({
          callerRuntimeVariables: input.session.runtimeVariables,
          callerWorkflowId: input.workflow.workflowId,
          callerWorkflowExecutionId: input.session.sessionId,
          callerNodeRegistryId: input.callerNodeRegistryId,
          callerStepId: input.callerStepId,
          crossWorkflowDispatchId: dispatch.id,
          payload: input.callerOutputPayload["payload"] as Readonly<
            Record<string, unknown>
          >,
        }),
      ),
      input.adapter,
      input.guards,
      [...input.crossWorkflowInvocationStack, input.workflow.workflowId],
    );
    if (!calleeRun.ok) {
      return err(
        `cross-workflow dispatch '${dispatch.id}' failed: ${calleeRun.error.message}`,
      );
    }

    const calleeWorkflow = loadedCallee.value.bundle.workflow;
    const calleeResultExecution = findLatestCrossWorkflowCalleeResultExecution(
      calleeWorkflow,
      calleeRun.value.session,
    );
    const calleeOutputRef =
      calleeResultExecution === undefined
        ? undefined
        : buildOutputRefForExecution({
            workflow: calleeWorkflow,
            session: calleeRun.value.session,
            execution: calleeResultExecution,
          });

    await persistCrossWorkflowDispatchArtifact({
      artifactDir: input.callerArtifactDir,
      callId: dispatch.id,
      callerStepId: dispatch.callerStepId,
      calleeWorkflowName: loadedCallee.value.workflowName,
      calleeWorkflowId: calleeWorkflow.workflowId,
      calleeSession: calleeRun.value.session,
      callerNodeExecId: input.callerNodeExecId,
      resumeStepId: dispatch.resumeStepId,
      ...(calleeOutputRef === undefined
        ? {}
        : { resultOutputRef: calleeOutputRef }),
    });

    if (calleeResultExecution === undefined || calleeOutputRef === undefined) {
      return err(
        `cross-workflow dispatch '${dispatch.id}' completed without a result execution for '${dispatch.resumeStepId}'`,
      );
    }

    const calleeOutput = await readOutputPayloadArtifact(
      calleeResultExecution.artifactDir,
    );
    if (!calleeOutput.ok) {
      return err(
        `cross-workflow dispatch '${dispatch.id}' produced an unreadable result: ${calleeOutput.error}`,
      );
    }

    const communication = await persistCommunicationArtifact({
      artifactWorkflowRoot: input.artifactWorkflowRoot,
      runtimeLogOptions: input.options,
      workflowId: input.workflow.workflowId,
      workflowExecutionId: input.session.sessionId,
      communicationCounter: currentCommunicationCounter,
      fromNodeId: input.callerNodeId,
      toNodeId: dispatch.resumeStepId,
      routingScope: "intra-workflow",
      deliveryKind: "edge-transition",
      transitionWhen: `${CROSS_WORKFLOW_DISPATCH_TRANSITION_WHEN_PREFIX}${dispatch.id}`,
      sourceNodeExecId: input.callerNodeExecId,
      payloadRef: calleeOutputRef,
      outputRaw: calleeOutput.value.raw,
      deliveredByNodeId: resolveWorkflowManagerStepId(input.workflow),
      createdAt: input.createdAt,
    });
    currentCommunicationCounter += 1;
    currentCommunications.push(communication);
    queuedNodeIds.push(dispatch.resumeStepId);
    transitions.push({
      from: dispatch.callerStepId,
      to: dispatch.resumeStepId,
      when: `${CROSS_WORKFLOW_DISPATCH_TRANSITION_WHEN_PREFIX}${dispatch.id}`,
    });
  }

  return ok({
    communications: currentCommunications,
    communicationCounter: currentCommunicationCounter,
    queuedNodeIds,
    transitions,
  });
}
