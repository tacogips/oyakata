import { withDatabase } from "./runtime-db-core";
import type {
  RuntimeEventReceiptIndexRecord,
  RuntimeEventReceiptSaveInput,
  RuntimeEventReplyDispatchRecord,
  RuntimeEventReplyDispatchSaveInput,
  RuntimeEventReplyDispatchStatus,
  RuntimeHookEventRecord,
  RuntimeHookEventSaveInput,
} from "./runtime-db-core";
import type { LoadOptions } from "./types";

function toRuntimeEventReceiptIndexRecord(row: {
  readonly receipt_id: string;
  readonly source_id: string;
  readonly binding_id: string | null;
  readonly dedupe_key: string;
  readonly status: string;
  readonly workflow_name: string | null;
  readonly workflow_execution_id: string | null;
  readonly supervised_run_id?: string | null;
  readonly supervisor_execution_id?: string | null;
  readonly supervisor_conversation_id?: string | null;
  readonly supervisor_decision_id?: string | null;
  readonly artifact_dir: string;
  readonly error: string | null;
  readonly received_at: string;
  readonly updated_at: string;
}): RuntimeEventReceiptIndexRecord {
  return {
    receiptId: row.receipt_id,
    sourceId: row.source_id,
    bindingId: row.binding_id,
    dedupeKey: row.dedupe_key,
    status: row.status,
    workflowName: row.workflow_name,
    workflowExecutionId: row.workflow_execution_id,
    supervisedRunId: row.supervised_run_id ?? null,
    supervisorExecutionId: row.supervisor_execution_id ?? null,
    supervisorConversationId: row.supervisor_conversation_id ?? null,
    supervisorDecisionId: row.supervisor_decision_id ?? null,
    artifactDir: row.artifact_dir,
    error: row.error,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

function toRuntimeEventReplyDispatchRecord(row: {
  readonly idempotency_key: string;
  readonly source_id: string;
  readonly provider: string;
  readonly workflow_id: string;
  readonly workflow_execution_id: string;
  readonly node_id: string;
  readonly node_exec_id: string;
  readonly event_id: string;
  readonly conversation_id: string;
  readonly thread_id: string | null;
  readonly actor_id: string | null;
  readonly status: RuntimeEventReplyDispatchStatus;
  readonly dispatch_id: string | null;
  readonly provider_message_id: string | null;
  readonly request_json: string;
  readonly response_json: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}): RuntimeEventReplyDispatchRecord {
  return {
    idempotencyKey: row.idempotency_key,
    sourceId: row.source_id,
    provider: row.provider,
    workflowId: row.workflow_id,
    workflowExecutionId: row.workflow_execution_id,
    nodeId: row.node_id,
    nodeExecId: row.node_exec_id,
    eventId: row.event_id,
    conversationId: row.conversation_id,
    threadId: row.thread_id,
    actorId: row.actor_id,
    status: row.status,
    dispatchId: row.dispatch_id,
    providerMessageId: row.provider_message_id,
    requestJson: row.request_json,
    responseJson: row.response_json,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRuntimeHookEventRecord(row: {
  readonly hook_event_id: string;
  readonly workflow_id: string;
  readonly workflow_execution_id: string;
  readonly node_id: string;
  readonly node_exec_id: string;
  readonly manager_session_id: string | null;
  readonly vendor: string;
  readonly agent_session_id: string;
  readonly raw_event_name: string;
  readonly event_name: string;
  readonly cwd: string;
  readonly transcript_path: string | null;
  readonly model: string | null;
  readonly turn_id: string | null;
  readonly payload_hash: string;
  readonly payload_ref_json: string | null;
  readonly response_json: string | null;
  readonly status: string;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}): RuntimeHookEventRecord {
  return {
    hookEventId: row.hook_event_id,
    workflowId: row.workflow_id,
    workflowExecutionId: row.workflow_execution_id,
    nodeId: row.node_id,
    nodeExecId: row.node_exec_id,
    managerSessionId: row.manager_session_id,
    vendor: row.vendor,
    agentSessionId: row.agent_session_id,
    rawEventName: row.raw_event_name,
    eventName: row.event_name,
    cwd: row.cwd,
    transcriptPath: row.transcript_path,
    model: row.model,
    turnId: row.turn_id,
    payloadHash: row.payload_hash,
    payloadRefJson: row.payload_ref_json,
    responseJson: row.response_json,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveHookEventToRuntimeDb(
  row: RuntimeHookEventSaveInput,
  options: LoadOptions = {},
): Promise<void> {
  await withDatabase(options, (db) => {
    const stmt = db.prepare(`
      INSERT INTO hook_events (
        hook_event_id, workflow_id, workflow_execution_id, node_id,
        node_exec_id, manager_session_id, vendor, agent_session_id,
        raw_event_name, event_name, cwd, transcript_path, model, turn_id,
        payload_hash, payload_ref_json, response_json, status, error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hook_event_id) DO UPDATE SET
        workflow_id=excluded.workflow_id,
        workflow_execution_id=excluded.workflow_execution_id,
        node_id=excluded.node_id,
        node_exec_id=excluded.node_exec_id,
        manager_session_id=excluded.manager_session_id,
        vendor=excluded.vendor,
        agent_session_id=excluded.agent_session_id,
        raw_event_name=excluded.raw_event_name,
        event_name=excluded.event_name,
        cwd=excluded.cwd,
        transcript_path=excluded.transcript_path,
        model=excluded.model,
        turn_id=excluded.turn_id,
        payload_hash=excluded.payload_hash,
        payload_ref_json=excluded.payload_ref_json,
        response_json=excluded.response_json,
        status=excluded.status,
        error=excluded.error,
        updated_at=excluded.updated_at
    `);
    stmt.run(
      row.hookEventId,
      row.workflowId,
      row.workflowExecutionId,
      row.nodeId,
      row.nodeExecId,
      row.managerSessionId ?? null,
      row.vendor,
      row.agentSessionId,
      row.rawEventName,
      row.eventName,
      row.cwd,
      row.transcriptPath ?? null,
      row.model ?? null,
      row.turnId ?? null,
      row.payloadHash,
      row.payloadRefJson ?? null,
      row.responseJson ?? null,
      row.status,
      row.error ?? null,
      row.createdAt,
      row.updatedAt,
    );
  });
}

export async function listRuntimeHookEvents(
  workflowExecutionId: string,
  options: LoadOptions = {},
): Promise<readonly RuntimeHookEventRecord[]> {
  return withDatabase(options, (db) => {
    const rows = db
      .query(
        `SELECT
          hook_event_id, workflow_id, workflow_execution_id, node_id,
          node_exec_id, manager_session_id, vendor, agent_session_id,
          raw_event_name, event_name, cwd, transcript_path, model, turn_id,
          payload_hash, payload_ref_json, response_json, status, error,
          created_at, updated_at
         FROM hook_events
         WHERE workflow_execution_id = ?
         ORDER BY created_at ASC`,
      )
      .all(workflowExecutionId) as Parameters<
      typeof toRuntimeHookEventRecord
    >[0][];
    return rows.map(toRuntimeHookEventRecord);
  });
}

export async function saveEventReceiptToRuntimeDb(
  row: RuntimeEventReceiptSaveInput,
  options: LoadOptions = {},
): Promise<void> {
  await withDatabase(options, (db) => {
    const stmt = db.prepare(`
      INSERT INTO event_receipts (
        receipt_id, source_id, binding_id, dedupe_key, status, workflow_name,
        workflow_execution_id, supervised_run_id, supervisor_execution_id,
        supervisor_conversation_id, supervisor_decision_id,
        artifact_dir, error, received_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(receipt_id) DO UPDATE SET
        source_id=excluded.source_id,
        binding_id=excluded.binding_id,
        dedupe_key=excluded.dedupe_key,
        status=excluded.status,
        workflow_name=excluded.workflow_name,
        workflow_execution_id=excluded.workflow_execution_id,
        supervised_run_id=excluded.supervised_run_id,
        supervisor_execution_id=excluded.supervisor_execution_id,
        supervisor_conversation_id=excluded.supervisor_conversation_id,
        supervisor_decision_id=excluded.supervisor_decision_id,
        artifact_dir=excluded.artifact_dir,
        error=excluded.error,
        received_at=excluded.received_at,
        updated_at=excluded.updated_at
    `);
    stmt.run(
      row.receiptId,
      row.sourceId,
      row.bindingId ?? null,
      row.dedupeKey,
      row.status,
      row.workflowName ?? null,
      row.workflowExecutionId ?? null,
      row.supervisedRunId ?? null,
      row.supervisorExecutionId ?? null,
      row.supervisorConversationId ?? null,
      row.supervisorDecisionId ?? null,
      row.artifactDir,
      row.error ?? null,
      row.receivedAt,
      row.updatedAt,
    );
  });
}

export async function findEventReceiptByDedupeKey(
  input: {
    readonly sourceId: string;
    readonly bindingId?: string;
    readonly dedupeKey: string;
    readonly since?: string;
  },
  options: LoadOptions = {},
): Promise<RuntimeEventReceiptIndexRecord | null> {
  return withDatabase(options, (db) => {
    const row = db
      .query(
        `SELECT
          receipt_id, source_id, binding_id, dedupe_key, status, workflow_name,
          workflow_execution_id, supervised_run_id, supervisor_execution_id,
          supervisor_conversation_id, supervisor_decision_id,
          artifact_dir, error, received_at, updated_at
         FROM event_receipts
         WHERE source_id = ?
           AND binding_id IS ?
           AND dedupe_key = ?
           AND (? IS NULL OR received_at >= ?)
         ORDER BY received_at DESC
         LIMIT 1`,
      )
      .get(
        input.sourceId,
        input.bindingId ?? null,
        input.dedupeKey,
        input.since ?? null,
        input.since ?? null,
      ) as Parameters<typeof toRuntimeEventReceiptIndexRecord>[0] | null;
    return row === null ? null : toRuntimeEventReceiptIndexRecord(row);
  });
}

export async function loadEventReceiptFromRuntimeDb(
  receiptId: string,
  options: LoadOptions = {},
): Promise<RuntimeEventReceiptIndexRecord | null> {
  return withDatabase(options, (db) => {
    const row = db
      .query(
        `SELECT
          receipt_id, source_id, binding_id, dedupe_key, status, workflow_name,
          workflow_execution_id, supervised_run_id, supervisor_execution_id,
          supervisor_conversation_id, supervisor_decision_id,
          artifact_dir, error, received_at, updated_at
         FROM event_receipts
         WHERE receipt_id = ?
         LIMIT 1`,
      )
      .get(receiptId) as
      | Parameters<typeof toRuntimeEventReceiptIndexRecord>[0]
      | null;
    return row === null ? null : toRuntimeEventReceiptIndexRecord(row);
  });
}

export async function listEventReceiptsFromRuntimeDb(
  input: {
    readonly sourceId?: string;
    readonly status?: string;
    readonly limit?: number;
  } = {},
  options: LoadOptions = {},
): Promise<readonly RuntimeEventReceiptIndexRecord[]> {
  return withDatabase(options, (db) => {
    const rows = db
      .query(
        `SELECT
          receipt_id, source_id, binding_id, dedupe_key, status, workflow_name,
          workflow_execution_id, supervised_run_id, supervisor_execution_id,
          supervisor_conversation_id, supervisor_decision_id,
          artifact_dir, error, received_at, updated_at
         FROM event_receipts
         WHERE (? IS NULL OR source_id = ?)
           AND (? IS NULL OR status = ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(
        input.sourceId ?? null,
        input.sourceId ?? null,
        input.status ?? null,
        input.status ?? null,
        input.limit ?? 100,
      ) as Parameters<typeof toRuntimeEventReceiptIndexRecord>[0][];
    return rows.map(toRuntimeEventReceiptIndexRecord);
  });
}

export async function saveEventReplyDispatchToRuntimeDb(
  row: RuntimeEventReplyDispatchSaveInput,
  options: LoadOptions = {},
): Promise<void> {
  await withDatabase(options, (db) => {
    const existing = db
      .query(
        "SELECT created_at FROM event_reply_dispatches WHERE idempotency_key = ? LIMIT 1",
      )
      .get(row.idempotencyKey) as { readonly created_at: string } | null;
    const createdAt = row.createdAt ?? existing?.created_at ?? row.updatedAt;
    const stmt = db.prepare(`
      INSERT INTO event_reply_dispatches (
        idempotency_key, source_id, provider, workflow_id,
        workflow_execution_id, node_id, node_exec_id, event_id,
        conversation_id, thread_id, actor_id, status, dispatch_id,
        provider_message_id, request_json, response_json, error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        source_id=excluded.source_id,
        provider=excluded.provider,
        workflow_id=excluded.workflow_id,
        workflow_execution_id=excluded.workflow_execution_id,
        node_id=excluded.node_id,
        node_exec_id=excluded.node_exec_id,
        event_id=excluded.event_id,
        conversation_id=excluded.conversation_id,
        thread_id=excluded.thread_id,
        actor_id=excluded.actor_id,
        status=excluded.status,
        dispatch_id=excluded.dispatch_id,
        provider_message_id=excluded.provider_message_id,
        request_json=excluded.request_json,
        response_json=excluded.response_json,
        error=excluded.error,
        updated_at=excluded.updated_at
    `);
    stmt.run(
      row.idempotencyKey,
      row.sourceId,
      row.provider,
      row.workflowId,
      row.workflowExecutionId,
      row.nodeId,
      row.nodeExecId,
      row.eventId,
      row.conversationId,
      row.threadId ?? null,
      row.actorId ?? null,
      row.status,
      row.dispatchId ?? null,
      row.providerMessageId ?? null,
      row.requestJson,
      row.responseJson ?? null,
      row.error ?? null,
      createdAt,
      row.updatedAt,
    );
  });
}

export async function loadEventReplyDispatchByIdempotencyKey(
  idempotencyKey: string,
  options: LoadOptions = {},
): Promise<RuntimeEventReplyDispatchRecord | null> {
  return withDatabase(options, (db) => {
    const row = db
      .query(
        `SELECT
          idempotency_key, source_id, provider, workflow_id,
          workflow_execution_id, node_id, node_exec_id, event_id,
          conversation_id, thread_id, actor_id, status, dispatch_id,
          provider_message_id, request_json, response_json, error,
          created_at, updated_at
         FROM event_reply_dispatches
         WHERE idempotency_key = ?
         LIMIT 1`,
      )
      .get(idempotencyKey) as
      | Parameters<typeof toRuntimeEventReplyDispatchRecord>[0]
      | null;
    return row === null ? null : toRuntimeEventReplyDispatchRecord(row);
  });
}

export async function listEventReplyDispatchesFromRuntimeDb(
  input: {
    readonly workflowExecutionId?: string;
    readonly status?: RuntimeEventReplyDispatchStatus;
    readonly limit?: number;
  } = {},
  options: LoadOptions = {},
): Promise<readonly RuntimeEventReplyDispatchRecord[]> {
  return withDatabase(options, (db) => {
    const rows = db
      .query(
        `SELECT
          idempotency_key, source_id, provider, workflow_id,
          workflow_execution_id, node_id, node_exec_id, event_id,
          conversation_id, thread_id, actor_id, status, dispatch_id,
          provider_message_id, request_json, response_json, error,
          created_at, updated_at
         FROM event_reply_dispatches
         WHERE (? IS NULL OR workflow_execution_id = ?)
           AND (? IS NULL OR status = ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(
        input.workflowExecutionId ?? null,
        input.workflowExecutionId ?? null,
        input.status ?? null,
        input.status ?? null,
        input.limit ?? 100,
      ) as Parameters<typeof toRuntimeEventReplyDispatchRecord>[0][];
    return rows.map(toRuntimeEventReplyDispatchRecord);
  });
}
