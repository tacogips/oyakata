import { readFile } from "node:fs/promises";
import { normalizeAutoImprovePolicy } from "../workflow/auto-improve-policy";
import type { WorkflowRunOptions } from "../workflow/engine";
import { createCommunicationService } from "../workflow/communication-service";
import { createManagerMessageService } from "../workflow/manager-message-service";
import {
  createManagerSessionStore,
  resolveAmbientManagerExecutionContext,
  type ManagerSessionStore,
} from "../workflow/manager-session-store";
import type { NodeExecutionRecord } from "../workflow/session";
import { err, ok, type Result } from "../workflow/result";
import { normalizeWorkflowWorkingDirectoryOverride } from "../workflow/working-directory";
import type {
  ExecuteWorkflowInput,
  GraphqlRequestContext,
  GraphqlSchemaDependencies,
} from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

export interface GraphqlWorkflowRunOverridesInput {
  readonly autoImprove?: ExecuteWorkflowInput["autoImprove"];
  readonly nestedSuperviser?: boolean;
  readonly workingDirectory?: string;
  readonly dryRun?: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
}

export function buildGraphqlWorkflowRunOverrides(
  input: GraphqlWorkflowRunOverridesInput,
): Result<
  Pick<
    WorkflowRunOptions,
    | "autoImprove"
    | "nestedSuperviserDriver"
    | "workflowWorkingDirectory"
    | "dryRun"
    | "maxSteps"
    | "maxLoopIterations"
    | "defaultTimeoutMs"
  >,
  string
> {
  const workflowWorkingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    input.workingDirectory,
  );
  const normalizedAutoImprove =
    input.autoImprove === undefined
      ? { ok: true as const, value: undefined }
      : normalizeAutoImprovePolicy(input.autoImprove);
  if (!normalizedAutoImprove.ok) {
    return err(`invalid autoImprove policy: ${normalizedAutoImprove.error}`);
  }
  if (
    input.nestedSuperviser === true &&
    normalizedAutoImprove.value === undefined
  ) {
    return err("nestedSuperviser requires autoImprove");
  }
  return ok({
    ...(workflowWorkingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory }),
    ...(normalizedAutoImprove.value === undefined
      ? {}
      : { autoImprove: normalizedAutoImprove.value }),
    ...(input.nestedSuperviser === true
      ? { nestedSuperviserDriver: true }
      : {}),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: input.maxLoopIterations }),
    ...(input.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: input.defaultTimeoutMs }),
  });
}

export function parseWorkflowExecutionStepRunsStatusFilter(
  raw: string | undefined | null,
): NodeExecutionRecord["status"] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const allowed: ReadonlySet<string> = new Set([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "skipped",
  ]);
  if (!allowed.has(trimmed)) {
    throw new Error(
      `invalid workflowExecutionStepRuns status '${raw}' (expected succeeded, failed, timed_out, cancelled, or skipped)`,
    );
  }
  return trimmed as NodeExecutionRecord["status"];
}

export async function readOptionalText(
  filePath: string,
): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

export function resolveManagerStore(
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies,
): ManagerSessionStore {
  return deps.managerSessionStore ?? createManagerSessionStore(context);
}

export function resolveCommunicationService(
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies,
) {
  const managerStore = resolveManagerStore(context, deps);
  return (
    deps.communicationService ??
    createCommunicationService({
      ...(deps.now === undefined ? {} : { now: deps.now }),
      idempotencyStore: managerStore,
    })
  );
}

export function resolveManagerMessageService(
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies,
) {
  const managerStore = resolveManagerStore(context, deps);
  return (
    deps.managerMessageService ??
    createManagerMessageService({
      ...(deps.now === undefined ? {} : { now: deps.now }),
      managerSessionStore: managerStore,
      communicationService: resolveCommunicationService(context, deps),
    })
  );
}

export function resolveScopedManagerSessionId(
  managerSessionId: string | undefined,
  context: GraphqlRequestContext,
): string | undefined {
  if (managerSessionId !== undefined) {
    return managerSessionId;
  }
  if (context.managerSessionId !== undefined) {
    return context.managerSessionId;
  }
  return resolveAmbientManagerExecutionContext(context.env)?.managerSessionId;
}

export function resolveScopedAuthToken(
  context: GraphqlRequestContext,
): string | undefined {
  if (context.authToken !== undefined) {
    return context.authToken;
  }
  return resolveAmbientManagerExecutionContext(context.env)?.authToken;
}
