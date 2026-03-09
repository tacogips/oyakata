import type {
  CancelWorkflowExecutionResponse,
  CreateWorkflowRequest,
  ErrorResponse,
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  SaveWorkflowRequest,
  SaveWorkflowResponse,
  SessionsResponse,
  UiConfigResponse,
  ValidateWorkflowRequest,
  ValidationResponse,
  WorkflowExecutionStateResponse,
  WorkflowListResponse,
  WorkflowResponse,
} from "../../../src/shared/ui-contract";
import type { EditorWorkflowBundle } from "./editor-workflow";

export class ApiError extends Error {
  readonly status: number;
  readonly payload: ErrorResponse;

  constructor(status: number, payload: ErrorResponse) {
    super(
      typeof payload.error === "string"
        ? payload.error
        : `request failed: ${status}`,
    );
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export class WorkflowRevisionConflictError extends Error {
  readonly currentRevision: string;

  constructor(currentRevision: string) {
    super(
      `Workflow revision conflict. Current revision is ${currentRevision}. Reload and retry.`,
    );
    this.name = "WorkflowRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

async function readJsonResponse<T>(
  response: Response,
): Promise<T & ErrorResponse> {
  return (await response.json()) as T & ErrorResponse;
}

function throwApiError(response: Response, payload: ErrorResponse): never {
  throw new ApiError(response.status, payload);
}

async function fetchJson<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const payload = await readJsonResponse<T>(response);
  if (!response.ok) {
    throwApiError(response, payload);
  }
  return payload;
}

async function fetchJsonWithResponse<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<{
  response: Response;
  payload: T & ErrorResponse;
}> {
  const response = await fetch(input, init);
  const payload = await readJsonResponse<T>(response);
  return { response, payload };
}

function workflowPath(workflowName: string, suffix = ""): string {
  return `/api/workflows/${encodeURIComponent(workflowName)}${suffix}`;
}

function workflowExecutionPath(
  workflowExecutionId: string,
  suffix = "",
): string {
  return `/api/workflow-executions/${encodeURIComponent(workflowExecutionId)}${suffix}`;
}

export function loadConfig(): Promise<UiConfigResponse> {
  return fetchJson<UiConfigResponse>("/api/ui-config");
}

export function listWorkflows(): Promise<WorkflowListResponse> {
  return fetchJson<WorkflowListResponse>("/api/workflows");
}

export function loadWorkflow(workflowName: string): Promise<WorkflowResponse> {
  return fetchJson<WorkflowResponse>(workflowPath(workflowName));
}

export function createWorkflow(
  workflowName: string,
): Promise<WorkflowResponse> {
  const request: CreateWorkflowRequest = { workflowName };
  return fetchJson<WorkflowResponse>("/api/workflows", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

export function validateWorkflowBundle(
  workflowName: string,
  bundle: EditorWorkflowBundle,
): Promise<ValidationResponse> {
  const request: ValidateWorkflowRequest<EditorWorkflowBundle> = { bundle };
  return fetchJson<ValidationResponse>(
    workflowPath(workflowName, "/validate"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );
}

export async function saveWorkflowBundle(input: {
  readonly workflowName: string;
  readonly bundle: EditorWorkflowBundle;
  readonly expectedRevision?: string;
}): Promise<SaveWorkflowResponse> {
  const request: SaveWorkflowRequest<EditorWorkflowBundle> = {
    bundle: input.bundle,
    ...(input.expectedRevision === undefined
      ? {}
      : { expectedRevision: input.expectedRevision }),
  };
  const { response, payload } =
    await fetchJsonWithResponse<SaveWorkflowResponse>(
      workflowPath(input.workflowName),
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );

  if (!response.ok) {
    if (
      response.status === 409 &&
      typeof payload.currentRevision === "string"
    ) {
      throw new WorkflowRevisionConflictError(payload.currentRevision);
    }
    throwApiError(response, payload);
  }

  return payload;
}

export function listSessions(): Promise<SessionsResponse> {
  return fetchJson<SessionsResponse>("/api/sessions");
}

export function loadWorkflowExecution(
  workflowExecutionId: string,
): Promise<WorkflowExecutionStateResponse> {
  return fetchJson<WorkflowExecutionStateResponse>(
    workflowExecutionPath(workflowExecutionId),
  );
}

export function executeWorkflow(
  workflowName: string,
  request: ExecuteWorkflowRequest,
): Promise<ExecuteWorkflowResponse> {
  return fetchJson<ExecuteWorkflowResponse>(
    workflowPath(workflowName, "/execute"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );
}

export function cancelWorkflowExecution(
  workflowExecutionId: string,
): Promise<CancelWorkflowExecutionResponse> {
  return fetchJson<CancelWorkflowExecutionResponse>(
    workflowExecutionPath(workflowExecutionId, "/cancel"),
    {
      method: "POST",
    },
  );
}
