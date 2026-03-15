import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CancelWorkflowExecutionResponse,
  ExecuteWorkflowResponse,
  FrontendMode,
  RerunWorkflowResponse,
  SaveWorkflowResponse,
  SessionsResponse,
  UiConfigResponse,
  ValidationResponse,
  WorkflowExecutionStateResponse,
  WorkflowExecutionSummary,
  WorkflowListResponse,
  WorkflowResponse,
} from "../shared/ui-contract";
import { createWorkflowTemplate } from "../workflow/create";
import { runWorkflow } from "../workflow/engine";
import { loadWorkflowFromDisk } from "../workflow/load";
import { isSafeWorkflowName, resolveEffectiveRoots } from "../workflow/paths";
import {
  collectPromptTemplateFiles,
  computeWorkflowRevisionFromFiles,
} from "../workflow/revision";
import { createSessionId } from "../workflow/session";
import { saveWorkflowToDisk } from "../workflow/save";
import {
  listSessions,
  loadSession,
  saveSession,
  type SessionStoreOptions,
} from "../workflow/session-store";
import type { LoadOptions } from "../workflow/types";
import { validateWorkflowBundleDetailed } from "../workflow/validate";
import { deriveWorkflowVisualization } from "../workflow/visualization";
import {
  jsonBodyObject,
  optionalTrimmedStringField,
  readWorkflowExecuteRequestOptions,
  readWorkflowRerunRequestOptions,
} from "./api-request";
import {
  readWorkflowSaveRequest,
  readWorkflowValidationBundle,
  remapNodePayloadsForValidation,
} from "./api-workflow-bundle";
import {
  detectFrontendMode,
  missingUiResponse,
  tryServeBuiltUiAsset,
} from "./ui-assets";
import { handleGraphqlRequest } from "./graphql";

export { resolveDefaultUiDistRoot } from "./ui-assets";

export interface ApiContext extends LoadOptions, SessionStoreOptions {
  readonly readOnly?: boolean;
  readonly noExec?: boolean;
  readonly fixedWorkflowName?: string;
  readonly uiDistRoot?: string;
  readonly frontendMode?: FrontendMode;
  readonly frontendModeModuleUrl?: string;
}

function withWorkflowExecutionId<T extends { readonly sessionId: string }>(
  value: T,
): T & { readonly workflowExecutionId: string } {
  return {
    ...value,
    workflowExecutionId: value.sessionId,
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function buildUiConfigResponse(context: ApiContext): UiConfigResponse {
  return {
    fixedWorkflowName: context.fixedWorkflowName ?? null,
    readOnly: context.readOnly === true,
    noExec: context.noExec === true,
    frontend: detectFrontendMode(context),
  };
}

async function loadWorkflowExecutionResponse(
  workflowExecutionId: string,
  context: ApiContext,
): Promise<Response> {
  const loaded = await loadSession(workflowExecutionId, context);
  if (!loaded.ok) {
    return json({ error: loaded.error.message }, 404);
  }

  return json(
    withWorkflowExecutionId(
      loaded.value,
    ) satisfies WorkflowExecutionStateResponse,
  );
}

async function cancelWorkflowExecutionResponse(
  workflowExecutionId: string,
  context: ApiContext,
): Promise<Response> {
  if (context.noExec === true) {
    return json({ error: "execution is disabled (no-exec mode)" }, 403);
  }

  const loaded = await loadSession(workflowExecutionId, context);
  if (!loaded.ok) {
    return json({ error: loaded.error.message }, 404);
  }

  if (
    loaded.value.status === "completed" ||
    loaded.value.status === "failed" ||
    loaded.value.status === "cancelled"
  ) {
    return json({
      accepted: false,
      status: loaded.value.status,
      workflowExecutionId: loaded.value.sessionId,
      sessionId: loaded.value.sessionId,
    } satisfies CancelWorkflowExecutionResponse);
  }

  const cancelled = {
    ...loaded.value,
    status: "cancelled" as const,
    endedAt: new Date().toISOString(),
    lastError: "cancelled by API request",
  };

  const saved = await saveSession(cancelled, context);
  if (!saved.ok) {
    return json({ error: saved.error.message }, 500);
  }

  return json({
    accepted: true,
    status: "cancelled",
    workflowExecutionId: loaded.value.sessionId,
    sessionId: loaded.value.sessionId,
  } satisfies CancelWorkflowExecutionResponse);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return {};
  }
}

async function listWorkflowNames(
  options: LoadOptions,
): Promise<readonly string[]> {
  const roots = resolveEffectiveRoots(options);
  let entries;
  try {
    entries = await readdir(roots.workflowRoot, { withFileTypes: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return [];
    }
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workflowPath = path.join(
      roots.workflowRoot,
      entry.name,
      "workflow.json",
    );
    try {
      const details = await stat(workflowPath);
      if (details.isFile()) {
        names.push(entry.name);
      }
    } catch {
      // Skip incomplete directories.
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function routeParts(pathname: string): readonly string[] {
  return pathname.split("/").filter((entry) => entry.length > 0);
}

export async function handleApiRequest(
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = routeParts(url.pathname);

  if (url.pathname === "/graphql") {
    return handleGraphqlRequest(request, context);
  }

  if (url.pathname === "/api/ui-config" && request.method === "GET") {
    try {
      return json(buildUiConfigResponse(context));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 500);
    }
  }

  if (url.pathname === "/" || url.pathname === "/ui") {
    const builtUi = await tryServeBuiltUiAsset(url.pathname, context);
    if (builtUi !== undefined) {
      return builtUi;
    }

    return missingUiResponse();
  }

  if (url.pathname === "/healthz") {
    return json({ service: "oyakata-serve", status: "ok" });
  }

  if (request.method === "GET" && parts[0] !== "api") {
    const builtUi = await tryServeBuiltUiAsset(url.pathname, context);
    if (builtUi !== undefined) {
      return builtUi;
    }
  }

  if (
    parts.length === 2 &&
    parts[0] === "api" &&
    parts[1] === "workflows" &&
    request.method === "GET"
  ) {
    const names = await listWorkflowNames(context);
    return json({ workflows: names } satisfies WorkflowListResponse);
  }

  if (
    parts.length === 2 &&
    parts[0] === "api" &&
    parts[1] === "workflows" &&
    request.method === "POST"
  ) {
    if (context.readOnly === true) {
      return json({ error: "read-only mode enabled" }, 403);
    }
    if (context.fixedWorkflowName !== undefined) {
      return json(
        { error: "cannot create workflows in fixed workflow mode" },
        403,
      );
    }

    const body = await parseJsonBody(request);
    const workflowName = optionalTrimmedStringField(
      jsonBodyObject(body),
      "workflowName",
    );
    if (workflowName === undefined) {
      return json({ error: "workflowName is required" }, 400);
    }

    const created = await createWorkflowTemplate(workflowName, context);
    if (!created.ok) {
      const status =
        created.error.code === "ALREADY_EXISTS"
          ? 409
          : created.error.code === "INVALID_WORKFLOW_NAME"
            ? 400
            : 500;
      return json({ error: created.error.message }, status);
    }

    const loaded = await loadWorkflowFromDisk(
      created.value.workflowName,
      context,
    );
    if (!loaded.ok) {
      return json(
        { error: loaded.error.message, issues: loaded.error.issues ?? [] },
        500,
      );
    }
    const nodeFiles = loaded.value.bundle.workflow.nodes.map(
      (node) => node.nodeFile,
    );
    const revision = await computeWorkflowRevisionFromFiles(
      loaded.value.workflowDirectory,
      nodeFiles,
      collectPromptTemplateFiles(loaded.value.bundle.nodePayloads),
    );

    return json(
      {
        workflowName: loaded.value.workflowName,
        workflowDirectory: loaded.value.workflowDirectory,
        revision: revision.ok ? revision.value : null,
        bundle: loaded.value.bundle,
        derivedVisualization: deriveWorkflowVisualization({
          workflow: loaded.value.bundle.workflow,
          workflowVis: loaded.value.bundle.workflowVis,
        }),
      } satisfies WorkflowResponse,
      201,
    );
  }

  if (
    parts.length === 2 &&
    parts[0] === "api" &&
    parts[1] === "sessions" &&
    request.method === "GET"
  ) {
    const listed = await listSessions(context);
    if (!listed.ok) {
      return json({ error: listed.error.message }, 500);
    }
    const sessions = await Promise.all(
      listed.value.map(async (sessionId) => {
        const loaded = await loadSession(sessionId, context);
        if (!loaded.ok) {
          return undefined;
        }
        return withWorkflowExecutionId({
          sessionId: loaded.value.sessionId,
          workflowName: loaded.value.workflowName,
          status: loaded.value.status,
          currentNodeId: loaded.value.currentNodeId ?? null,
          nodeExecutionCounter: loaded.value.nodeExecutionCounter,
          startedAt: loaded.value.startedAt,
          endedAt: loaded.value.endedAt ?? null,
        }) satisfies WorkflowExecutionSummary;
      }),
    );
    return json({
      sessions: sessions.filter(
        (entry): entry is WorkflowExecutionSummary => entry !== undefined,
      ),
    } satisfies SessionsResponse);
  }

  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "workflows") {
    const workflowName = parts[2];
    if (workflowName === undefined) {
      return json({ error: "workflow name is required" }, 400);
    }
    if (!isSafeWorkflowName(workflowName)) {
      return json({ error: "invalid workflow name" }, 400);
    }
    if (
      context.fixedWorkflowName !== undefined &&
      context.fixedWorkflowName !== workflowName
    ) {
      return json(
        { error: "workflow name not allowed in fixed workflow mode" },
        403,
      );
    }

    if (parts.length === 3 && request.method === "GET") {
      const loaded = await loadWorkflowFromDisk(workflowName, context);
      if (!loaded.ok) {
        return json(
          { error: loaded.error.message, issues: loaded.error.issues ?? [] },
          404,
        );
      }
      const nodeFiles = loaded.value.bundle.workflow.nodes.map(
        (node) => node.nodeFile,
      );
      const revision = await computeWorkflowRevisionFromFiles(
        loaded.value.workflowDirectory,
        nodeFiles,
        collectPromptTemplateFiles(loaded.value.bundle.nodePayloads),
      );
      return json({
        workflowName: loaded.value.workflowName,
        workflowDirectory: loaded.value.workflowDirectory,
        artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
        revision: revision.ok ? revision.value : null,
        bundle: loaded.value.bundle,
        derivedVisualization: deriveWorkflowVisualization({
          workflow: loaded.value.bundle.workflow,
          workflowVis: loaded.value.bundle.workflowVis,
        }),
      } satisfies WorkflowResponse);
    }

    if (parts.length === 3 && request.method === "PUT") {
      if (context.readOnly === true) {
        return json({ error: "read-only mode enabled" }, 403);
      }

      const body = await parseJsonBody(request);
      const parsedRequest = readWorkflowSaveRequest(body);
      if (!parsedRequest.ok) {
        return json({ error: parsedRequest.error }, 400);
      }

      const saveResult = await saveWorkflowToDisk(
        workflowName,
        {
          workflow: parsedRequest.value.bundle.workflow,
          workflowVis: parsedRequest.value.bundle.workflowVis,
          nodePayloads: parsedRequest.value.bundle.nodePayloads,
          ...(parsedRequest.value.expectedRevision === undefined
            ? {}
            : { expectedRevision: parsedRequest.value.expectedRevision }),
        },
        context,
      );
      if (!saveResult.ok) {
        if (saveResult.error.code === "CONFLICT") {
          return json(
            {
              error: saveResult.error.message,
              currentRevision: saveResult.error.currentRevision ?? null,
            },
            409,
          );
        }
        const status =
          saveResult.error.code === "VALIDATION" ||
          saveResult.error.code === "INVALID_WORKFLOW_NAME"
            ? 400
            : 500;
        return json(
          {
            error: saveResult.error.message,
            issues: saveResult.error.issues ?? [],
          },
          status,
        );
      }

      return json({
        workflowName: saveResult.value.workflowName,
        workflowDirectory: saveResult.value.workflowDirectory,
        revision: saveResult.value.revision,
      } satisfies SaveWorkflowResponse);
    }

    if (
      parts.length === 4 &&
      parts[3] === "validate" &&
      request.method === "POST"
    ) {
      const body = await parseJsonBody(request);
      const parsedBundle = readWorkflowValidationBundle(body);
      if (parsedBundle.kind === "invalid") {
        return json(
          {
            valid: false,
            error: parsedBundle.error,
          } satisfies ValidationResponse,
          200,
        );
      }
      if (parsedBundle.kind === "bundle") {
        const validation = validateWorkflowBundleDetailed({
          workflow: parsedBundle.value.workflow,
          workflowVis: parsedBundle.value.workflowVis,
          nodePayloads: remapNodePayloadsForValidation(parsedBundle.value),
        });
        if (!validation.ok) {
          return json(
            {
              valid: false,
              issues: validation.error,
            } satisfies ValidationResponse,
            200,
          );
        }
        return json({
          valid: true,
          workflowId: validation.value.bundle.workflow.workflowId,
          warnings: validation.value.issues.filter(
            (issue) => issue.severity === "warning",
          ),
          issues: validation.value.issues,
        } satisfies ValidationResponse);
      }

      const loaded = await loadWorkflowFromDisk(workflowName, context);
      if (!loaded.ok) {
        return json(
          {
            valid: false,
            error: loaded.error.message,
            issues: loaded.error.issues ?? [],
          } satisfies ValidationResponse,
          200,
        );
      }
      return json({
        valid: true,
        workflowId: loaded.value.bundle.workflow.workflowId,
        warnings: [],
      } satisfies ValidationResponse);
    }

    if (
      parts.length === 4 &&
      parts[3] === "execute" &&
      request.method === "POST"
    ) {
      if (context.noExec === true) {
        return json({ error: "execution is disabled (no-exec mode)" }, 403);
      }

      const body = await parseJsonBody(request);
      const { asyncMode, ...runOptions } =
        readWorkflowExecuteRequestOptions(body);

      if (asyncMode) {
        const sessionId = createSessionId();
        void runWorkflow(workflowName, {
          ...context,
          sessionId,
          ...runOptions,
        });
        return json(
          {
            accepted: true,
            workflowExecutionId: sessionId,
            sessionId,
            status: "running",
          } satisfies ExecuteWorkflowResponse,
          202,
        );
      }

      const runResult = await runWorkflow(workflowName, {
        ...context,
        ...runOptions,
      });

      if (!runResult.ok) {
        const status = runResult.error.exitCode === 2 ? 400 : 500;
        return json(
          {
            error: runResult.error.message,
            exitCode: runResult.error.exitCode,
          },
          status,
        );
      }

      return json({
        workflowExecutionId: runResult.value.session.sessionId,
        sessionId: runResult.value.session.sessionId,
        status: runResult.value.session.status,
        exitCode: runResult.value.exitCode,
      } satisfies ExecuteWorkflowResponse);
    }
  }

  if (
    parts.length >= 3 &&
    parts[0] === "api" &&
    parts[1] === "workflow-executions"
  ) {
    const workflowExecutionId = parts[2];
    if (workflowExecutionId === undefined) {
      return json({ error: "workflow execution id is required" }, 400);
    }

    if (parts.length === 3 && request.method === "GET") {
      return await loadWorkflowExecutionResponse(workflowExecutionId, context);
    }

    if (
      parts.length === 4 &&
      parts[3] === "cancel" &&
      request.method === "POST"
    ) {
      return await cancelWorkflowExecutionResponse(
        workflowExecutionId,
        context,
      );
    }
  }

  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "sessions") {
    const sessionId = parts[2];
    if (sessionId === undefined) {
      return json({ error: "session id is required" }, 400);
    }

    if (parts.length === 3 && request.method === "GET") {
      return await loadWorkflowExecutionResponse(sessionId, context);
    }

    if (
      parts.length === 4 &&
      parts[3] === "cancel" &&
      request.method === "POST"
    ) {
      return await cancelWorkflowExecutionResponse(sessionId, context);
    }

    if (
      parts.length === 4 &&
      parts[3] === "rerun" &&
      request.method === "POST"
    ) {
      if (context.noExec === true) {
        return json({ error: "execution is disabled (no-exec mode)" }, 403);
      }

      const loaded = await loadSession(sessionId, context);
      if (!loaded.ok) {
        return json({ error: loaded.error.message }, 404);
      }

      const body = await parseJsonBody(request);
      const { fromNodeId, ...runOptions } =
        readWorkflowRerunRequestOptions(body);
      if (fromNodeId === undefined || fromNodeId.length === 0) {
        return json({ error: "fromNodeId is required" }, 400);
      }

      const rerun = await runWorkflow(loaded.value.workflowName, {
        ...context,
        ...runOptions,
        rerunFromSessionId: loaded.value.sessionId,
        rerunFromNodeId: fromNodeId,
      });
      if (!rerun.ok) {
        return json(
          { error: rerun.error.message, exitCode: rerun.error.exitCode },
          400,
        );
      }

      return json({
        sourceWorkflowExecutionId: loaded.value.sessionId,
        sourceSessionId: loaded.value.sessionId,
        workflowExecutionId: rerun.value.session.sessionId,
        sessionId: rerun.value.session.sessionId,
        status: rerun.value.session.status,
        rerunFromNodeId: fromNodeId,
        exitCode: rerun.value.exitCode,
      } satisfies RerunWorkflowResponse);
    }
  }

  if (request.method === "PUT" && context.readOnly === true) {
    return json({ error: "read-only mode enabled" }, 403);
  }

  return json({ error: "not found" }, 404);
}
