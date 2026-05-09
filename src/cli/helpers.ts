import type { LoadedWorkflow } from "../workflow/load";
import { withResolvedWorkflowSourceOptions } from "../workflow/catalog";
import {
  resolveCurrentStepId,
  resolveCurrentStepIdFromWorkflow,
  type WorkflowSessionState,
} from "../workflow/session";
import { loadWorkflowFromCatalog } from "../workflow/load";
import type {
  ResolvedWorkflowSource,
  WorkflowSourceScope,
} from "../workflow/types";
import { HOOK_VENDOR_USAGE } from "./arg-parser";
import type {
  CliIo,
  CliStorageOptions,
  RuntimeNodeLogEntry,
  WorkflowSourceOutput,
} from "./types";

export function buildStepProgressSummaries(
  session: WorkflowSessionState,
): readonly {
  readonly stepId: string;
  readonly executions: number;
  readonly restarts: number;
}[] {
  const executionCounts = new Map<string, number>();
  for (const execution of session.nodeExecutions) {
    if (execution.stepId === undefined) {
      continue;
    }
    executionCounts.set(
      execution.stepId,
      (executionCounts.get(execution.stepId) ?? 0) + 1,
    );
  }

  return [...executionCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stepId, executions]) => ({
      stepId,
      executions,
      restarts: session.restartCounts?.[stepId] ?? 0,
    }));
}

export async function resolveSessionCurrentStepId(
  session: WorkflowSessionState,
  options: CliStorageOptions,
): Promise<string | null> {
  const currentStepId = resolveCurrentStepId(session);
  if (currentStepId !== null) {
    return currentStepId;
  }

  const loadedWorkflow = await loadWorkflowFromCatalog(
    session.workflowName,
    options,
  );
  if (!loadedWorkflow.ok) {
    return null;
  }
  if (loadedWorkflow.value.bundle.workflow.workflowId !== session.workflowId) {
    return null;
  }

  return resolveCurrentStepIdFromWorkflow(
    session,
    loadedWorkflow.value.bundle.workflow,
  );
}

export function printHelp(io: CliIo): void {
  io.stdout("Usage:");
  io.stdout(
    "  divedra cli workflow <create|validate|inspect|list|status|run> <name?> [options]",
  );
  io.stdout(
    "  divedra session <status|progress|resume|continue|rerun|export|logs|step-runs> <workflow-execution-id> [positional-args] [options]",
  );
  io.stdout(
    "  divedra session rerun <workflow-execution-id> <step-id> [options]",
  );
  io.stdout(
    "  divedra session continue <workflow-execution-id> --start-step <step-id> --after-step-run <step-run-id> [options]",
  );
  io.stdout(
    "  divedra session step-runs <workflow-execution-id> [--step <step-id>] [--status <status>] [options]",
  );
  io.stdout(
    "  divedra serve [workflow-name] [--host <host>] [--port <port>] [--read-only] [--no-exec]",
  );
  io.stdout(
    "  divedra gql <graphql-document> [--variables <json|@file>] [--endpoint <url>] [--auth-token <token>]",
  );
  io.stdout(
    "  divedra events <validate|serve|emit|list|replay|replies> [source-id|receipt-id|workflow-execution-id] [--event-root <path>] [--event-file <path>]",
  );
  io.stdout(
    "  divedra call-step <workflow-id> <workflow-run-id> <step-id> [--message-json <json> | --message-file <path>] [--prompt-variant <name>] [--continue-session] [--timeout-ms <ms>] [--resume-step-exec <id>] [options]",
  );
  io.stdout(`  divedra hook [--vendor ${HOOK_VENDOR_USAGE}]`);
  io.stdout(`  divedra hook snippet --vendor ${HOOK_VENDOR_USAGE}`);
  io.stdout("");
  io.stdout("Create options:");
  io.stdout("  --worker-only  Scaffold a manager-less starter workflow");
  io.stdout("");
  io.stdout("Workflow scope options:");
  io.stdout(
    "  --workflow-root <path>  Use a direct workflow root and bypass scoped lookup",
  );
  io.stdout("  --scope <scope>         Select auto, project, or user scope");
  io.stdout("  --user-root <path>      Override the user scope root");
  io.stdout("  --project-root <path>   Override the project scope root");
  io.stdout("  --addon-root <path>     Use a direct add-on root override");
  io.stdout("");
  io.stdout("Workflow overview (list / status):");
  io.stdout(
    "  --status <aggregate>    Filter workflow list by aggregate status",
  );
  io.stdout(
    "  --limit <n>             Cap list rows or recent executions on workflow status",
  );
  io.stdout(
    "Default --output text matches the compact table for list/status (--output table is equivalent;",
  );
  io.stdout(
    "  use --output json here for payloads). Elsewhere --output stays text vs json.",
  );
  io.stdout("");
  io.stdout("Session options:");
  io.stdout(
    "  continue vs rerun        continue references a concrete prior step-run (after-step-run); rerun restarts using variables only without importing prior step artifacts",
  );
  io.stdout(
    "  step-runs --step/--status Narrow merged timeline rows (status is a node execution terminal: succeeded | failed | timed_out | cancelled | skipped)",
  );
  io.stdout(
    "  export --file <path>     Write workflow run export JSON to a file",
  );
  io.stdout(
    "  logs --format <format>   Print node logs as text, json, or jsonl",
  );
  io.stdout("  --default-timeout-ms <ms>  Override workflow default timeout");
  io.stdout("  --timeout-ms <ms>          call-step only");
  io.stdout("  --prompt-variant <name>    call-step only");
  io.stdout("  --continue-session         call-step only");
  io.stdout(
    "  --resume-step-exec <id>    call-step only (execution record id; same as nodeExecId in session state)",
  );
  io.stdout("");
  io.stdout(
    "Auto-improve (supervision policy; engine retries on terminal failure until success or budgets;",
  );
  io.stdout(
    "  persisted stall watch is active; use --nested-supervisor (alias: --nested-superviser) to run the superviser bundle as a workflow):",
  );
  io.stdout(
    "  --auto-improve               Enable supervised runs with durable supervision state",
  );
  io.stdout(
    "  --supervisor-workflow <id> Superviser bundle id (alias: --superviser-workflow; persisted; divedra/* control + optional nested driver)",
  );
  io.stdout(
    "  --nested-supervisor         Run the superviser workflow as a nested session (alias: --nested-superviser; requires --auto-improve)",
  );
  io.stdout(
    "  --monitor-interval-ms <n>    Observation cadence (default 5000)",
  );
  io.stdout(
    "  --stall-timeout-ms <n>       Stall threshold (default 60000; must be >= monitor interval)",
  );
  io.stdout("  --max-supervised-attempts <n> Attempt budget (default 5)");
  io.stdout("  --max-workflow-patches <n>   Patch budget (default 3)");
  io.stdout(
    "  --workflow-mutation-mode execution-copy|in-place  (default execution-copy)",
  );
  io.stdout(
    "  --no-allow-targeted-rerun    Disable targeted step reruns (by default they are allowed).",
  );
  io.stdout(
    "                               Deprecated alias: --disable-targeted-rerun",
  );
}

export function formatValidationIssues(
  issues: readonly {
    severity: "error" | "warning";
    path: string;
    message: string;
  }[],
): string {
  return issues
    .map((entry) => `[${entry.severity}] ${entry.path}: ${entry.message}`)
    .join("\n");
}

export function emitJson(io: CliIo, payload: unknown): void {
  io.stdout(JSON.stringify(payload, null, 2));
}

export function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

export function formatRuntimeNodeLogLine(entry: RuntimeNodeLogEntry): string {
  return [
    entry.at,
    entry.level,
    entry.nodeId ?? "-",
    entry.nodeExecId ?? "-",
    entry.message,
  ].join("\t");
}

export function serializeRuntimeNodeLogs(
  entries: readonly RuntimeNodeLogEntry[],
  format: "text" | "json" | "jsonl",
): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(entries, null, 2)}\n`;
    case "jsonl":
      return entries.length === 0
        ? ""
        : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    case "text":
      return entries.length === 0
        ? ""
        : `${entries.map(formatRuntimeNodeLogLine).join("\n")}\n`;
  }
}

export function isJsonObjectRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObjectField(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isJsonObjectRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

export function requireStringField(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

export function requireNumberField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

export function requireArrayField(
  value: unknown,
  label: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

export function optionsForLoadedWorkflow<T extends CliStorageOptions>(
  loadedWorkflow: LoadedWorkflow,
  options: T,
): T {
  return loadedWorkflow.source === undefined
    ? options
    : withResolvedWorkflowSourceOptions(loadedWorkflow.source, options);
}

export function formatWorkflowSource(
  source: ResolvedWorkflowSource | undefined,
): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  return `${source.scope} ${source.workflowDirectory}`;
}

export function workflowSourceJson(
  source: ResolvedWorkflowSource | undefined,
): WorkflowSourceOutput | undefined {
  if (source === undefined) {
    return undefined;
  }
  return {
    scope: source.scope,
    workflowRoot: source.workflowRoot,
    workflowDirectory: source.workflowDirectory,
    ...(source.scopeRoot === undefined ? {} : { scopeRoot: source.scopeRoot }),
  };
}

export function formatAddonSource(source: {
  readonly nodeId: string;
  readonly name: string;
  readonly version: string;
  readonly scope: string;
  readonly manifestPath: string;
}): string {
  return `${source.nodeId}: ${source.name}@${source.version} ${source.scope} ${source.manifestPath}`;
}

export function assertWorkflowOverviewSourceScope(
  value: string,
): WorkflowSourceScope {
  if (value === "direct" || value === "project" || value === "user") {
    return value;
  }
  throw new Error(`invalid workflow overview sourceScope '${value}'`);
}
