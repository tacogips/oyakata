export type AgentModel = "tacogips/codex-agent" | "tacogips/claude-code-agent";

export type NodeKind =
  | "task"
  | "branch-judge"
  | "loop-judge"
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

export interface WorkflowJson {
  readonly workflowId: string;
  readonly description: string;
  readonly defaults: WorkflowDefaults;
  readonly managerNodeId: string;
  readonly subWorkflows: readonly Readonly<Record<string, unknown>>[];
  readonly subWorkflowConversations?: readonly Readonly<Record<string, unknown>>[];
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
  readonly model: AgentModel;
  readonly promptTemplate: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly argumentsTemplate?: Readonly<Record<string, unknown>>;
  readonly argumentBindings?: readonly ArgumentBinding[];
  readonly templateEngine?: string;
  readonly timeoutMs?: number;
}

export interface VisNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkflowVisJson {
  readonly nodes: readonly VisNode[];
  readonly viewport?: Readonly<Record<string, unknown>>;
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
