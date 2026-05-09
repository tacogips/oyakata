import { executeGraphqlRequest } from "../graphql/client";
import { createGraphqlSchema } from "../graphql/schema";
import { normalizeWorkflowWorkingDirectoryOverride } from "../workflow/working-directory";
import type {
  WorkflowExecutionClient,
  WorkflowExecutionClientOptions,
  WorkflowExecutionClientRequest,
  WorkflowExecutionClientResult,
} from "./types";
import { executeWorkflow, resolveWorkflowCatalogOptions } from "./execution";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObjectField(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireStringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalBooleanField(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function optionalNumberField(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function resolveRuntimeVariables(
  request: WorkflowExecutionClientRequest | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (request?.input !== undefined && request.runtimeVariables !== undefined) {
    throw new Error("use only one of input or runtimeVariables");
  }
  return request?.runtimeVariables ?? request?.input;
}

async function executeWorkflowThroughGraphqlClient(
  options: WorkflowExecutionClientOptions,
  request: WorkflowExecutionClientRequest | undefined,
): Promise<WorkflowExecutionClientResult> {
  if (options.endpoint === undefined) {
    throw new Error("endpoint is required for GraphQL execution");
  }
  const runtimeVariables = resolveRuntimeVariables(request);
  const workingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    request?.workingDirectory,
  );
  const response = await executeGraphqlRequest({
    endpoint: options.endpoint,
    document: `
      mutation ExecuteWorkflow($input: ExecuteWorkflowInput!) {
        executeWorkflow(input: $input) {
          workflowExecutionId
          sessionId
          status
          accepted
          exitCode
        }
      }
    `,
    variables: {
      input: {
        workflowName: options.workflowName,
        ...(runtimeVariables === undefined ? {} : { runtimeVariables }),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(request?.mockScenario === undefined
          ? {}
          : { mockScenario: request.mockScenario }),
        ...(request?.async === undefined ? {} : { async: request.async }),
        ...(request?.dryRun === undefined ? {} : { dryRun: request.dryRun }),
        ...(request?.maxSteps === undefined
          ? {}
          : { maxSteps: request.maxSteps }),
        ...(request?.maxLoopIterations === undefined
          ? {}
          : { maxLoopIterations: request.maxLoopIterations }),
        ...(request?.defaultTimeoutMs === undefined
          ? {}
          : { defaultTimeoutMs: request.defaultTimeoutMs }),
      },
    },
    ...(options.authToken === undefined
      ? {}
      : { authToken: options.authToken }),
    ...(options.managerSessionId === undefined
      ? {}
      : { managerSessionId: options.managerSessionId }),
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  });
  if (response.errors !== undefined && response.errors.length > 0) {
    throw new Error(response.errors.map((entry) => entry.message).join("; "));
  }

  const data = requireObjectField(response.data, "GraphQL response.data");
  const payload = requireObjectField(
    data["executeWorkflow"],
    "executeWorkflow",
  );
  const accepted = optionalBooleanField(
    payload["accepted"],
    "executeWorkflow.accepted",
  );
  const exitCode = optionalNumberField(
    payload["exitCode"],
    "executeWorkflow.exitCode",
  );
  return {
    workflowName: options.workflowName,
    workflowExecutionId: requireStringField(
      payload["workflowExecutionId"],
      "executeWorkflow.workflowExecutionId",
    ),
    sessionId: requireStringField(
      payload["sessionId"],
      "executeWorkflow.sessionId",
    ),
    status: requireStringField(payload["status"], "executeWorkflow.status"),
    ...(accepted === undefined ? {} : { accepted }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

async function executeWorkflowThroughLibraryClient(
  options: WorkflowExecutionClientOptions,
  request: WorkflowExecutionClientRequest | undefined,
): Promise<WorkflowExecutionClientResult> {
  const runtimeVariables = resolveRuntimeVariables(request);
  const workingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    request?.workingDirectory,
  );
  if (request?.async === true) {
    const schema = createGraphqlSchema();
    const executionOptions = await resolveWorkflowCatalogOptions(
      options.workflowName,
      options,
    );
    const payload = await schema.mutation.executeWorkflow(
      {
        workflowName: options.workflowName,
        ...(runtimeVariables === undefined ? {} : { runtimeVariables }),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(request.mockScenario === undefined
          ? {}
          : { mockScenario: request.mockScenario }),
        async: true,
        ...(request.dryRun === undefined ? {} : { dryRun: request.dryRun }),
        ...(request.maxSteps === undefined
          ? {}
          : { maxSteps: request.maxSteps }),
        ...(request.maxLoopIterations === undefined
          ? {}
          : { maxLoopIterations: request.maxLoopIterations }),
        ...(request.defaultTimeoutMs === undefined
          ? {}
          : { defaultTimeoutMs: request.defaultTimeoutMs }),
      },
      executionOptions,
    );
    return {
      workflowName: options.workflowName,
      workflowExecutionId: payload.workflowExecutionId,
      sessionId: payload.sessionId,
      status: payload.status,
      ...(payload.accepted === undefined ? {} : { accepted: payload.accepted }),
      ...(payload.exitCode === undefined ? {} : { exitCode: payload.exitCode }),
    };
  }

  const result = await executeWorkflow({
    ...options,
    workflowName: options.workflowName,
    ...(workingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory: workingDirectory }),
    ...(runtimeVariables === undefined ? {} : { runtimeVariables }),
    ...(request?.mockScenario === undefined
      ? {}
      : { mockScenario: request.mockScenario }),
    ...(request?.dryRun === undefined ? {} : { dryRun: request.dryRun }),
    ...(request?.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
    ...(request?.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: request.maxLoopIterations }),
    ...(request?.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: request.defaultTimeoutMs }),
  });
  return {
    workflowName: options.workflowName,
    workflowExecutionId: result.sessionId,
    sessionId: result.sessionId,
    status: result.status,
    exitCode: result.exitCode,
  };
}

export function createWorkflowExecutionClient(
  options: WorkflowExecutionClientOptions,
): WorkflowExecutionClient {
  return {
    workflowName: options.workflowName,
    async execute(
      request: WorkflowExecutionClientRequest = {},
    ): Promise<WorkflowExecutionClientResult> {
      if (options.endpoint !== undefined) {
        return executeWorkflowThroughGraphqlClient(options, request);
      }
      return executeWorkflowThroughLibraryClient(options, request);
    },
  };
}
