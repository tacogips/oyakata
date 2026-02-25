export type SessionStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export interface SessionTransition {
  readonly from: string;
  readonly to: string;
  readonly when: string;
}

export interface NodeExecutionRecord {
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
  readonly artifactDir: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly attempt?: number;
  readonly restartedFromNodeExecId?: string;
}

export interface NodeRestartEvent {
  readonly nodeId: string;
  readonly fromNodeExecId: string;
  readonly restartAttempt: number;
  readonly reason: "stuck_timeout";
  readonly at: string;
}

export interface ConversationTurnRecord {
  readonly conversationId: string;
  readonly turnIndex: number;
  readonly fromSubWorkflowId: string;
  readonly toSubWorkflowId: string;
  readonly outputRef: Readonly<Record<string, unknown>>;
  readonly sentAt: string;
}

export interface WorkflowSessionState {
  readonly sessionId: string;
  readonly workflowName: string;
  readonly workflowId: string;
  readonly status: SessionStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly queue: readonly string[];
  readonly currentNodeId?: string;
  readonly nodeExecutionCounter: number;
  readonly nodeExecutionCounts: Readonly<Record<string, number>>;
  readonly loopIterationCounts?: Readonly<Record<string, number>>;
  readonly restartCounts?: Readonly<Record<string, number>>;
  readonly restartEvents?: readonly NodeRestartEvent[];
  readonly transitions: readonly SessionTransition[];
  readonly nodeExecutions: readonly NodeExecutionRecord[];
  readonly conversationTurns?: readonly ConversationTurnRecord[];
  readonly runtimeVariables: Readonly<Record<string, unknown>>;
  readonly lastError?: string;
}

export interface CreateSessionInput {
  readonly sessionId: string;
  readonly workflowName: string;
  readonly workflowId: string;
  readonly initialNodeId: string;
  readonly runtimeVariables: Readonly<Record<string, unknown>>;
}

export function createSessionState(input: CreateSessionInput): WorkflowSessionState {
  return {
    sessionId: input.sessionId,
    workflowName: input.workflowName,
    workflowId: input.workflowId,
    status: "running",
    startedAt: new Date().toISOString(),
    queue: [input.initialNodeId],
    nodeExecutionCounter: 0,
    nodeExecutionCounts: {},
    loopIterationCounts: {},
    restartCounts: {},
    restartEvents: [],
    transitions: [],
    nodeExecutions: [],
    conversationTurns: [],
    runtimeVariables: input.runtimeVariables,
  };
}

export function isSafeSessionId(sessionId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-_]{5,127}$/.test(sessionId);
}

export function createSessionId(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const random = Math.random().toString(36).slice(2, 10);
  return `sess-${timestamp}-${random}`;
}
