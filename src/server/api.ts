import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runWorkflow } from "../workflow/engine";
import { loadWorkflowFromDisk } from "../workflow/load";
import { isSafeWorkflowName, resolveEffectiveRoots } from "../workflow/paths";
import { computeWorkflowRevisionFromFiles } from "../workflow/revision";
import { saveWorkflowToDisk } from "../workflow/save";
import { loadSession, saveSession, type SessionStoreOptions } from "../workflow/session-store";
import type { LoadOptions } from "../workflow/types";

export interface ApiContext extends LoadOptions, SessionStoreOptions {
  readonly readOnly?: boolean;
  readonly noExec?: boolean;
  readonly fixedWorkflowName?: string;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return {};
  }
}

async function listWorkflowNames(options: LoadOptions): Promise<readonly string[]> {
  const roots = resolveEffectiveRoots(options);
  const entries = await readdir(roots.workflowRoot, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workflowPath = path.join(roots.workflowRoot, entry.name, "workflow.json");
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

export async function handleApiRequest(request: Request, context: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  const parts = routeParts(url.pathname);

  if (url.pathname === "/" || url.pathname === "") {
    return json({ service: "oyakata-serve", status: "ok" });
  }

  if (parts.length === 2 && parts[0] === "api" && parts[1] === "workflows" && request.method === "GET") {
    const names = await listWorkflowNames(context);
    return json({ workflows: names });
  }

  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "workflows") {
    const workflowName = parts[2];
    if (workflowName === undefined) {
      return json({ error: "workflow name is required" }, 400);
    }
    if (!isSafeWorkflowName(workflowName)) {
      return json({ error: "invalid workflow name" }, 400);
    }
    if (context.fixedWorkflowName !== undefined && context.fixedWorkflowName !== workflowName) {
      return json({ error: "workflow name not allowed in fixed workflow mode" }, 403);
    }

    if (parts.length === 3 && request.method === "GET") {
      const loaded = await loadWorkflowFromDisk(workflowName, context);
      if (!loaded.ok) {
        return json({ error: loaded.error.message, issues: loaded.error.issues ?? [] }, 404);
      }
      const nodeFiles = loaded.value.bundle.workflow.nodes.map((node) => node.nodeFile);
      const revision = await computeWorkflowRevisionFromFiles(loaded.value.workflowDirectory, nodeFiles);
      return json({
        workflowName: loaded.value.workflowName,
        workflowDirectory: loaded.value.workflowDirectory,
        artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
        revision: revision.ok ? revision.value : null,
        bundle: loaded.value.bundle,
      });
    }

    if (parts.length === 3 && request.method === "PUT") {
      if (context.readOnly === true) {
        return json({ error: "read-only mode enabled" }, 403);
      }

      const body = await parseJsonBody(request);
      const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const bundle = bodyObj["bundle"];
      const expectedRevision =
        typeof bodyObj["expectedRevision"] === "string" ? bodyObj["expectedRevision"] : undefined;

      if (typeof bundle !== "object" || bundle === null) {
        return json({ error: "bundle is required" }, 400);
      }

      const bundleObj = bundle as Record<string, unknown>;
      const workflow = bundleObj["workflow"];
      const workflowVis = bundleObj["workflowVis"];
      const nodePayloadsRaw = bundleObj["nodePayloads"];
      if (typeof workflow !== "object" || workflow === null) {
        return json({ error: "bundle.workflow is required" }, 400);
      }
      if (typeof workflowVis !== "object" || workflowVis === null) {
        return json({ error: "bundle.workflowVis is required" }, 400);
      }
      if (typeof nodePayloadsRaw !== "object" || nodePayloadsRaw === null || Array.isArray(nodePayloadsRaw)) {
        return json({ error: "bundle.nodePayloads is required" }, 400);
      }

      const saveResult = await saveWorkflowToDisk(
        workflowName,
        {
          workflow,
          workflowVis,
          nodePayloads: nodePayloadsRaw as Readonly<Record<string, unknown>>,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
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
        const status = saveResult.error.code === "VALIDATION" || saveResult.error.code === "INVALID_WORKFLOW_NAME" ? 400 : 500;
        return json({ error: saveResult.error.message, issues: saveResult.error.issues ?? [] }, status);
      }

      return json({
        workflowName: saveResult.value.workflowName,
        workflowDirectory: saveResult.value.workflowDirectory,
        revision: saveResult.value.revision,
      });
    }

    if (parts.length === 4 && parts[3] === "validate" && request.method === "POST") {
      const loaded = await loadWorkflowFromDisk(workflowName, context);
      if (!loaded.ok) {
        return json({ valid: false, error: loaded.error.message, issues: loaded.error.issues ?? [] }, 200);
      }
      return json({ valid: true, workflowId: loaded.value.bundle.workflow.workflowId, warnings: [] });
    }

    if (parts.length === 4 && parts[3] === "execute" && request.method === "POST") {
      if (context.noExec === true) {
        return json({ error: "execution is disabled (no-exec mode)" }, 403);
      }

      const body = await parseJsonBody(request);
      const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const runtimeVariables =
        typeof bodyObj["runtimeVariables"] === "object" && bodyObj["runtimeVariables"] !== null
          ? (bodyObj["runtimeVariables"] as Readonly<Record<string, unknown>>)
          : {};

      const runResult = await runWorkflow(workflowName, {
        ...context,
        runtimeVariables,
        ...(typeof bodyObj["maxSteps"] === "number" ? { maxSteps: bodyObj["maxSteps"] } : {}),
        ...(typeof bodyObj["maxLoopIterations"] === "number"
          ? { maxLoopIterations: bodyObj["maxLoopIterations"] }
          : {}),
        ...(typeof bodyObj["defaultTimeoutMs"] === "number"
          ? { defaultTimeoutMs: bodyObj["defaultTimeoutMs"] }
          : {}),
        ...(bodyObj["dryRun"] === true ? { dryRun: true } : {}),
      });

      if (!runResult.ok) {
        const status = runResult.error.exitCode === 2 ? 400 : 500;
        return json({ error: runResult.error.message, exitCode: runResult.error.exitCode }, status);
      }

      return json({
        sessionId: runResult.value.session.sessionId,
        status: runResult.value.session.status,
        exitCode: runResult.value.exitCode,
      });
    }
  }

  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "sessions") {
    const sessionId = parts[2];
    if (sessionId === undefined) {
      return json({ error: "session id is required" }, 400);
    }

    if (parts.length === 3 && request.method === "GET") {
      const loaded = await loadSession(sessionId, context);
      if (!loaded.ok) {
        return json({ error: loaded.error.message }, 404);
      }
      return json(loaded.value);
    }

    if (parts.length === 4 && parts[3] === "cancel" && request.method === "POST") {
      if (context.noExec === true) {
        return json({ error: "execution is disabled (no-exec mode)" }, 403);
      }

      const loaded = await loadSession(sessionId, context);
      if (!loaded.ok) {
        return json({ error: loaded.error.message }, 404);
      }

      if (loaded.value.status === "completed" || loaded.value.status === "failed" || loaded.value.status === "cancelled") {
        return json({ accepted: false, status: loaded.value.status });
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

      return json({ accepted: true, status: "cancelled" });
    }
  }

  if (request.method === "PUT" && context.readOnly === true) {
    return json({ error: "read-only mode enabled" }, 403);
  }

  return json({ error: "not found" }, 404);
}
