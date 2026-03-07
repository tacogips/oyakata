export type CliAgentBackend = "tacogips/codex-agent" | "tacogips/claude-code-agent";

export type NodeExecutionBackend =
  | CliAgentBackend
  | "official/openai-sdk"
  | "official/anthropic-sdk";

export type NodeKind =
  | "task"
  | "branch-judge"
  | "loop-judge"
  | "root-manager"
  | "sub-manager"
  | "manager"
  | "input"
  | "output";

export type CompletionType =
  | "checklist"
  | "score-threshold"
  | "validator-result"
  | "none";

export interface CompletionRule {
  readonly type: CompletionType;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface WorkflowDefaults {
  readonly maxLoopIterations: number;
  readonly nodeTimeoutMs: number;
}

export interface WorkflowNodeRef {
  readonly id: string;
  readonly nodeFile: string;
  readonly kind?: NodeKind;
  readonly completion?: CompletionRule;
}

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  readonly when: string;
  readonly priority?: number;
}

export interface LoopRule {
  readonly id: string;
  readonly judgeNodeId: string;
  readonly maxIterations?: number;
  readonly continueWhen: string;
  readonly exitWhen: string;
  readonly backoffMs?: number;
}

export type OutputSelectionMode =
  | "explicit"
  | "latest-succeeded"
  | "latest-any"
  | "by-loop-iteration";

export interface OutputSelectionPolicy {
  readonly mode: OutputSelectionMode;
  readonly nodeExecId?: string;
  readonly loopIteration?: number;
}

export type SubWorkflowInputSourceType =
  | "human-input"
  | "workflow-output"
  | "node-output"
  | "sub-workflow-output";

export interface SubWorkflowInputSource {
  readonly type: SubWorkflowInputSourceType;
  readonly workflowId?: string;
  readonly nodeId?: string;
  readonly subWorkflowId?: string;
  readonly selectionPolicy?: OutputSelectionPolicy;
}

export interface SubWorkflowRef {
  readonly id: string;
  readonly description: string;
  readonly managerNodeId?: string;
  readonly inputNodeId: string;
  readonly outputNodeId: string;
  readonly nodeIds?: readonly string[];
  readonly inputSources: readonly SubWorkflowInputSource[];
}

export interface SubWorkflowConversation {
  readonly id: string;
  readonly participants: readonly string[];
  readonly maxTurns: number;
  readonly stopWhen: string;
}

export interface WorkflowJson {
  readonly workflowId: string;
  readonly description: string;
  readonly defaults: WorkflowDefaults;
  readonly managerNodeId: string;
  readonly subWorkflows: readonly SubWorkflowRef[];
  readonly subWorkflowConversations?: readonly SubWorkflowConversation[];
  readonly nodes: readonly WorkflowNodeRef[];
  readonly edges: readonly WorkflowEdge[];
  readonly loops?: readonly LoopRule[];
  readonly branching: {
    readonly mode: "fan-out";
  };
}

export interface ArgumentBinding {
  readonly targetPath: string;
  readonly source:
    | "variables"
    | "node-output"
    | "sub-workflow-output"
    | "workflow-output"
    | "human-input"
    | "conversation-transcript";
  readonly sourceRef?: Readonly<Record<string, unknown>> | string;
  readonly sourcePath?: string;
  readonly required?: boolean;
}

export interface NodePayload {
  readonly id: string;
  readonly model: string;
  readonly executionBackend?: NodeExecutionBackend;
  readonly promptTemplate: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly argumentsTemplate?: Readonly<Record<string, unknown>>;
  readonly argumentBindings?: readonly ArgumentBinding[];
  readonly templateEngine?: string;
  readonly timeoutMs?: number;
}

export interface VisNode {
  readonly id: string;
  readonly order: number;
}

export interface WorkflowVisJson {
  readonly nodes: readonly VisNode[];
  readonly uiMeta?: Readonly<Record<string, unknown>>;
}

export interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly message: string;
}

export interface NormalizedWorkflowBundle {
  readonly workflow: WorkflowJson;
  readonly workflowVis: WorkflowVisJson;
  readonly nodePayloads: Readonly<Record<string, NodePayload>>;
}

export interface LoadOptions {
  readonly workflowRoot?: string;
  readonly artifactRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export interface EffectiveRoots {
  readonly workflowRoot: string;
  readonly artifactRoot: string;
}

export const DEFAULT_MAX_LOOP_ITERATIONS = 3;
export const DEFAULT_NODE_TIMEOUT_MS = 120000;
export const DEFAULT_WORKFLOW_ROOT = "./.oyakata";
export const DEFAULT_ARTIFACT_ROOT = "./.oyakata/workflow";
export const DEFAULT_RUNTIME_ROOT = "./.oyakata-opt";

export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
