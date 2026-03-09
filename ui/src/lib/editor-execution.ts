import type { ExecuteWorkflowRequest } from "../../../src/shared/ui-contract";
import { parseJsonObject, parseOptionalInteger } from "./editor-support";

export interface ExecuteWorkflowFormInput {
  readonly runtimeVariablesText: string;
  readonly mockScenarioText: string;
  readonly maxStepsText: string;
  readonly maxLoopIterationsText: string;
  readonly defaultTimeoutText: string;
  readonly runAsync: boolean;
  readonly runDryRun: boolean;
}

export function buildExecuteWorkflowRequest(
  input: ExecuteWorkflowFormInput,
): ExecuteWorkflowRequest {
  const runtimeVariables = parseJsonObject(
    input.runtimeVariablesText,
    "Runtime variables",
  );
  const mockScenario = parseJsonObject(input.mockScenarioText, "Mock scenario");
  const maxSteps = parseOptionalInteger(input.maxStepsText, "Max steps");
  const maxLoopIterations = parseOptionalInteger(
    input.maxLoopIterationsText,
    "Max loop iterations",
  );
  const defaultTimeoutMs = parseOptionalInteger(
    input.defaultTimeoutText,
    "Default timeout",
  );

  return {
    runtimeVariables,
    async: input.runAsync,
    ...(Object.keys(mockScenario).length > 0 ? { mockScenario } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(maxLoopIterations !== undefined ? { maxLoopIterations } : {}),
    ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
    ...(input.runDryRun ? { dryRun: true } : {}),
  };
}
