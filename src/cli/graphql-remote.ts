import {
  executeGraphqlRequest,
  type GraphqlClientResponse,
} from "../graphql/client";
import {
  listRuntimeNodeExecutions,
  listRuntimeNodeLogs,
  listRuntimeHookEvents,
} from "../workflow/runtime-db";
import { createCommunicationService } from "../workflow/communication-service";
import { loadSession } from "../workflow/session-store";
import { normalizeWorkflowWorkingDirectoryOverride } from "../workflow/working-directory";
import type { WorkflowRunOptions } from "../workflow/engine";
import type { CallStepInput } from "../workflow/call-step";
import type {
  WorkflowOverviewRow,
  WorkflowStatusOverview,
} from "../workflow/overview";
import type { WorkflowExecutionCompactSummary } from "../shared/ui-contract";
import {
  isNonNull,
  isJsonObjectRecord,
  requireObjectField,
  requireStringField,
  requireNumberField,
  requireArrayField,
  assertWorkflowOverviewSourceScope,
} from "./helpers";
import type {
  CliDependencies,
  CliStorageOptions,
  GraphqlCliTransportOptions,
  ParsedOptions,
  RemoteWorkflowRunSummary,
  WorkflowExecutionContinuationMetadata,
  WorkflowExecutionExport,
} from "./types";

export function resolveCliEnv(
  deps: CliDependencies,
): Readonly<Record<string, string | undefined>> {
  return deps.env ?? process.env;
}

export function resolveGraphqlCliTransport(
  parsedOptions: ParsedOptions,
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDependencies,
): GraphqlCliTransportOptions | null {
  if (parsedOptions.endpoint === undefined) {
    return null;
  }
  const authTokenEnvName =
    parsedOptions.authTokenEnv ?? "DIVEDRA_MANAGER_AUTH_TOKEN";
  const authToken =
    parsedOptions.authToken ?? env[authTokenEnvName] ?? undefined;
  const ambientManagerSessionId = env["DIVEDRA_MANAGER_SESSION_ID"];
  const managerSessionId =
    typeof ambientManagerSessionId === "string" &&
    ambientManagerSessionId.length > 0
      ? ambientManagerSessionId
      : undefined;
  return {
    endpoint: parsedOptions.endpoint,
    ...(authToken === undefined ? {} : { authToken }),
    ...(managerSessionId === undefined ? {} : { managerSessionId }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };
}

function readGraphqlExecutionPayload(
  response: GraphqlClientResponse,
): Readonly<Record<string, unknown>> {
  if (response.errors !== undefined && response.errors.length > 0) {
    throw new Error(response.errors.map((entry) => entry.message).join("; "));
  }
  if (!isJsonObjectRecord(response.data)) {
    throw new Error("GraphQL response data must be a JSON object");
  }
  return response.data;
}

export async function executeCliGraphqlOperation(args: {
  readonly transport: GraphqlCliTransportOptions;
  readonly document: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}): Promise<Readonly<Record<string, unknown>>> {
  const response = await executeGraphqlRequest({
    endpoint: args.transport.endpoint,
    document: args.document,
    ...(args.variables === undefined ? {} : { variables: args.variables }),
    ...(args.transport.authToken === undefined
      ? {}
      : { authToken: args.transport.authToken }),
    ...(args.transport.managerSessionId === undefined
      ? {}
      : { managerSessionId: args.transport.managerSessionId }),
    ...(args.transport.fetchImpl === undefined
      ? {}
      : { fetchImpl: args.transport.fetchImpl }),
  });
  return readGraphqlExecutionPayload(response);
}

export function buildRemoteExecutionInput(
  parsedOptions: ParsedOptions,
): Readonly<Record<string, unknown>> {
  const workingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    parsedOptions.workingDirectory,
  );
  return {
    ...(parsedOptions.autoImprove === undefined
      ? {}
      : { autoImprove: parsedOptions.autoImprove }),
    ...(parsedOptions.nestedSuperviser ? { nestedSuperviser: true } : {}),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(parsedOptions.dryRun ? { dryRun: true } : {}),
    ...(parsedOptions.maxSteps === undefined
      ? {}
      : { maxSteps: parsedOptions.maxSteps }),
    ...(parsedOptions.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: parsedOptions.maxLoopIterations }),
    ...(parsedOptions.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: parsedOptions.defaultTimeoutMs }),
  };
}

export async function fetchRemoteWorkflowRunSummary(
  transport: GraphqlCliTransportOptions,
  workflowExecutionId: string,
): Promise<RemoteWorkflowRunSummary> {
  const data = await executeCliGraphqlOperation({
    transport,
    document: `
      query WorkflowExecutionSummary($workflowExecutionId: String!) {
        workflowExecution(workflowExecutionId: $workflowExecutionId) {
          session {
            sessionId
            workflowName
            workflowId
            transitions {
              when
            }
          }
          nodeExecutions {
            nodeExecId
          }
        }
      }
    `,
    variables: {
      workflowExecutionId,
    },
  });
  const workflowExecution = requireObjectField(
    data["workflowExecution"],
    "workflowExecution",
  );
  const session = requireObjectField(
    workflowExecution["session"],
    "workflowExecution.session",
  );
  return {
    workflowName: requireStringField(
      session["workflowName"],
      "workflowExecution.session.workflowName",
    ),
    workflowId: requireStringField(
      session["workflowId"],
      "workflowExecution.session.workflowId",
    ),
    nodeExecutions: requireArrayField(
      workflowExecution["nodeExecutions"],
      "workflowExecution.nodeExecutions",
    ).length,
    transitions: requireArrayField(
      session["transitions"],
      "workflowExecution.session.transitions",
    ).length,
  };
}

export function rejectUnsupportedRemoteMockScenario(
  parsedOptions: ParsedOptions,
  io: { readonly stderr: (line: string) => void },
): boolean {
  if (parsedOptions.mockScenarioPath === undefined) {
    return false;
  }
  io.stderr(
    "--mock-scenario is only supported for local execution; omit --endpoint to use it",
  );
  return true;
}

export function buildLocalWorkflowRunOverrides(
  parsedOptions: ParsedOptions,
): Pick<
  WorkflowRunOptions,
  | "autoImprove"
  | "nestedSuperviserDriver"
  | "defaultTimeoutMs"
  | "dryRun"
  | "maxLoopIterations"
  | "maxSteps"
  | "workflowWorkingDirectory"
> {
  const workflowWorkingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    parsedOptions.workingDirectory,
  );
  return {
    ...(workflowWorkingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory }),
    ...(parsedOptions.maxSteps === undefined
      ? {}
      : { maxSteps: parsedOptions.maxSteps }),
    ...(parsedOptions.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: parsedOptions.maxLoopIterations }),
    ...(parsedOptions.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: parsedOptions.defaultTimeoutMs }),
    ...(parsedOptions.dryRun ? { dryRun: true } : {}),
    ...(parsedOptions.autoImprove === undefined
      ? {}
      : { autoImprove: parsedOptions.autoImprove }),
    ...(parsedOptions.nestedSuperviser ? { nestedSuperviserDriver: true } : {}),
  };
}

export function buildLocalCallStepOverrides(
  parsedOptions: ParsedOptions,
): Pick<
  CallStepInput,
  "defaultTimeoutMs" | "dryRun" | "workflowWorkingDirectory" | "overrides"
> {
  const workflowWorkingDirectory = normalizeWorkflowWorkingDirectoryOverride(
    parsedOptions.workingDirectory,
  );
  const overrides =
    parsedOptions.timeoutMs === undefined &&
    parsedOptions.promptVariant === undefined &&
    !parsedOptions.continueSession &&
    parsedOptions.resumeStepExecId === undefined
      ? undefined
      : {
          ...(parsedOptions.timeoutMs === undefined
            ? {}
            : { timeoutMs: parsedOptions.timeoutMs }),
          ...(parsedOptions.promptVariant === undefined
            ? {}
            : { promptVariant: parsedOptions.promptVariant }),
          ...(parsedOptions.continueSession
            ? { sessionMode: "reuse" as const }
            : {}),
          ...(parsedOptions.resumeStepExecId === undefined
            ? {}
            : { resumeStepExecId: parsedOptions.resumeStepExecId }),
        };
  return {
    ...(workflowWorkingDirectory === undefined
      ? {}
      : { workflowWorkingDirectory }),
    ...(parsedOptions.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: parsedOptions.defaultTimeoutMs }),
    ...(parsedOptions.dryRun ? { dryRun: true } : {}),
    ...(overrides === undefined ? {} : { overrides }),
  };
}

export function buildWorkflowExecutionContinuationMetadata(
  session: import("../workflow/session").WorkflowSessionState,
): WorkflowExecutionContinuationMetadata | undefined {
  if (
    session.continuedFromWorkflowExecutionId === undefined &&
    session.continuedAfterStepRunId === undefined &&
    session.continuedAfterExecutionOrdinal === undefined &&
    session.continuedStartStepId === undefined &&
    session.continuationMode === undefined &&
    (session.historyImports === undefined ||
      session.historyImports.length === 0)
  ) {
    return undefined;
  }
  return {
    ...(session.continuedFromWorkflowExecutionId === undefined
      ? {}
      : {
          continuedFromWorkflowExecutionId:
            session.continuedFromWorkflowExecutionId,
        }),
    ...(session.continuedAfterStepRunId === undefined
      ? {}
      : { continuedAfterStepRunId: session.continuedAfterStepRunId }),
    ...(session.continuedAfterExecutionOrdinal === undefined
      ? {}
      : {
          continuedAfterExecutionOrdinal:
            session.continuedAfterExecutionOrdinal,
        }),
    ...(session.continuedStartStepId === undefined
      ? {}
      : { continuedStartStepId: session.continuedStartStepId }),
    ...(session.continuationMode === undefined
      ? {}
      : { continuationMode: session.continuationMode }),
    ...(session.historyImports === undefined
      ? {}
      : { historyImports: session.historyImports }),
  };
}

export async function buildWorkflowExecutionExport(
  workflowExecutionId: string,
  options: CliStorageOptions,
): Promise<WorkflowExecutionExport> {
  const loaded = await loadSession(workflowExecutionId, options);
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  const workflowId = loaded.value.workflowId;
  const continuationMetadata = buildWorkflowExecutionContinuationMetadata(
    loaded.value,
  );

  const [nodeExecutions, nodeLogs, hookEvents] = await Promise.all([
    listRuntimeNodeExecutions(workflowExecutionId, options),
    listRuntimeNodeLogs(workflowExecutionId, options),
    listRuntimeHookEvents(workflowExecutionId, options),
  ]);

  const communicationService = createCommunicationService();
  const communications = (
    await Promise.all(
      loaded.value.communications
        .filter((communication) => communication.workflowId === workflowId)
        .map((communication) =>
          communicationService.getCommunication(
            {
              workflowId,
              workflowExecutionId,
              communicationId: communication.communicationId,
            },
            options,
          ),
        ),
    )
  ).filter(isNonNull);

  return {
    workflowId,
    workflowExecutionId,
    workflowName: loaded.value.workflowName,
    status: loaded.value.status,
    exportedAt: new Date().toISOString(),
    ...(continuationMetadata === undefined ? {} : { continuationMetadata }),
    session: loaded.value,
    nodeExecutions,
    nodeLogs,
    hookEvents,
    communications,
  };
}

export const WORKFLOW_CATALOG_OVERVIEW_GQL = `
  query WorkflowCatalogOverviewCli($workflowScope: String, $status: String, $limit: Int) {
    workflowCatalogOverview(workflowScope: $workflowScope, status: $status, limit: $limit) {
      workflows {
        workflowName
        sourceScope
        workflowDirectory
        description
        aggregateStatus
        activeExecutionCount
        latestExecution {
          workflowExecutionId
          sessionId
          workflowName
          status
          currentNodeId
          currentStepId
          nodeExecutionCounter
          startedAt
          endedAt
        }
      }
    }
  }
`;

export const WORKFLOW_STATUS_OVERVIEW_GQL = `
  query WorkflowStatusOverviewCli($workflowName: String!, $workflowScope: String, $limit: Int) {
    workflowStatusOverview(workflowName: $workflowName, workflowScope: $workflowScope, limit: $limit) {
      workflowName
      sourceScope
      workflowDirectory
      description
      aggregateStatus
      activeExecutionCount
      latestExecution {
        workflowExecutionId
        sessionId
        workflowName
        status
        currentNodeId
        currentStepId
        nodeExecutionCounter
        startedAt
        endedAt
      }
      recentExecutions {
        workflowExecutionId
        sessionId
        workflowName
        status
        currentNodeId
        currentStepId
        nodeExecutionCounter
        startedAt
        endedAt
      }
      newestActiveExecution {
        workflowExecutionId
        sessionId
        workflowName
        status
        currentNodeId
        currentStepId
        nodeExecutionCounter
        startedAt
        endedAt
      }
    }
  }
`;

export function workflowExecutionCompactSummaryFromGraphql(
  value: unknown,
  label: string,
): WorkflowExecutionCompactSummary {
  const o = requireObjectField(value, label);
  const currentStepIdRaw = o["currentStepId"];
  return {
    workflowExecutionId: requireStringField(
      o["workflowExecutionId"],
      `${label}.workflowExecutionId`,
    ),
    sessionId: requireStringField(o["sessionId"], `${label}.sessionId`),
    workflowName: requireStringField(
      o["workflowName"],
      `${label}.workflowName`,
    ),
    status: requireStringField(
      o["status"],
      `${label}.status`,
    ) as WorkflowExecutionCompactSummary["status"],
    currentNodeId:
      o["currentNodeId"] === null || o["currentNodeId"] === undefined
        ? null
        : requireStringField(o["currentNodeId"], `${label}.currentNodeId`),
    ...(currentStepIdRaw === null || currentStepIdRaw === undefined
      ? {}
      : {
          currentStepId: requireStringField(
            currentStepIdRaw,
            `${label}.currentStepId`,
          ),
        }),
    nodeExecutionCounter: requireNumberField(
      o["nodeExecutionCounter"],
      `${label}.nodeExecutionCounter`,
    ),
    startedAt: requireStringField(o["startedAt"], `${label}.startedAt`),
    endedAt:
      o["endedAt"] === null || o["endedAt"] === undefined
        ? null
        : requireStringField(o["endedAt"], `${label}.endedAt`),
  };
}

export function workflowOverviewRowFromGraphqlJson(
  value: unknown,
  label: string,
): WorkflowOverviewRow {
  const row = requireObjectField(value, label);
  const latestRaw = row["latestExecution"];
  return {
    workflowName: requireStringField(
      row["workflowName"],
      `${label}.workflowName`,
    ),
    sourceScope: assertWorkflowOverviewSourceScope(
      requireStringField(row["sourceScope"], `${label}.sourceScope`),
    ),
    workflowDirectory: requireStringField(
      row["workflowDirectory"],
      `${label}.workflowDirectory`,
    ),
    description: requireStringField(row["description"], `${label}.description`),
    aggregateStatus: requireStringField(
      row["aggregateStatus"],
      `${label}.aggregateStatus`,
    ) as WorkflowOverviewRow["aggregateStatus"],
    activeExecutionCount: requireNumberField(
      row["activeExecutionCount"],
      `${label}.activeExecutionCount`,
    ),
    latestExecution:
      latestRaw === null || latestRaw === undefined
        ? null
        : workflowExecutionCompactSummaryFromGraphql(
            latestRaw,
            `${label}.latestExecution`,
          ),
  };
}

export function workflowStatusOverviewFromGraphqlJson(
  value: unknown,
  label: string,
): WorkflowStatusOverview {
  const base = workflowOverviewRowFromGraphqlJson(value, label);
  const row = requireObjectField(value, label);
  const recentRaw = requireArrayField(
    row["recentExecutions"],
    `${label}.recentExecutions`,
  );
  const recentExecutions = recentRaw.map((entry, index) =>
    workflowExecutionCompactSummaryFromGraphql(
      entry,
      `${label}.recentExecutions[${String(index)}]`,
    ),
  );
  const newestRaw = row["newestActiveExecution"];
  const newestActiveExecution =
    newestRaw === null || newestRaw === undefined
      ? null
      : workflowExecutionCompactSummaryFromGraphql(
          newestRaw,
          `${label}.newestActiveExecution`,
        );
  return {
    ...base,
    recentExecutions,
    newestActiveExecution,
  };
}

export function renderWorkflowOverviewTableLines(
  rows: readonly WorkflowOverviewRow[],
): string[] {
  const lines: string[] = [
    [
      "name",
      "scope",
      "workflowDirectory",
      "aggregateStatus",
      "active",
      "latestExecutionId",
      "latestStatus",
      "latestStartedAt",
    ].join("\t"),
  ];
  for (const row of rows) {
    const latest = row.latestExecution;
    lines.push(
      [
        row.workflowName,
        row.sourceScope,
        row.workflowDirectory,
        row.aggregateStatus,
        String(row.activeExecutionCount),
        latest?.workflowExecutionId ?? "-",
        latest?.status ?? "-",
        latest?.startedAt ?? "-",
      ].join("\t"),
    );
  }
  return lines;
}

export function renderWorkflowStatusOverviewLines(
  overview: WorkflowStatusOverview,
): string[] {
  const lines: string[] = [
    `workflowName: ${overview.workflowName}`,
    `sourceScope: ${overview.sourceScope}`,
    `workflowDirectory: ${overview.workflowDirectory}`,
    `description: ${overview.description}`,
    `aggregateStatus: ${overview.aggregateStatus}`,
    `activeExecutionCount: ${String(overview.activeExecutionCount)}`,
  ];
  const latest = overview.latestExecution;
  if (latest === null) {
    lines.push("latestExecution: -");
  } else {
    lines.push(
      `latestExecution: ${latest.workflowExecutionId} ${latest.status} startedAt=${latest.startedAt} endedAt=${latest.endedAt ?? "-"}`,
    );
  }
  const active = overview.newestActiveExecution;
  if (active === null) {
    lines.push("newestActiveExecution: -");
  } else {
    const stepLabel =
      active.currentStepId !== undefined && active.currentStepId !== null
        ? active.currentStepId
        : (active.currentNodeId ?? "-");
    lines.push(
      `newestActiveExecution: ${active.workflowExecutionId} ${active.status} currentStepOrNode=${stepLabel}`,
    );
  }
  lines.push("recentExecutions:");
  if (overview.recentExecutions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of overview.recentExecutions) {
      const step =
        e.currentStepId !== undefined && e.currentStepId !== null
          ? ` step=${e.currentStepId}`
          : "";
      lines.push(
        `  - ${e.workflowExecutionId} ${e.status} ${e.startedAt}${step}`,
      );
    }
  }
  return lines;
}

export function workflowOverviewGraphqlVariables(
  parsed: ParsedOptions,
  statusFilter: string | undefined,
): Readonly<Record<string, unknown>> {
  const variables: Record<string, unknown> = {};
  if (parsed.workflowScope !== undefined) {
    variables["workflowScope"] = parsed.workflowScope;
  }
  if (statusFilter !== undefined) {
    variables["status"] = statusFilter;
  }
  if (parsed.limit !== undefined) {
    variables["limit"] = parsed.limit;
  }
  return variables;
}
