import { describe, expect, test } from "vitest";
import { buildExecuteWorkflowRequest } from "./editor-execution";

describe("editor-execution", () => {
  test("builds a minimal execute request and omits empty optional fields", () => {
    expect(
      buildExecuteWorkflowRequest({
        runtimeVariablesText: '{ "topic": "demo" }',
        mockScenarioText: "",
        maxStepsText: "",
        maxLoopIterationsText: "",
        defaultTimeoutText: "",
        runAsync: true,
        runDryRun: false,
      }),
    ).toEqual({
      runtimeVariables: { topic: "demo" },
      async: true,
    });
  });

  test("includes optional execution overrides only when present", () => {
    expect(
      buildExecuteWorkflowRequest({
        runtimeVariablesText: '{ "topic": "demo" }',
        mockScenarioText: '{ "worker-1": { "provider": "scenario-mock" } }',
        maxStepsText: "12",
        maxLoopIterationsText: "3",
        defaultTimeoutText: "5000",
        runAsync: false,
        runDryRun: true,
      }),
    ).toEqual({
      runtimeVariables: { topic: "demo" },
      async: false,
      mockScenario: { "worker-1": { provider: "scenario-mock" } },
      maxSteps: 12,
      maxLoopIterations: 3,
      defaultTimeoutMs: 5000,
      dryRun: true,
    });
  });

  test("rejects malformed numeric values instead of truncating them", () => {
    expect(() =>
      buildExecuteWorkflowRequest({
        runtimeVariablesText: "{}",
        mockScenarioText: "",
        maxStepsText: "10ms",
        maxLoopIterationsText: "",
        defaultTimeoutText: "",
        runAsync: true,
        runDryRun: false,
      }),
    ).toThrow("Max steps must be a positive integer.");
  });

  test("rejects non-object runtime variables and mock scenario payloads", () => {
    expect(() =>
      buildExecuteWorkflowRequest({
        runtimeVariablesText: "[]",
        mockScenarioText: "",
        maxStepsText: "",
        maxLoopIterationsText: "",
        defaultTimeoutText: "",
        runAsync: true,
        runDryRun: false,
      }),
    ).toThrow("Runtime variables must be a JSON object.");

    expect(() =>
      buildExecuteWorkflowRequest({
        runtimeVariablesText: "{}",
        mockScenarioText: "[]",
        maxStepsText: "",
        maxLoopIterationsText: "",
        defaultTimeoutText: "",
        runAsync: true,
        runDryRun: false,
      }),
    ).toThrow("Mock scenario must be a JSON object.");
  });
});
