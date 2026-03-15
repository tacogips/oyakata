import { readFile } from "node:fs/promises";
import path from "node:path";
import { runWorkflow } from "../workflow/engine";
import { buildInspectionSummary } from "../workflow/inspect";
import { loadWorkflowFromDisk } from "../workflow/load";
import {
  createCommunicationService,
  type CommunicationLookupInput,
  type ReplayCommunicationInput as ServiceReplayCommunicationInput,
  type RetryCommunicationDeliveryInput as ServiceRetryCommunicationInput,
} from "../workflow/communication-service";
import {
  createManagerMessageService,
  type SendManagerMessageInput as ServiceSendManagerMessageInput,
} from "../workflow/manager-message-service";
import {
  createManagerSessionStore,
  resolveAmbientManagerExecutionContext,
  type ManagerSessionStore,
} from "../workflow/manager-session-store";
import { assertCommunicationInManagerScope } from "../workflow/manager-control";
import { type CommunicationRecord } from "../workflow/session";
import {
  listRuntimeNodeExecutions,
  listRuntimeNodeLogs,
} from "../workflow/runtime-db";
import { loadSession, saveSession } from "../workflow/session-store";
import type { WorkflowSessionState } from "../workflow/session";
import type {
  CommunicationConnection,
  ExecuteWorkflowInput,
  ExecuteWorkflowPayload,
  GraphqlManagerScope,
  GraphqlRequestContext,
  GraphqlSchema,
  GraphqlSchemaDependencies,
  ManagerSessionLookupInput,
  ManagerSessionView,
  NodeExecutionLookupInput,
  NodeExecutionView,
  ReplayCommunicationInput,
  ReplayCommunicationPayload,
  RetryCommunicationDeliveryInput,
  RetryCommunicationDeliveryPayload,
  RerunWorkflowExecutionInput,
  RerunWorkflowExecutionPayload,
  ResumeWorkflowExecutionInput,
  ResumeWorkflowExecutionPayload,
  SendManagerMessageInput,
  SendManagerMessagePayload,
  WorkflowExecutionLookupInput,
  WorkflowExecutionView,
  WorkflowLookupInput,
  WorkflowView,
  CommunicationsQueryInput,
  CancelWorkflowExecutionInput,
  CancelWorkflowExecutionPayload,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

async function readOptionalText(filePath: string): Promise<string | null> {
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

function resolveManagerStore(
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies,
): ManagerSessionStore {
  return deps.managerSessionStore ?? createManagerSessionStore(context);
}

function resolveCommunicationService(
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

function resolveManagerMessageService(
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

function resolveScopedManagerSessionId(
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

function resolveScopedAuthToken(context: GraphqlRequestContext): string | undefined {
  if (context.authToken !== undefined) {
    return context.authToken;
  }
  return resolveAmbientManagerExecutionContext(context.env)?.authToken;
}

async function authenticateManagerScope(
  input: ManagerSessionLookupInput,
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies,
): Promise<GraphqlManagerScope> {
  const managerSessionId = resolveScopedManagerSessionId(
    input.managerSessionId,
    context,
  );
  if (managerSessionId === undefined) {
    throw new Error("managerSessionId is required for manager-scoped GraphQL operations");
  }
  const authToken = resolveScopedAuthToken(context);
  if (authToken === undefined) {
    throw new Error("manager auth token is required for manager-scoped GraphQL operations");
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

function assertWorkflowExecutionScope(
  workflowId: string,
  workflowExecutionId: string,
  scope: GraphqlManagerScope,
): void {
  if (
    scope.session.workflowId !== workflowId ||
    scope.session.workflowExecutionId !== workflowExecutionId
  ) {
    throw new Error("manager session scope does not match the requested workflow execution");
  }
}

function assertManagerIdentity(
  input: Pick<SendManagerMessageInput, "managerNodeId" | "managerNodeExecId">,
  scope: GraphqlManagerScope,
): void {
  if (
    input.managerNodeId !== undefined &&
    input.managerNodeId !== scope.session.managerNodeId
  ) {
    throw new Error("managerNodeId does not match the authenticated manager session");
  }
  if (
    input.managerNodeExecId !== undefined &&
    input.managerNodeExecId !== scope.session.managerNodeExecId
  ) {
    throw new Error("managerNodeExecId does not match the authenticated manager session");
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

async function buildNodeExecutionView(
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
      execution.nodeId === input.nodeId && execution.nodeExecId === input.nodeExecId,
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
      execution.nodeId === input.nodeId && execution.nodeExecId === input.nodeExecId,
  );
  const runtimeLogs = await listRuntimeNodeLogs(input.workflowExecutionId, context);
  const matchingLogs = runtimeLogs.filter(
    (entry) => entry.nodeExecId === input.nodeExecId,
  );
  const logLimit = input.recentLogLimit ?? 20;
  const recentLogs =
    logLimit <= 0 ? [] : matchingLogs.slice(Math.max(matchingLogs.length - logLimit, 0));
  const artifactDir = runtimeExecution?.artifactDir ?? sessionRecord.artifactDir;

  return {
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    nodeId: sessionRecord.nodeId,
    nodeExecId: sessionRecord.nodeExecId,
    status: sessionRecord.status,
    startedAt: sessionRecord.startedAt,
    endedAt: sessionRecord.endedAt,
    ...(sessionRecord.attempt === undefined ? {} : { attempt: sessionRecord.attempt }),
    ...(sessionRecord.outputAttemptCount === undefined
      ? {}
      : { outputAttemptCount: sessionRecord.outputAttemptCount }),
    ...(sessionRecord.outputValidationErrors === undefined
      ? {}
      : { outputValidationErrors: sessionRecord.outputValidationErrors }),
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
    output: runtimeExecution?.outputJson ?? (await readOptionalText(path.join(artifactDir, "output.json"))),
    meta: await readOptionalText(path.join(artifactDir, "meta.json")),
    terminalMessage: findTerminalMessage(session, input.nodeExecId, matchingLogs),
    recentLogs,
  };
}

async function buildWorkflowExecutionView(
  input: WorkflowExecutionLookupInput,
  context: GraphqlRequestContext,
): Promise<WorkflowExecutionView | null> {
  const loaded = await loadSession(input.workflowExecutionId, context);
  if (!loaded.ok) {
    return null;
  }
  const nodeExecutions = await listRuntimeNodeExecutions(
    input.workflowExecutionId,
    context,
  );
  const nodeLogs = await listRuntimeNodeLogs(input.workflowExecutionId, context);
  return {
    workflowExecutionId: input.workflowExecutionId,
    session: loaded.value,
    nodeExecutions,
    nodeLogs,
  };
}

async function buildCommunicationConnection(
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
    if (input.fromNodeId !== undefined && communication.fromNodeId !== input.fromNodeId) {
      return false;
    }
    if (input.toNodeId !== undefined && communication.toNodeId !== input.toNodeId) {
      return false;
    }
    if (input.status !== undefined && communication.status !== input.status) {
      return false;
    }
    return true;
  });

  if (input.afterCommunicationId !== undefined) {
    const cursorIndex = records.findIndex(
      (communication) => communication.communicationId === input.afterCommunicationId,
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

async function loadScopedCommunicationForManagerMutation(
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
  const loadedWorkflow = await loadWorkflowFromDisk(
    loaded.value.workflowName,
    context,
  );
  if (!loadedWorkflow.ok) {
    throw new Error(loadedWorkflow.error.message);
  }
  const managerNodeRef = loadedWorkflow.value.bundle.workflow.nodes.find(
    (entry) => entry.id === scope.session.managerNodeId,
  );
  assertCommunicationInManagerScope(
    communication,
    loadedWorkflow.value.bundle.workflow,
    {
      managerNodeId: scope.session.managerNodeId,
      managerKind: managerNodeRef?.kind,
    },
    "GraphQL manager mutation",
  );
  return communication;
}

async function executeWorkflowMutation(
  input: ExecuteWorkflowInput,
  context: GraphqlRequestContext,
): Promise<ExecuteWorkflowPayload> {
  const result = await runWorkflow(input.workflowName, {
    ...context,
    ...(input.runtimeVariables === undefined
      ? {}
      : { runtimeVariables: input.runtimeVariables }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: input.maxLoopIterations }),
    ...(input.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: input.defaultTimeoutMs }),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    workflowExecutionId: result.value.session.sessionId,
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    exitCode: result.value.exitCode,
  };
}

async function resumeWorkflowExecutionMutation(
  input: ResumeWorkflowExecutionInput,
  context: GraphqlRequestContext,
): Promise<ResumeWorkflowExecutionPayload> {
  const existing = await loadSession(input.workflowExecutionId, context);
  if (!existing.ok) {
    throw new Error(existing.error.message);
  }
  const result = await runWorkflow(existing.value.workflowName, {
    ...context,
    resumeSessionId: input.workflowExecutionId,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    workflowExecutionId: result.value.session.sessionId,
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    exitCode: result.value.exitCode,
  };
}

async function rerunWorkflowExecutionMutation(
  input: RerunWorkflowExecutionInput,
  context: GraphqlRequestContext,
): Promise<RerunWorkflowExecutionPayload> {
  const existing = await loadSession(input.workflowExecutionId, context);
  if (!existing.ok) {
    throw new Error(existing.error.message);
  }
  const result = await runWorkflow(existing.value.workflowName, {
    ...context,
    rerunFromSessionId: input.workflowExecutionId,
    rerunFromNodeId: input.nodeId,
    ...(input.runtimeVariables === undefined
      ? {}
      : { runtimeVariables: input.runtimeVariables }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: input.maxLoopIterations }),
    ...(input.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: input.defaultTimeoutMs }),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return {
    workflowExecutionId: result.value.session.sessionId,
    sessionId: result.value.session.sessionId,
    status: result.value.session.status,
    exitCode: result.value.exitCode,
  };
}

async function cancelWorkflowExecutionMutation(
  input: CancelWorkflowExecutionInput,
  context: GraphqlRequestContext,
): Promise<CancelWorkflowExecutionPayload> {
  const loaded = await loadSession(input.workflowExecutionId, context);
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }

  if (
    loaded.value.status === "completed" ||
    loaded.value.status === "failed" ||
    loaded.value.status === "cancelled"
  ) {
    return {
      accepted: false,
      workflowExecutionId: loaded.value.sessionId,
      sessionId: loaded.value.sessionId,
      status: loaded.value.status,
    };
  }

  const cancelled: WorkflowSessionState = {
    ...loaded.value,
    status: "cancelled",
    endedAt: (nowIso)(),
    lastError: "cancelled by GraphQL mutation",
  };
  const saved = await saveSession(cancelled, context);
  if (!saved.ok) {
    throw new Error(saved.error.message);
  }
  return {
    accepted: true,
    workflowExecutionId: cancelled.sessionId,
    sessionId: cancelled.sessionId,
    status: cancelled.status,
  };
}

export function createGraphqlSchema(
  deps: GraphqlSchemaDependencies = {},
): GraphqlSchema {
  const managerLookupInput = (
    managerSessionId: string | undefined,
  ): ManagerSessionLookupInput =>
    managerSessionId === undefined ? {} : { managerSessionId };

  return {
    query: {
      async workflow(
        input: WorkflowLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowView | null> {
        const loaded = await loadWorkflowFromDisk(input.workflowName, context);
        if (!loaded.ok) {
          return null;
        }
        return buildInspectionSummary(loaded.value);
      },

      async workflowExecution(
        input: WorkflowExecutionLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowExecutionView | null> {
        return buildWorkflowExecutionView(input, context);
      },

      async communications(
        input: CommunicationsQueryInput,
        context: GraphqlRequestContext = {},
      ): Promise<CommunicationConnection> {
        return buildCommunicationConnection(input, context, deps);
      },

      async communication(
        input: CommunicationLookupInput,
        context: GraphqlRequestContext = {},
      ) {
        return resolveCommunicationService(context, deps).getCommunication(
          input,
          context,
        );
      },

      async nodeExecution(
        input: NodeExecutionLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<NodeExecutionView | null> {
        return buildNodeExecutionView(input, context);
      },

      async managerSession(
        input: ManagerSessionLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<ManagerSessionView | null> {
        const scope = await authenticateManagerScope(input, context, deps);
        const managerStore = resolveManagerStore(context, deps);
        const messages = await managerStore.listMessages(
          scope.session.managerSessionId,
        );
        return {
          session: scope.session,
          messages,
        };
      },
    },

    mutation: {
      async executeWorkflow(
        input: ExecuteWorkflowInput,
        context: GraphqlRequestContext = {},
      ): Promise<ExecuteWorkflowPayload> {
        return executeWorkflowMutation(input, context);
      },

      async resumeWorkflowExecution(
        input: ResumeWorkflowExecutionInput,
        context: GraphqlRequestContext = {},
      ): Promise<ResumeWorkflowExecutionPayload> {
        return resumeWorkflowExecutionMutation(input, context);
      },

      async rerunWorkflowExecution(
        input: RerunWorkflowExecutionInput,
        context: GraphqlRequestContext = {},
      ): Promise<RerunWorkflowExecutionPayload> {
        return rerunWorkflowExecutionMutation(input, context);
      },

      async sendManagerMessage(
        input: SendManagerMessageInput,
        context: GraphqlRequestContext = {},
      ): Promise<SendManagerMessagePayload> {
        const scope = await authenticateManagerScope(
          managerLookupInput(input.managerSessionId),
          context,
          deps,
        );
        assertWorkflowExecutionScope(
          input.workflowId,
          input.workflowExecutionId,
          scope,
        );
        assertManagerIdentity(input, scope);

        const payloadInput: ServiceSendManagerMessageInput = {
          workflowId: input.workflowId,
          workflowExecutionId: input.workflowExecutionId,
          managerSessionId: scope.session.managerSessionId,
          ...(input.message === undefined ? {} : { message: input.message }),
          ...(input.actions === undefined ? {} : { actions: input.actions }),
          ...(input.attachments === undefined
            ? {}
            : { attachments: input.attachments }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        };
        const result = await resolveManagerMessageService(
          context,
          deps,
        ).sendManagerMessage(payloadInput, context);
        return {
          workflowId: input.workflowId,
          workflowExecutionId: input.workflowExecutionId,
          managerSessionId: scope.session.managerSessionId,
          ...result,
        };
      },

      async retryCommunicationDelivery(
        input: RetryCommunicationDeliveryInput,
        context: GraphqlRequestContext = {},
      ): Promise<RetryCommunicationDeliveryPayload> {
        const scope = await authenticateManagerScope(
          managerLookupInput(input.managerSessionId),
          context,
          deps,
        );
        assertWorkflowExecutionScope(
          input.workflowId,
          input.workflowExecutionId,
          scope,
        );
        await loadScopedCommunicationForManagerMutation(
          input,
          scope,
          context,
        );

        const payloadInput: ServiceRetryCommunicationInput = {
          workflowId: input.workflowId,
          workflowExecutionId: input.workflowExecutionId,
          communicationId: input.communicationId,
          managerSessionId: scope.session.managerSessionId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        };
        return resolveCommunicationService(
          context,
          deps,
        ).retryCommunicationDelivery(payloadInput, context);
      },

      async replayCommunication(
        input: ReplayCommunicationInput,
        context: GraphqlRequestContext = {},
      ): Promise<ReplayCommunicationPayload> {
        const scope = await authenticateManagerScope(
          managerLookupInput(input.managerSessionId),
          context,
          deps,
        );
        assertWorkflowExecutionScope(
          input.workflowId,
          input.workflowExecutionId,
          scope,
        );
        await loadScopedCommunicationForManagerMutation(
          input,
          scope,
          context,
        );

        const payloadInput: ServiceReplayCommunicationInput = {
          workflowId: input.workflowId,
          workflowExecutionId: input.workflowExecutionId,
          communicationId: input.communicationId,
          managerSessionId: scope.session.managerSessionId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        };
        return resolveCommunicationService(
          context,
          deps,
        ).replayCommunication(payloadInput, context);
      },

      async cancelWorkflowExecution(
        input: CancelWorkflowExecutionInput,
        context: GraphqlRequestContext = {},
      ): Promise<CancelWorkflowExecutionPayload> {
        return cancelWorkflowExecutionMutation(input, context);
      },
    },
  };
}
