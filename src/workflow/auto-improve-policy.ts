import { err, ok, type Result } from "./result";
import type { AutoImprovePolicy } from "./types";

/** Default superviser bundle id (valid workflow id; loadWorkflowByIdFromDisk matches workflow.json). */
export const DEFAULT_SUPERVISER_WORKFLOW_ID = "divedra-default-superviser";
export const DEFAULT_MONITOR_INTERVAL_MS = 5_000;
export const DEFAULT_STALL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_SUPERVISED_ATTEMPTS = 5;
export const DEFAULT_MAX_WORKFLOW_PATCHES = 3;
export const DEFAULT_WORKFLOW_MUTATION_MODE = "execution-copy" as const;

export interface AutoImprovePolicyInput {
  readonly enabled: boolean;
  readonly superviserWorkflowId?: string;
  readonly monitorIntervalMs?: number;
  readonly stallTimeoutMs?: number;
  readonly maxSupervisedAttempts?: number;
  readonly maxWorkflowPatches?: number;
  readonly workflowMutationMode?: "execution-copy" | "in-place";
  readonly allowTargetedRerun?: boolean;
}

function hasDisabledAutoImproveOverrides(input: AutoImprovePolicyInput): boolean {
  return (
    input.superviserWorkflowId !== undefined ||
    input.monitorIntervalMs !== undefined ||
    input.stallTimeoutMs !== undefined ||
    input.maxSupervisedAttempts !== undefined ||
    input.maxWorkflowPatches !== undefined ||
    input.workflowMutationMode !== undefined ||
    input.allowTargetedRerun !== undefined
  );
}

function validatePositiveInteger(
  value: unknown,
  fieldName: string,
): Result<number, string> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return err(`${fieldName} must be a positive integer`);
  }
  return ok(value);
}

function validateOptionalString(
  value: unknown,
  fieldName: string,
): Result<string | undefined, string> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "string") {
    return err(`${fieldName} must be a string when provided`);
  }
  return ok(value);
}

export function resolveSuperviserWorkflowId(
  value: string | undefined,
): Result<string, string> {
  if (value === undefined) {
    return ok(DEFAULT_SUPERVISER_WORKFLOW_ID);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return err("superviserWorkflowId must not be empty when provided");
  }
  return ok(normalized);
}

function validateWorkflowMutationMode(
  value: unknown,
): Result<"execution-copy" | "in-place", string> {
  if (value === undefined) {
    return ok(DEFAULT_WORKFLOW_MUTATION_MODE);
  }
  if (value === "execution-copy" || value === "in-place") {
    return ok(value);
  }
  return err(
    "workflowMutationMode must be 'execution-copy' or 'in-place' when provided",
  );
}

export function normalizeAutoImprovePolicy(
  input: AutoImprovePolicyInput,
): Result<AutoImprovePolicy | undefined, string> {
  if (input.enabled !== true && input.enabled !== false) {
    return err("enabled must be a boolean");
  }
  if (!input.enabled) {
    if (hasDisabledAutoImproveOverrides(input)) {
      return err(
        "autoImprove settings require enabled=true when additional policy fields are provided",
      );
    }
    return ok(undefined);
  }

  const superviserWorkflowId = validateOptionalString(
    input.superviserWorkflowId,
    "superviserWorkflowId",
  );
  if (!superviserWorkflowId.ok) {
    return superviserWorkflowId;
  }
  const normalizedSuperviserWorkflowId = resolveSuperviserWorkflowId(
    superviserWorkflowId.value,
  );
  if (!normalizedSuperviserWorkflowId.ok) {
    return normalizedSuperviserWorkflowId;
  }

  const monitorIntervalMs = validatePositiveInteger(
    input.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS,
    "monitorIntervalMs",
  );
  if (!monitorIntervalMs.ok) {
    return monitorIntervalMs;
  }

  const stallTimeoutMs = validatePositiveInteger(
    input.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    "stallTimeoutMs",
  );
  if (!stallTimeoutMs.ok) {
    return stallTimeoutMs;
  }
  if (stallTimeoutMs.value < monitorIntervalMs.value) {
    return err(
      "stallTimeoutMs must be greater than or equal to monitorIntervalMs",
    );
  }

  const maxSupervisedAttempts = validatePositiveInteger(
    input.maxSupervisedAttempts ?? DEFAULT_MAX_SUPERVISED_ATTEMPTS,
    "maxSupervisedAttempts",
  );
  if (!maxSupervisedAttempts.ok) {
    return maxSupervisedAttempts;
  }

  const maxWorkflowPatches = validatePositiveInteger(
    input.maxWorkflowPatches ?? DEFAULT_MAX_WORKFLOW_PATCHES,
    "maxWorkflowPatches",
  );
  if (!maxWorkflowPatches.ok) {
    return maxWorkflowPatches;
  }

  const workflowMutationMode = validateWorkflowMutationMode(
    input.workflowMutationMode,
  );
  if (!workflowMutationMode.ok) {
    return workflowMutationMode;
  }

  if (
    input.allowTargetedRerun !== undefined &&
    typeof input.allowTargetedRerun !== "boolean"
  ) {
    return err("allowTargetedRerun must be a boolean when provided");
  }

  return ok({
    enabled: true,
    superviserWorkflowId: normalizedSuperviserWorkflowId.value,
    monitorIntervalMs: monitorIntervalMs.value,
    stallTimeoutMs: stallTimeoutMs.value,
    maxSupervisedAttempts: maxSupervisedAttempts.value,
    maxWorkflowPatches: maxWorkflowPatches.value,
    workflowMutationMode: workflowMutationMode.value,
    ...(input.allowTargetedRerun === false
      ? { allowTargetedRerun: false as const }
      : {}),
  });
}
