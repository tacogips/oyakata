import {
  listEventReplyDispatchesFromRuntimeDb,
  listRuntimeHookEvents,
  listRuntimeNodeExecutions,
  listRuntimeNodeLogs,
} from "../workflow/runtime-db";
import {
  loadSession,
  listSessions as listStoredSessions,
  saveSession,
} from "../workflow/session-store";
import {
  normalizeSessionState,
  resolveCurrentStepId,
  resolveCurrentStepIdFromWorkflow,
  type WorkflowSessionState,
} from "../workflow/session";
import { loadWorkflowFromCatalog } from "../workflow/load";
import type { WorkflowExecutionSummary } from "../shared/ui-contract";
import type {
  CurrentStepWorkflowView,
  DivedraOptions,
  RuntimeSessionView,
} from "./types";

function toWorkflowExecutionSummary(
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

async function resolveSessionCurrentStepId(input: {
  readonly session: WorkflowSessionState;
  readonly options: DivedraOptions;
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
    pending = loadWorkflowFromCatalog(cacheKey, input.options).then((loaded) =>
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

export async function cancelWorkflowExecution(
  input: {
    readonly workflowExecutionId: string;
  } & DivedraOptions,
): Promise<{
  readonly accepted: boolean;
  readonly workflowExecutionId: string;
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
}> {
  const loaded = await loadSession(input.workflowExecutionId, input);
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
    endedAt: new Date().toISOString(),
    lastError: "cancelled via cancelWorkflowExecution",
  };
  const saved = await saveSession(cancelled, input);
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

export async function getSession(
  sessionId: string,
  options: DivedraOptions = {},
): Promise<WorkflowSessionState> {
  const loaded = await loadSession(sessionId, options);
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  return loaded.value;
}

export async function listSessions(options: DivedraOptions = {}) {
  const listed = await listStoredSessions(options);
  if (!listed.ok) {
    throw new Error(listed.error.message);
  }

  const workflowCache = new Map<
    string,
    Promise<CurrentStepWorkflowView | undefined>
  >();
  const loadedSessions = await Promise.all(
    listed.value.map(async (sessionId) => {
      const loaded = await loadSession(sessionId, options);
      if (!loaded.ok) {
        return undefined;
      }
      const currentStepId = await resolveSessionCurrentStepId({
        session: loaded.value,
        options,
        workflowCache,
      });
      return toWorkflowExecutionSummary(loaded.value, currentStepId);
    }),
  );

  return loadedSessions
    .filter((entry): entry is WorkflowExecutionSummary => entry !== undefined)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function getRuntimeSessionView(
  sessionId: string,
  options: DivedraOptions = {},
): Promise<RuntimeSessionView> {
  const session = await getSession(sessionId, options);
  const currentStepId = await resolveSessionCurrentStepId({
    session,
    options,
  });
  const [nodeExecutions, nodeLogs, hookEvents, replyDispatches] =
    await Promise.all([
      listRuntimeNodeExecutions(sessionId, options),
      listRuntimeNodeLogs(sessionId, options),
      listRuntimeHookEvents(sessionId, options),
      listEventReplyDispatchesFromRuntimeDb(
        { workflowExecutionId: sessionId },
        options,
      ),
    ]);
  return {
    session: {
      ...session,
      currentStepId,
    },
    nodeExecutions,
    nodeLogs,
    hookEvents,
    replyDispatches,
  };
}

export { normalizeSessionState };
