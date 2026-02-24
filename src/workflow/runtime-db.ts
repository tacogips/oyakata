import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { NodeExecutionRecord, WorkflowSessionState } from "./session";
import type { LoadOptions } from "./types";
import { DEFAULT_RUNTIME_ROOT } from "./types";

interface RuntimeNodeExecutionRow {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly status: NodeExecutionRecord["status"];
  readonly artifactDir: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly attempt?: number;
  readonly restartedFromNodeExecId?: string;
  readonly inputJson: string;
  readonly outputJson: string;
  readonly inputHash: string;
  readonly outputHash: string;
}

function resolveRuntimeRoot(options: LoadOptions): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const root = env["OYAKATA_RUNTIME_ROOT"] ?? DEFAULT_RUNTIME_ROOT;
  return path.isAbsolute(root) ? root : path.resolve(cwd, root);
}

export function resolveRuntimeDbPath(options: LoadOptions): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const dbPath = env["OYAKATA_RUNTIME_DB"];
  if (typeof dbPath === "string" && dbPath.length > 0) {
    return path.isAbsolute(dbPath) ? dbPath : path.resolve(cwd, dbPath);
  }
  return path.join(resolveRuntimeRoot(options), "oyakata.db");
}

async function withDatabase<T>(options: LoadOptions, action: (db: Database) => T): Promise<T> {
  const dbPath = resolveRuntimeDbPath(options);
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    ensureSchema(db);
    return action(db);
  } finally {
    db.close();
  }
}

function ensureSchema(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      current_node_id TEXT,
      node_execution_counter INTEGER NOT NULL,
      queue_json TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_executions (
      session_id TEXT NOT NULL,
      node_exec_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      artifact_dir TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      attempt INTEGER,
      restarted_from_node_exec_id TEXT,
      input_hash TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, node_exec_id)
    );
    CREATE TABLE IF NOT EXISTS node_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      node_exec_id TEXT,
      node_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_workflow_name ON sessions (workflow_name);
    CREATE INDEX IF NOT EXISTS idx_node_exec_session ON node_executions (session_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_node_logs_session ON node_logs (session_id, at);
  `);
}

export async function saveSessionSnapshotToRuntimeDb(
  session: WorkflowSessionState,
  options: LoadOptions = {},
): Promise<void> {
  await withDatabase(options, (db) => {
    const stmt = db.prepare(`
      INSERT INTO sessions (
        session_id, workflow_name, workflow_id, status, started_at, ended_at,
        current_node_id, node_execution_counter, queue_json, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workflow_name=excluded.workflow_name,
        workflow_id=excluded.workflow_id,
        status=excluded.status,
        started_at=excluded.started_at,
        ended_at=excluded.ended_at,
        current_node_id=excluded.current_node_id,
        node_execution_counter=excluded.node_execution_counter,
        queue_json=excluded.queue_json,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at
    `);
    const updatedAt = new Date().toISOString();
    stmt.run(
      session.sessionId,
      session.workflowName,
      session.workflowId,
      session.status,
      session.startedAt,
      session.endedAt ?? null,
      session.currentNodeId ?? null,
      session.nodeExecutionCounter,
      JSON.stringify(session.queue),
      session.lastError ?? null,
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
        session_id, node_exec_id, node_id, status, artifact_dir, started_at, ended_at,
        attempt, restarted_from_node_exec_id, input_hash, output_hash, input_json, output_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    nodeStmt.run(
      row.sessionId,
      row.nodeExecId,
      row.nodeId,
      row.status,
      row.artifactDir,
      row.startedAt,
      row.endedAt,
      row.attempt ?? null,
      row.restartedFromNodeExecId ?? null,
      row.inputHash,
      row.outputHash,
      row.inputJson,
      row.outputJson,
      now,
    );

    const logStmt = db.prepare(`
      INSERT INTO node_logs (session_id, node_exec_id, node_id, level, message, payload_json, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    logStmt.run(
      row.sessionId,
      row.nodeExecId,
      row.nodeId,
      row.status === "succeeded" ? "info" : "warning",
      `node ${row.nodeId} finished with status ${row.status}`,
      JSON.stringify({
        inputHash: row.inputHash,
        outputHash: row.outputHash,
        artifactDir: row.artifactDir,
      }),
      row.endedAt,
    );
  });
}
