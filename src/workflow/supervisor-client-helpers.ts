import { loadWorkflowFromCatalog } from "./load";
import { withResolvedWorkflowSourceOptions } from "./catalog";
import { loadSession, saveSession } from "./session-store";
import type { WorkflowSessionState } from "./session";
import type { MockNodeScenario } from "./adapter";
import type { LoadOptions } from "./types";
import { resolveSupervisedRunArtifactDir } from "../events/supervised-runs";
import type {
  EventBinding,
  EventSupervisedRunRecord,
  EventSupervisedRunStatus,
  EventSupervisorCommand,
} from "../events/types";
import type { SupervisedRunCorrelationKey } from "../events/supervised-runs";
import { defaultSupervisorWorkflowName } from "../events/supervisor-correlation";

export type SupervisorEngineOverrides = {
  readonly mockScenario?: MockNodeScenario;
  readonly dryRun?: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
};

export interface SupervisedWorkflowView {
  readonly supervisedRun: EventSupervisedRunRecord;
  readonly activeTargetStatus?: WorkflowSessionState["status"];
}

export interface StartSupervisedWorkflowInput extends LoadOptions {
  readonly sourceId: string;
  readonly bindingId: string;
  readonly correlationKey: string;
  readonly targetWorkflowName: string;
  readonly idempotencyKey?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly bindingSnapshot: EventBinding;
  readonly mockScenario?: MockNodeScenario;
  readonly dryRun?: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
}

export interface StopSupervisedWorkflowInput extends LoadOptions {
  readonly supervisedRunId?: string;
  readonly sourceId?: string;
  readonly bindingId?: string;
  readonly correlationKey?: string;
  readonly idempotencyKey?: string;
  readonly reason?: string;
}

export interface RestartSupervisedWorkflowInput extends LoadOptions {
  readonly supervisedRunId?: string;
  readonly sourceId?: string;
  readonly bindingId?: string;
  readonly correlationKey?: string;
  readonly idempotencyKey?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly mockScenario?: MockNodeScenario;
  readonly dryRun?: boolean;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  readonly maxSteps?: number;
}

export interface SupervisedWorkflowLookup extends LoadOptions {
  readonly supervisedRunId?: string;
  readonly sourceId?: string;
  readonly bindingId?: string;
  readonly correlationKey?: string;
  readonly idempotencyKey?: string;
}

export interface SubmitSupervisedWorkflowInput extends LoadOptions {
  readonly supervisedRunId?: string;
  readonly sourceId?: string;
  readonly bindingId?: string;
  readonly correlationKey?: string;
  readonly targetWorkflowName?: string;
  readonly bindingSnapshot?: EventBinding;
  readonly idempotencyKey?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly mockScenario?: MockNodeScenario;
  readonly dryRun?: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
}

export interface WorkflowSupervisorClient {
  dispatchCommand(input: {
    readonly command: EventSupervisorCommand;
    readonly binding: EventBinding;
    readonly runtimeVariables: Readonly<Record<string, unknown>>;
    readonly engine?: SupervisorEngineOverrides;
  }): Promise<SupervisedWorkflowView>;
  start(input: StartSupervisedWorkflowInput): Promise<SupervisedWorkflowView>;
  stop(input: StopSupervisedWorkflowInput): Promise<SupervisedWorkflowView>;
  restart(
    input: RestartSupervisedWorkflowInput,
  ): Promise<SupervisedWorkflowView>;
  status(input: SupervisedWorkflowLookup): Promise<SupervisedWorkflowView>;
  submitInput(
    input: SubmitSupervisedWorkflowInput,
  ): Promise<SupervisedWorkflowView>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isTerminalTargetStatus(
  status: WorkflowSessionState["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function resolveAutoImproveEnabled(binding: EventBinding): boolean {
  const raw = binding.execution?.autoImprove;
  if (raw === undefined) {
    return false;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  return raw.enabled === true;
}

export function resolveMaxRestarts(binding: EventBinding): number {
  const n = binding.execution?.maxRestartsOnFailure;
  if (n === undefined || !Number.isFinite(n)) {
    return 3;
  }
  return Math.max(0, Math.floor(n));
}

export function resolveSupervisorWorkflowName(binding: EventBinding): string {
  const name = binding.execution?.supervisorWorkflowName;
  if (typeof name === "string" && name.length > 0) {
    return name;
  }
  return defaultSupervisorWorkflowName();
}

export function dedupeNodeIds(nodeIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of nodeIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function localEngineOverrides(
  input: SupervisorEngineOverrides | undefined,
): Pick<
  SupervisorEngineOverrides,
  | "mockScenario"
  | "dryRun"
  | "maxSteps"
  | "maxLoopIterations"
  | "defaultTimeoutMs"
> {
  if (input === undefined) {
    return {};
  }
  return {
    ...(input.mockScenario === undefined
      ? {}
      : { mockScenario: input.mockScenario }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: input.maxLoopIterations }),
    ...(input.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: input.defaultTimeoutMs }),
  };
}

export function mergeRuntimeVariables(
  base: Readonly<Record<string, unknown>>,
  overlay?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (overlay === undefined) {
    return base;
  }
  return { ...base, ...overlay };
}

export function resolvePublicCommandId(input: {
  readonly idempotencyKey: string | undefined;
  readonly prefix: string;
  readonly scope: string;
}): string {
  if (input.idempotencyKey !== undefined && input.idempotencyKey.length > 0) {
    return input.idempotencyKey;
  }
  return `${input.prefix}-${nowIso()}-${input.scope}`;
}

export function requireNonEmptyLookupValue(
  value: string | undefined,
  label: string,
): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export async function cancelTargetSession(
  sessionId: string,
  options: LoadOptions,
): Promise<void> {
  const loaded = await loadSession(sessionId, options);
  if (!loaded.ok) {
    return;
  }
  if (isTerminalTargetStatus(loaded.value.status)) {
    return;
  }
  const cancelled: WorkflowSessionState = {
    ...loaded.value,
    status: "cancelled",
    endedAt: nowIso(),
    lastError: "cancelled by event supervisor",
  };
  const saved = await saveSession(cancelled, options);
  if (!saved.ok) {
    throw new Error(saved.error.message);
  }
}

export async function resolveWorkflowOptionsForName(
  workflowName: string,
  loadOptions: LoadOptions,
): Promise<LoadOptions> {
  const loaded = await loadWorkflowFromCatalog(workflowName, loadOptions);
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  const src = loaded.value.source;
  return src === undefined
    ? loadOptions
    : withResolvedWorkflowSourceOptions(src, loadOptions);
}

export function eventBindingStubFromSupervisedRunRecord(
  record: EventSupervisedRunRecord,
): EventBinding {
  return {
    id: record.bindingId,
    sourceId: record.sourceId,
    workflowName: record.targetWorkflowName,
    inputMapping: { mode: "event-input" },
    execution: {
      mode: "supervised",
      supervisorWorkflowName: record.supervisorWorkflowName,
      maxRestartsOnFailure: record.maxRestartsOnFailure,
      autoImprove: record.autoImproveEnabled,
    },
  };
}

export function viewFrom(
  record: EventSupervisedRunRecord,
  activeTargetStatus?: WorkflowSessionState["status"],
): SupervisedWorkflowView {
  return {
    supervisedRun: record,
    ...(activeTargetStatus === undefined ? {} : { activeTargetStatus }),
  };
}

export async function activeTargetStatusFor(
  record: EventSupervisedRunRecord,
  options: LoadOptions,
): Promise<WorkflowSessionState["status"] | undefined> {
  const id = record.activeTargetExecutionId;
  if (id === undefined) {
    return undefined;
  }
  const loaded = await loadSession(id, options);
  if (!loaded.ok) {
    return undefined;
  }
  return loaded.value.status;
}

/**
 * When the supervised-run row is still in an active status but the linked
 * target session is already terminal, persist the terminal supervisor status
 * so the supervised-run record remains the lifecycle authority.
 */
export async function reconcileTerminalSupervisedRunRecord(
  record: EventSupervisedRunRecord,
  repo: {
    readonly save: (
      record: EventSupervisedRunRecord,
      artifactDir: string,
    ) => Promise<void>;
  },
  options: LoadOptions,
): Promise<EventSupervisedRunRecord> {
  const sessionId = record.activeTargetExecutionId;
  if (sessionId === undefined) {
    return record;
  }
  if (
    record.status !== "starting" &&
    record.status !== "running" &&
    record.status !== "stopping" &&
    record.status !== "restarting"
  ) {
    return record;
  }
  const loaded = await loadSession(sessionId, options);
  if (!loaded.ok) {
    return record;
  }
  const st = loaded.value.status;
  if (!isTerminalTargetStatus(st)) {
    return record;
  }
  let nextStatus: EventSupervisedRunStatus;
  if (st === "completed") {
    nextStatus = "completed";
  } else if (st === "failed") {
    nextStatus = "failed";
  } else {
    nextStatus = "stopped";
  }
  const { activeTargetExecutionId: _omit, ...persistable } = record;
  const updated: EventSupervisedRunRecord = {
    ...persistable,
    status: nextStatus,
    updatedAt: nowIso(),
  };
  const dir = resolveSupervisedRunArtifactDir(updated, options);
  await repo.save(updated, dir);
  return updated;
}

export async function reconcileTerminalSupervisedRunForCorrelation(
  correlation: SupervisedRunCorrelationKey,
  repo: {
    readonly findActiveByCorrelation: (
      input: SupervisedRunCorrelationKey,
    ) => Promise<EventSupervisedRunRecord | null>;
    readonly save: (
      record: EventSupervisedRunRecord,
      artifactDir: string,
    ) => Promise<void>;
  },
  options: LoadOptions,
): Promise<void> {
  const active = await repo.findActiveByCorrelation(correlation);
  if (active === null) {
    return;
  }
  await reconcileTerminalSupervisedRunRecord(active, repo, options);
}

export function assertSupervisedCommandBindingConsistency(input: {
  readonly command: EventSupervisorCommand;
  readonly binding: EventBinding;
}): void {
  if (input.binding.execution?.mode !== "supervised") {
    throw new Error(
      'supervisor command binding requires execution.mode "supervised"',
    );
  }
  if (input.command.sourceId !== input.binding.sourceId) {
    throw new Error(
      "supervisor command sourceId does not match binding.sourceId",
    );
  }
  if (input.command.bindingId !== input.binding.id) {
    throw new Error("supervisor command bindingId does not match binding.id");
  }
  if (input.command.targetWorkflowName !== input.binding.workflowName) {
    throw new Error(
      "supervisor command targetWorkflowName does not match binding.workflowName",
    );
  }
}
