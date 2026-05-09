import { normalizeAutoImprovePolicy } from "./auto-improve-policy";
import type { NodeAdapter } from "./adapter";
import {
  err,
  workflowRunFailure,
  type CancellationProbe,
  type EngineExecutionGuards,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./engine-types";
import type { Result } from "./result";
import { runWorkflowInternal } from "./engine-run";
import { runAutoImproveLoop } from "./engine-run-auto-improve";

export type {
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowRunFailure,
  CancellationProbe,
  EngineExecutionGuards,
};

export async function runWorkflow(
  workflowName: string,
  options: WorkflowRunOptions = {},
  adapter?: NodeAdapter,
  guards?: EngineExecutionGuards,
): Promise<Result<WorkflowRunResult, WorkflowRunFailure>> {
  let normalizedOptions = options;
  if (options.autoImprove !== undefined) {
    const normalizedPolicy = normalizeAutoImprovePolicy(options.autoImprove);
    if (!normalizedPolicy.ok || normalizedPolicy.value === undefined) {
      return err(
        workflowRunFailure(
          2,
          normalizedPolicy.ok
            ? "autoImprove.enabled must be true when autoImprove is set"
            : `invalid autoImprove policy: ${normalizedPolicy.error}`,
        ),
      );
    }
    normalizedOptions = {
      ...options,
      autoImprove: normalizedPolicy.value,
    };
  }

  if (normalizedOptions.autoImprove === undefined) {
    return runWorkflowInternal(
      workflowName,
      normalizedOptions,
      adapter,
      guards,
      [],
    );
  }
  if (normalizedOptions.supervisionLoopExecution === true) {
    return runWorkflowInternal(
      workflowName,
      normalizedOptions,
      adapter,
      guards,
      [],
    );
  }
  if (normalizedOptions.nestedSuperviserDriver === true) {
    if (normalizedOptions.rerunFromSessionId !== undefined) {
      return err(
        workflowRunFailure(
          2,
          "nestedSuperviserDriver cannot be combined with rerunFromSessionId",
        ),
      );
    }
    if (normalizedOptions.continueFromWorkflowExecutionId !== undefined) {
      return err(
        workflowRunFailure(
          2,
          "nestedSuperviserDriver cannot be combined with continueFromWorkflowExecutionId",
        ),
      );
    }
    return runWorkflowInternal(
      workflowName,
      normalizedOptions,
      adapter,
      guards,
      [],
      runWorkflow,
    );
  }
  return runAutoImproveLoop(
    workflowName,
    normalizedOptions,
    adapter,
    guards,
    runWorkflowInternal,
  );
}
