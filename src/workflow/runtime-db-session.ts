import type { Database } from "bun:sqlite";
import { withDatabase } from "./runtime-db-core";
import type {
  RuntimeNodeExecutionSummary,
  RuntimeNodeLogEntry,
  RuntimeSessionSummary,
} from "./runtime-db-core";
import type {
  CommunicationRecord,
  NodeExecutionRecord,
  SessionStatus,
  WorkflowSessionState,
} from "./session";
import { resolveCurrentStepId } from "./session";
import type { AdapterProcessLog } from "./adapter";
import type { LoadOptions } from "./types";

type RuntimeNodeLogLevel = "info" | "warning" | "error";
const PROCESS_LOG_MESSAGE_TEXT_LIMIT = 500;

interface RuntimeNodeExecutionRow {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly stepId?: string;
  readonly nodeRegistryId?: string;
  readonly nodeExecId: string;
  readonly mailboxInstanceId?: string;
  readonly status: NodeExecutionRecord["status"];
  readonly artifactDir: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly attempt?: number;
  readonly outputAttemptCount?: number;
  readonly outputValidationErrors?: NodeExecutionRecord["outputValidationErrors"];
  readonly promptVariant?: string;
  readonly timeoutMs?: number;
  readonly backendSessionMode?: NodeExecutionRecord["backendSessionMode"];
  readonly backendSessionId?: NodeExecutionRecord["backendSessionId"];
  readonly restartedFromNodeExecId?: string;
  readonly executionOrdinal: number;
  readonly inputJson: string;
  readonly outputJson: string;
  readonly inputHash: string;
  readonly outputHash: string;
}

interface RuntimeNodeLogInput {
  readonly sessionId: string;
  readonly nodeExecId?: string;
  readonly nodeId?: string;
  readonly level: RuntimeNodeLogLevel;
  readonly message: string;
  readonly payload?: unknown;
  readonly at?: string;
}

interface PersistedRuntimeNodeLogRow {
  readonly sessionId: string;
  readonly nodeExecId: string | null;
  readonly nodeId: string | null;
  readonly level: RuntimeNodeLogLevel;
  readonly message: string;
  readonly payloadJson: string | null;
  readonly at: string;
}

interface RuntimeSessionRow {
  readonly session_id: string;
  readonly workflow_name: string;
  readonly workflow_id: string;
  readonly status: SessionStatus;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly current_node_id: string | null;
  readonly current_step_id: string | null;
  readonly node_execution_counter: number;
  readonly last_error: string | null;
  readonly updated_at: string;
}

function insertNodeLog(db: Database, row: PersistedRuntimeNodeLogRow): void {
  const stmt = db.prepare(`
    INSERT INTO node_logs (session_id, node_exec_id, node_id, level, message, payload_json, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    row.sessionId,
    row.nodeExecId,
    row.nodeId,
    row.level,
    row.message,
    row.payloadJson,
    row.at,
  );
}

function toNodeLogRow(row: RuntimeNodeLogInput): PersistedRuntimeNodeLogRow {
  return {
    sessionId: row.sessionId,
    nodeExecId: row.nodeExecId ?? null,
    nodeId: row.nodeId ?? null,
    level: row.level,
    message: row.message,
    payloadJson: row.payload === undefined ? null : JSON.stringify(row.payload),
    at: row.at ?? new Date().toISOString(),
  };
}

function toRuntimeSessionSummary(
  row: RuntimeSessionRow,
): RuntimeSessionSummary {
  return {
    sessionId: row.session_id,
    workflowName: row.workflow_name,
    workflowId: row.workflow_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    currentNodeId: row.current_node_id,
    ...(row.current_step_id === null
      ? {}
      : { currentStepId: row.current_step_id }),
    nodeExecutionCounter: row.node_execution_counter,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function summarizeProcessLogText(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= PROCESS_LOG_MESSAGE_TEXT_LIMIT) {
    return trimmed;
  }
  const omittedCount = trimmed.length - PROCESS_LOG_MESSAGE_TEXT_LIMIT;
  return `${trimmed.slice(
    0,
    PROCESS_LOG_MESSAGE_TEXT_LIMIT,
  )}... [truncated ${String(omittedCount)} chars]`;
}

function formatProcessLogMessage(input: {
  readonly nodeId: string;
  readonly log: AdapterProcessLog;
  readonly executionLogTarget?: "node" | "step";
}): string {
  const target = input.executionLogTarget ?? "node";
  const label =
    input.log.label === undefined || input.log.label.length === 0
      ? ""
      : `${input.log.label} `;
  return `${target} ${input.nodeId} ${label}${input.log.stream}: ${summarizeProcessLogText(input.log.text)}`;
}

function formatCommunicationEventMessage(
  communication: CommunicationRecord,
): string {
  return [
    `transition ${communication.fromNodeId} -> ${communication.toNodeId}`,
    `when ${communication.transitionWhen}`,
    `communication ${communication.communicationId}`,
    `status ${communication.status}`,
    `as ${communication.deliveryKind}`,
  ].join(" ");
}

export async function saveSessionSnapshotToRuntimeDb(
  session: WorkflowSessionState,
  options: LoadOptions = {},
): Promise<void> {
  await withDatabase(options, (db) => {
    const stmt = db.prepare(`
      INSERT INTO sessions (
        session_id, workflow_name, workflow_id, status, started_at, ended_at,
        current_node_id, current_step_id, node_execution_counter, queue_json, last_error,
        supervision_json,
        continuation_mode, continued_from_workflow_execution_id,
        continued_after_step_run_id, continued_after_execution_ordinal,
        continued_start_step_id, history_imports_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workflow_name=excluded.workflow_name,
        workflow_id=excluded.workflow_id,
        status=excluded.status,
        started_at=excluded.started_at,
        ended_at=excluded.ended_at,
        current_node_id=excluded.current_node_id,
        current_step_id=excluded.current_step_id,
        node_execution_counter=excluded.node_execution_counter,
        queue_json=excluded.queue_json,
        last_error=excluded.last_error,
        supervision_json=excluded.supervision_json,
        continuation_mode=excluded.continuation_mode,
        continued_from_workflow_execution_id=excluded.continued_from_workflow_execution_id,
        continued_after_step_run_id=excluded.continued_after_step_run_id,
        continued_after_execution_ordinal=excluded.continued_after_execution_ordinal,
        continued_start_step_id=excluded.continued_start_step_id,
        history_imports_json=excluded.history_imports_json,
        updated_at=excluded.updated_at
    `);
    const updatedAt = new Date().toISOString();
    const currentStepId = resolveCurrentStepId(session);
    stmt.run(
      session.sessionId,
      session.workflowName,
      session.workflowId,
      session.status,
      session.startedAt,
      session.endedAt ?? null,
      session.currentNodeId ?? null,
      currentStepId,
      session.nodeExecutionCounter,
      JSON.stringify(session.queue),
      session.lastError ?? null,
      session.supervision === undefined
        ? null
        : JSON.stringify(session.supervision),
      session.continuationMode ?? null,
      session.continuedFromWorkflowExecutionId ?? null,
      session.continuedAfterStepRunId ?? null,
      session.continuedAfterExecutionOrdinal ?? null,
      session.continuedStartStepId ?? null,
      session.historyImports === undefined
        ? null
        : JSON.stringify(session.historyImports),
      updatedAt,
    );
  });
}

export async function saveNodeExecutionToRuntimeDb(
  row: RuntimeNodeExecutionRow,
  options: LoadOptions = {},
): Promise<void> {
  await withDatabase(options, (db) => {
    const now = new Date().toISOString();
    const nodeStmt = db.prepare(`
      INSERT OR REPLACE INTO node_executions (
        session_id, node_exec_id, node_id, step_id, node_registry_id, mailbox_instance_id, status, artifact_dir, started_at, ended_at,
        attempt, output_attempt_count, output_validation_errors_json, prompt_variant, timeout_ms, backend_session_mode, backend_session_id,
        restarted_from_node_exec_id, execution_ordinal,
        input_hash, output_hash, input_json, output_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    nodeStmt.run(
      row.sessionId,
      row.nodeExecId,
      row.nodeId,
      row.stepId ?? null,
      row.nodeRegistryId ?? null,
      row.mailboxInstanceId ?? null,
      row.status,
      row.artifactDir,
      row.startedAt,
      row.endedAt,
      row.attempt ?? null,
      row.outputAttemptCount ?? null,
      row.outputValidationErrors === undefined
        ? null
        : JSON.stringify(row.outputValidationErrors),
      row.promptVariant ?? null,
      row.timeoutMs ?? null,
      row.backendSessionMode ?? null,
      row.backendSessionId ?? null,
      row.restartedFromNodeExecId ?? null,
      row.executionOrdinal,
      row.inputHash,
      row.outputHash,
      row.inputJson,
      row.outputJson,
      now,
    );

    const finishStepId = row.stepId;
    const finishLogTarget =
      finishStepId != null && finishStepId !== "" ? "step" : "node";
    const finishKey = finishLogTarget === "step" ? finishStepId : row.nodeId;
    insertNodeLog(
      db,
      toNodeLogRow({
        sessionId: row.sessionId,
        nodeExecId: row.nodeExecId,
        nodeId: row.nodeId,
        level: row.status === "succeeded" ? "info" : "warning",
        message: `${finishLogTarget} ${finishKey} finished with status ${row.status}`,
        payload: {
          inputHash: row.inputHash,
          outputHash: row.outputHash,
          artifactDir: row.artifactDir,
        },
        at: row.endedAt,
      }),
    );
  });
}

export async function saveProcessLogsToRuntimeDb(
  input: {
    readonly sessionId: string;
    readonly nodeId: string;
    readonly nodeExecId: string;
    readonly processLogs: readonly AdapterProcessLog[];
    readonly at: string;
    /** When set to `step`, log lines use `step …` instead of `node …` for the execution key. */
    readonly executionLogTarget?: "node" | "step";
  },
  options: LoadOptions = {},
): Promise<void> {
  if (input.processLogs.length === 0) {
    return;
  }
  await withDatabase(options, (db) => {
    const insertLogs = db.transaction((logs: readonly AdapterProcessLog[]) => {
      for (const log of logs) {
        insertNodeLog(
          db,
          toNodeLogRow({
            sessionId: input.sessionId,
            nodeId: input.nodeId,
            nodeExecId: input.nodeExecId,
            level: log.stream === "stderr" ? "warning" : "info",
            message: formatProcessLogMessage({
              nodeId: input.nodeId,
              log,
              ...(input.executionLogTarget === undefined
                ? {}
                : { executionLogTarget: input.executionLogTarget }),
            }),
            payload: {
              stream: log.stream,
              text: log.text,
              ...(log.label === undefined ? {} : { label: log.label }),
            },
            at: input.at,
          }),
        );
      }
    });
    insertLogs(input.processLogs);
  });
}

export async function saveCommunicationEventToRuntimeDb(
  communication: CommunicationRecord,
  options: LoadOptions = {},
): Promise<void> {
  await withDatabase(options, (db) => {
    insertNodeLog(
      db,
      toNodeLogRow({
        sessionId: communication.workflowExecutionId,
        nodeId: communication.fromNodeId,
        nodeExecId: communication.sourceNodeExecId,
        level: communication.status === "delivery_failed" ? "warning" : "info",
        message: formatCommunicationEventMessage(communication),
        payload: {
          eventType: "communication",
          workflowId: communication.workflowId,
          workflowExecutionId: communication.workflowExecutionId,
          communicationId: communication.communicationId,
          fromNodeId: communication.fromNodeId,
          toNodeId: communication.toNodeId,
          routingScope: communication.routingScope,
          deliveryKind: communication.deliveryKind,
          transitionWhen: communication.transitionWhen,
          sourceNodeExecId: communication.sourceNodeExecId,
          status: communication.status,
          artifactDir: communication.artifactDir,
          createdAt: communication.createdAt,
          ...(communication.deliveredAt === undefined
            ? {}
            : { deliveredAt: communication.deliveredAt }),
        },
        at: communication.deliveredAt ?? communication.createdAt,
      }),
    );
  });
}

export async function listRuntimeSessions(
  options: LoadOptions = {},
): Promise<readonly RuntimeSessionSummary[]> {
  return withDatabase(options, (db) => {
    const rows = db
      .query(
        `SELECT
          session_id,
          workflow_name,
          workflow_id,
          status,
          started_at,
          ended_at,
          current_node_id,
          current_step_id,
          node_execution_counter,
          last_error,
          updated_at
         FROM sessions
         ORDER BY updated_at DESC`,
      )
      .all() as RuntimeSessionRow[];

    return rows.map(toRuntimeSessionSummary);
  });
}

export async function loadRuntimeSessionSummary(
  sessionId: string,
  options: LoadOptions = {},
): Promise<RuntimeSessionSummary | null> {
  return withDatabase(options, (db) => {
    const row = db
      .query(
        `SELECT
          session_id,
          workflow_name,
          workflow_id,
          status,
          started_at,
          ended_at,
          current_node_id,
          current_step_id,
          node_execution_counter,
          last_error,
          updated_at
         FROM sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as RuntimeSessionRow | null;

    return row === null ? null : toRuntimeSessionSummary(row);
  });
}

export async function listRuntimeNodeExecutions(
  sessionId: string,
  options: LoadOptions = {},
): Promise<readonly RuntimeNodeExecutionSummary[]> {
  return withDatabase(options, (db) => {
    const rows = db
      .query(
        `         SELECT
           session_id,
           node_exec_id,
           node_id,
           step_id,
           node_registry_id,
           mailbox_instance_id,
           status,
           artifact_dir,
           started_at,
           ended_at,
           attempt,
           output_attempt_count,
           output_validation_errors_json,
           prompt_variant,
           timeout_ms,
           backend_session_mode,
           backend_session_id,
           restarted_from_node_exec_id,
           execution_ordinal,
           input_hash,
           output_hash,
           input_json,
           output_json,
           created_at
          FROM node_executions
         WHERE session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as Array<{
      session_id: string;
      node_exec_id: string;
      node_id: string;
      step_id: string | null;
      node_registry_id: string | null;
      mailbox_instance_id: string | null;
      status: string;
      artifact_dir: string;
      started_at: string;
      ended_at: string;
      attempt: number | null;
      output_attempt_count: number | null;
      output_validation_errors_json: string | null;
      prompt_variant: string | null;
      timeout_ms: number | null;
      backend_session_mode: NodeExecutionRecord["backendSessionMode"] | null;
      backend_session_id: NodeExecutionRecord["backendSessionId"] | null;
      restarted_from_node_exec_id: string | null;
      execution_ordinal: number | null;
      input_hash: string;
      output_hash: string;
      input_json: string;
      output_json: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      sessionId: row.session_id,
      nodeExecId: row.node_exec_id,
      nodeId: row.node_id,
      stepId: row.step_id,
      nodeRegistryId: row.node_registry_id,
      mailboxInstanceId: row.mailbox_instance_id,
      status: row.status,
      artifactDir: row.artifact_dir,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      attempt: row.attempt,
      outputAttemptCount: row.output_attempt_count,
      outputValidationErrors:
        row.output_validation_errors_json === null
          ? null
          : (JSON.parse(
              row.output_validation_errors_json,
            ) as NodeExecutionRecord["outputValidationErrors"]),
      promptVariant: row.prompt_variant,
      timeoutMs: row.timeout_ms,
      backendSessionMode: row.backend_session_mode,
      backendSessionId: row.backend_session_id,
      restartedFromNodeExecId: row.restarted_from_node_exec_id,
      executionOrdinal: row.execution_ordinal,
      inputHash: row.input_hash,
      outputHash: row.output_hash,
      inputJson: row.input_json,
      outputJson: row.output_json,
      createdAt: row.created_at,
    }));
  });
}

export async function listRuntimeNodeLogs(
  sessionId: string,
  options: LoadOptions = {},
): Promise<readonly RuntimeNodeLogEntry[]> {
  return withDatabase(options, (db) => {
    const rows = db
      .query(
        `SELECT
          id,
          session_id,
          node_exec_id,
          node_id,
          level,
          message,
          payload_json,
          at
         FROM node_logs
         WHERE session_id = ?
         ORDER BY id ASC`,
      )
      .all(sessionId) as Array<{
      id: number;
      session_id: string;
      node_exec_id: string | null;
      node_id: string | null;
      level: string;
      message: string;
      payload_json: string | null;
      at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      nodeExecId: row.node_exec_id,
      nodeId: row.node_id,
      level: row.level,
      message: row.message,
      payloadJson: row.payload_json,
      at: row.at,
    }));
  });
}

export async function deleteRuntimeSession(
  sessionId: string,
  options: LoadOptions = {},
): Promise<void> {
  await withDatabase(options, (db) => {
    const runDelete = db.transaction((targetSessionId: string) => {
      db.prepare("DELETE FROM node_logs WHERE session_id = ?").run(
        targetSessionId,
      );
      db.prepare("DELETE FROM node_executions WHERE session_id = ?").run(
        targetSessionId,
      );
      db.prepare("DELETE FROM sessions WHERE session_id = ?").run(
        targetSessionId,
      );
    });
    runDelete(sessionId);
  });
}
