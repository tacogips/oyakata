import path from "node:path";
import {
  resolveCurrentStepId,
  resolveCurrentStepIdFromWorkflow,
  type CommunicationRecord,
  type WorkflowSessionState,
} from "../workflow/session";
import {
  listEventReplyDispatchesFromRuntimeDb,
  listRuntimeHookEvents,
  listRuntimeNodeExecutions,
  listRuntimeNodeLogs,
  type RuntimeNodeExecutionSummary,
  type RuntimeNodeLogEntry,
} from "../workflow/runtime-db";
import { listSessions, loadSession } from "../workflow/session-store";
import { loadWorkflowFromCatalog } from "../workflow/load";
import { assertCommunicationInManagerScope } from "../workflow/manager-control";
import { resolveAmbientManagerExecutionContext } from "../workflow/manager-session-store";
import type { WorkflowExecutionSummary } from "../shared/ui-contract";
import type { WorkflowJson } from "../workflow/types";
import {
  readOptionalText,
  resolveCommunicationService,
  nowIso,
  resolveManagerStore,
  resolveScopedManagerSessionId,
  resolveScopedAuthToken,
} from "./schema-helpers";
import { loadWorkflowDefinitionForGraphql } from "./schema-workflow-definitions";
import type {
  CommunicationConnection,
  CommunicationsQueryInput,
  GraphqlManagerScope,
  GraphqlRequestContext,
  GraphqlSchemaDependencies,
  ManagerSessionLookupInput,
  NodeExecutionLookupInput,
  NodeExecutionView,
  WorkflowExecutionConnection,
  WorkflowExecutionLookupInput,
  WorkflowExecutionOverviewLookupInput,
  WorkflowExecutionOverviewView,
  WorkflowExecutionView,
  WorkflowExecutionsQueryInput,
  WorkflowSessionView,
  SendManagerMessageInput,
} from "./types";

export async function authenticateManagerScope(
  input: ManagerSessionLookupInput,
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies,
): Promise<GraphqlManagerScope> {
  const managerSessionId = resolveScopedManagerSessionId(
    input.managerSessionId,
    context,
  );
  if (managerSessionId === undefined) {
    throw new Error(
      "managerSessionId is required for manager-scoped GraphQL operations",
    );
  }
  const authToken = resolveScopedAuthToken(context);
  if (authToken === undefined) {
    throw new Error(
      "manager auth token is required for manager-scoped GraphQL operations",
    );
  }

  const managerStore = resolveManagerStore(context, deps);
  const session = await managerStore.validateAuthToken({
    managerSessionId,
    authToken,
    now: (deps.now ?? nowIso)(),
  });
  if (session === null) {
    throw new Error(`invalid manager auth for session '${managerSessionId}'`);
  }

  return {
    context: resolveAmbientManagerExecutionContext(context.env),
    session,
  };
}

export function assertWorkflowExecutionScope(
  workflowId: string,
  workflowExecutionId: string,
  scope: GraphqlManagerScope,
): void {
  if (
    scope.session.workflowId !== workflowId ||
    scope.session.workflowExecutionId !== workflowExecutionId
  ) {
    throw new Error(
      "manager session scope does not match the requested workflow execution",
    );
  }
}

export function assertManagerIdentity(
  input: Pick<SendManagerMessageInput, "managerNodeExecId">,
  scope: GraphqlManagerScope,
): void {
  if (
    input.managerNodeExecId !== undefined &&
    input.managerNodeExecId !== scope.session.managerNodeExecId
  ) {
    throw new Error(
      "managerNodeExecId does not match the authenticated manager session",
    );
  }
}

function findTerminalMessage(
  session: WorkflowSessionState,
  nodeExecId: string,
  logs: readonly {
    readonly nodeExecId: string | null;
    readonly message: string;
  }[],
): string | null {
  const matchingLogs = logs.filter((entry) => entry.nodeExecId === nodeExecId);
  const lastLog = matchingLogs.at(-1);
  if (lastLog !== undefined) {
    return lastLog.message;
  }
  return session.lastError ?? null;
}

export async function buildNodeExecutionViewFromState(
  session: WorkflowSessionState,
  sessionRecord: WorkflowSessionState["nodeExecutions"][number],
  runtimeExecutions: readonly RuntimeNodeExecutionSummary[],
  runtimeLogs: readonly RuntimeNodeLogEntry[],
  recentLogLimit: number | undefined,
): Promise<NodeExecutionView> {
  const runtimeExecution = runtimeExecutions.find(
    (execution) =>
      execution.nodeId === sessionRecord.nodeId &&
      execution.nodeExecId === sessionRecord.nodeExecId,
  );
  const matchingLogs = runtimeLogs.filter(
    (entry) => entry.nodeExecId === sessionRecord.nodeExecId,
  );
  const logLimit = recentLogLimit ?? 20;
  const recentLogs =
    logLimit <= 0
      ? []
      : matchingLogs.slice(Math.max(matchingLogs.length - logLimit, 0));
  const artifactDir =
    runtimeExecution?.artifactDir ?? sessionRecord.artifactDir;

  return {
    workflowId: session.workflowId,
    workflowExecutionId: session.sessionId,
    nodeId: sessionRecord.nodeId,
    ...(sessionRecord.stepId === undefined
      ? {}
      : { stepId: sessionRecord.stepId }),
    ...(sessionRecord.nodeRegistryId === undefined
      ? {}
      : { nodeRegistryId: sessionRecord.nodeRegistryId }),
    nodeExecId: sessionRecord.nodeExecId,
    ...(sessionRecord.mailboxInstanceId === undefined
      ? {}
      : { mailboxInstanceId: sessionRecord.mailboxInstanceId }),
    status: sessionRecord.status,
    startedAt: sessionRecord.startedAt,
    endedAt: sessionRecord.endedAt,
    ...(sessionRecord.attempt === undefined
      ? {}
      : { attempt: sessionRecord.attempt }),
    ...(sessionRecord.outputAttemptCount === undefined
      ? {}
      : { outputAttemptCount: sessionRecord.outputAttemptCount }),
    ...(sessionRecord.outputValidationErrors === undefined
      ? {}
      : { outputValidationErrors: sessionRecord.outputValidationErrors }),
    ...(sessionRecord.promptVariant === undefined
      ? {}
      : { promptVariant: sessionRecord.promptVariant }),
    ...(sessionRecord.timeoutMs === undefined
      ? {}
      : { timeoutMs: sessionRecord.timeoutMs }),
    ...(sessionRecord.backendSessionId === undefined
      ? {}
      : { backendSessionId: sessionRecord.backendSessionId }),
    ...(sessionRecord.backendSessionMode === undefined
      ? {}
      : { backendSessionMode: sessionRecord.backendSessionMode }),
    ...(sessionRecord.restartedFromNodeExecId === undefined
      ? {}
      : { restartedFromNodeExecId: sessionRecord.restartedFromNodeExecId }),
    artifactDir,
    output:
      runtimeExecution?.outputJson ??
      (await readOptionalText(path.join(artifactDir, "output.json"))),
    meta: await readOptionalText(path.join(artifactDir, "meta.json")),
    terminalMessage: findTerminalMessage(
      session,
      sessionRecord.nodeExecId,
      matchingLogs,
    ),
    recentLogs,
  };
}

export async function buildNodeExecutionView(
  input: NodeExecutionLookupInput,
  context: GraphqlRequestContext,
): Promise<NodeExecutionView | null> {
  const loaded = await loadSession(input.workflowExecutionId, context);
  if (!loaded.ok || loaded.value.workflowId !== input.workflowId) {
    return null;
  }

  const session = loaded.value;
  const sessionRecord = session.nodeExecutions.find(
    (execution) =>
      execution.nodeId === input.nodeId &&
      execution.nodeExecId === input.nodeExecId,
  );
  if (sessionRecord === undefined) {
    return null;
  }

  const runtimeExecutions = await listRuntimeNodeExecutions(
    input.workflowExecutionId,
    context,
  );
  const runtimeExecution = runtimeExecutions.find(
    (execution) =>
      execution.nodeId === input.nodeId &&
      execution.nodeExecId === input.nodeExecId,
  );
  const runtimeLogs = await listRuntimeNodeLogs(
    input.workflowExecutionId,
    context,
  );

  return buildNodeExecutionViewFromState(
    session,
    sessionRecord,
    runtimeExecution === undefined ? [] : [runtimeExecution],
    runtimeLogs,
    input.recentLogLimit,
  );
}

export function toWorkflowExecutionSummary(
  session: WorkflowSessionState,
  currentStepId: string | null = resolveCurrentStepId(session),
): WorkflowExecutionSummary {
  return {
    workflowExecutionId: session.sessionId,
    sessionId: session.sessionId,
    workflowName: session.workflowName,
    status: session.status,
    currentNodeId: session.currentNodeId ?? null,
    ...(currentStepId === null ? {} : { currentStepId }),
    nodeExecutionCounter: session.nodeExecutionCounter,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
  };
}

interface CurrentStepWorkflowView {
  readonly workflowId: string;
  readonly steps?: WorkflowJson["steps"];
}

export async function resolveSessionCurrentStepId(input: {
  readonly session: WorkflowSessionState;
  readonly context: GraphqlRequestContext;
  readonly workflowCache?: Map<
    string,
    Promise<CurrentStepWorkflowView | undefined>
  >;
}): Promise<string | null> {
  const currentStepId = resolveCurrentStepId(input.session);
  if (currentStepId !== null) {
    return currentStepId;
  }

  const cache =
    input.workflowCache ??
    new Map<string, Promise<CurrentStepWorkflowView | undefined>>();
  const cacheKey = input.session.workflowName;
  const cached = cache.get(cacheKey);
  let pending: Promise<CurrentStepWorkflowView | undefined>;
  if (cached === undefined) {
    pending = loadWorkflowFromCatalog(cacheKey, input.context).then((loaded) =>
      loaded.ok
        ? {
            workflowId: loaded.value.bundle.workflow.workflowId,
            ...(loaded.value.bundle.workflow.steps === undefined
              ? {}
              : { steps: loaded.value.bundle.workflow.steps }),
          }
        : undefined,
    );
    cache.set(cacheKey, pending);
  } else {
    pending = cached;
  }
  const workflow = await pending;
  if (workflow?.workflowId !== input.session.workflowId) {
    return null;
  }

  return resolveCurrentStepIdFromWorkflow(
    input.session,
    workflow.steps === undefined ? undefined : { steps: workflow.steps },
  );
}

export async function toWorkflowSessionView(
  session: WorkflowSessionState,
  context: GraphqlRequestContext,
): Promise<WorkflowSessionView> {
  return {
    ...session,
    currentStepId: await resolveSessionCurrentStepId({ session, context }),
  };
}

export async function buildWorkflowExecutionConnection(
  input: WorkflowExecutionsQueryInput,
  context: GraphqlRequestContext,
): Promise<WorkflowExecutionConnection> {
  const listed = await listSessions(context);
  if (!listed.ok) {
    throw new Error(listed.error.message);
  }

  const workflowCache = new Map<
    string,
    Promise<CurrentStepWorkflowView | undefined>
  >();
  const loadedSessions = await Promise.all(
    listed.value.map(async (workflowExecutionId) => {
      const loaded = await loadSession(workflowExecutionId, context);
      if (!loaded.ok) {
        return undefined;
      }
      const currentStepId = await resolveSessionCurrentStepId({
        session: loaded.value,
        context,
        workflowCache,
      });
      return toWorkflowExecutionSummary(loaded.value, currentStepId);
    }),
  );

  const filtered = loadedSessions
    .filter((entry): entry is WorkflowExecutionSummary => entry !== undefined)
    .filter((entry) =>
      input.workflowName === undefined
        ? true
        : entry.workflowName === input.workflowName,
    )
    .filter((entry) =>
      input.status === undefined ? true : entry.status === input.status,
    );

  const startIndex =
    input.afterWorkflowExecutionId === undefined
      ? 0
      : Math.max(
          filtered.findIndex(
            (entry) =>
              entry.workflowExecutionId === input.afterWorkflowExecutionId,
          ) + 1,
          0,
        );
  const totalCount = filtered.length;
  const pageSize =
    input.first === undefined || input.first <= 0
      ? filtered.length
      : input.first;
  const items = filtered.slice(startIndex, startIndex + pageSize);
  const nextCursor =
    startIndex + pageSize < filtered.length && items.length > 0
      ? items[items.length - 1]?.workflowExecutionId
      : undefined;

  return {
    items,
    totalCount,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export async function buildWorkflowExecutionView(
  input: WorkflowExecutionLookupInput,
  context: GraphqlRequestContext,
): Promise<WorkflowExecutionView | null> {
  const loaded = await loadSession(input.workflowExecutionId, context);
  if (!loaded.ok) {
    return null;
  }
  const [nodeExecutions, nodeLogs, hookEvents, replyDispatches] =
    await Promise.all([
      listRuntimeNodeExecutions(input.workflowExecutionId, context),
      listRuntimeNodeLogs(input.workflowExecutionId, context),
      listRuntimeHookEvents(input.workflowExecutionId, context),
      listEventReplyDispatchesFromRuntimeDb(
        { workflowExecutionId: input.workflowExecutionId },
        context,
      ),
    ]);
  return {
    workflowExecutionId: input.workflowExecutionId,
    session: await toWorkflowSessionView(loaded.value, context),
    nodeExecutions,
    nodeLogs,
    hookEvents,
    replyDispatches,
  };
}

export async function buildWorkflowExecutionOverviewView(
  input: WorkflowExecutionOverviewLookupInput,
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies,
): Promise<WorkflowExecutionOverviewView | null> {
  const loaded = await loadSession(input.workflowExecutionId, context);
  if (!loaded.ok) {
    return null;
  }

  const session = loaded.value;
  const [runtimeExecutions, runtimeLogs, hookEvents, replyDispatches] =
    await Promise.all([
      listRuntimeNodeExecutions(input.workflowExecutionId, context),
      listRuntimeNodeLogs(input.workflowExecutionId, context),
      listRuntimeHookEvents(input.workflowExecutionId, context),
      listEventReplyDispatchesFromRuntimeDb(
        { workflowExecutionId: input.workflowExecutionId },
        context,
      ),
    ]);
  const nodes = await Promise.all(
    session.nodeExecutions.map((execution) =>
      buildNodeExecutionViewFromState(
        session,
        execution,
        runtimeExecutions,
        runtimeLogs,
        input.recentLogLimit,
      ),
    ),
  );

  const communications = await buildCommunicationConnection(
    {
      workflowId: session.workflowId,
      workflowExecutionId: input.workflowExecutionId,
      ...(input.firstCommunications === undefined
        ? {}
        : { first: input.firstCommunications }),
      ...(input.afterCommunicationId === undefined
        ? {}
        : { afterCommunicationId: input.afterCommunicationId }),
    },
    context,
    deps,
  );

  return {
    workflowExecutionId: input.workflowExecutionId,
    workflowId: session.workflowId,
    workflowName: session.workflowName,
    status: session.status,
    session: await toWorkflowSessionView(session, context),
    nodes,
    communications,
    nodeLogs: runtimeLogs,
    hookEvents,
    replyDispatches,
  };
}

export async function buildCommunicationConnection(
  input: CommunicationsQueryInput,
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies,
): Promise<CommunicationConnection> {
  const loaded = await loadSession(input.workflowExecutionId, context);
  if (!loaded.ok || loaded.value.workflowId !== input.workflowId) {
    return { items: [], totalCount: 0 };
  }

  let records = loaded.value.communications.filter((communication) => {
    if (communication.workflowId !== input.workflowId) {
      return false;
    }
    if (
      input.fromNodeId !== undefined &&
      communication.fromNodeId !== input.fromNodeId
    ) {
      return false;
    }
    if (
      input.toNodeId !== undefined &&
      communication.toNodeId !== input.toNodeId
    ) {
      return false;
    }
    if (input.status !== undefined && communication.status !== input.status) {
      return false;
    }
    return true;
  });

  if (input.afterCommunicationId !== undefined) {
    const cursorIndex = records.findIndex(
      (communication) =>
        communication.communicationId === input.afterCommunicationId,
    );
    if (cursorIndex >= 0) {
      records = records.slice(cursorIndex + 1);
    }
  }

  const first = input.first ?? 50;
  const selected = first <= 0 ? [] : records.slice(0, first);
  const service = resolveCommunicationService(context, deps);
  const items = (
    await Promise.all(
      selected.map((communication) =>
        service.getCommunication(
          {
            workflowId: input.workflowId,
            workflowExecutionId: input.workflowExecutionId,
            communicationId: communication.communicationId,
          },
          context,
        ),
      ),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const nextCursor =
    records.length > selected.length
      ? selected.at(-1)?.communicationId
      : undefined;
  return {
    items,
    totalCount: records.length,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export async function loadScopedCommunicationForManagerMutation(
  input: {
    readonly workflowId: string;
    readonly workflowExecutionId: string;
    readonly communicationId: string;
  },
  scope: GraphqlManagerScope,
  context: GraphqlRequestContext,
): Promise<CommunicationRecord> {
  const loaded = await loadSession(input.workflowExecutionId, context);
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  if (loaded.value.workflowId !== input.workflowId) {
    throw new Error(
      `workflow execution '${input.workflowExecutionId}' does not belong to workflow '${input.workflowId}'`,
    );
  }
  const communication = loaded.value.communications.find(
    (entry) => entry.communicationId === input.communicationId,
  );
  if (communication === undefined) {
    throw new Error(
      `communication '${input.communicationId}' was not found in workflow execution '${input.workflowExecutionId}'`,
    );
  }
  const loadedWorkflow = await loadWorkflowDefinitionForGraphql(
    loaded.value.workflowName,
    context,
  );
  if (loadedWorkflow === null) {
    throw new Error(`workflow '${loaded.value.workflowName}' was not found`);
  }
  assertCommunicationInManagerScope(
    communication,
    loadedWorkflow.bundle.workflow,
    {
      managerStepId: scope.session.managerStepId,
    },
    "GraphQL manager mutation",
  );
  return communication;
}
