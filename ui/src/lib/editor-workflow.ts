import type {
  LoopRule,
  NodePayload as WorkflowNodePayload,
  NormalizedWorkflowBundle,
  OutputSelectionPolicy,
  SubWorkflowInputSource,
  SubWorkflowRef,
  WorkflowDefaults,
  WorkflowEdge,
  WorkflowJson,
  WorkflowNodeRef,
} from "../../../src/workflow/types";

export type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

export type EditorWorkflowNode = DeepMutable<WorkflowNodeRef> & {
  label?: string;
};

export type EditorWorkflowEdge = DeepMutable<WorkflowEdge>;
export type EditorLoopRule = DeepMutable<LoopRule>;
export type EditorWorkflowDefaults = DeepMutable<WorkflowDefaults>;
export type EditorOutputSelectionPolicy = DeepMutable<OutputSelectionPolicy>;
export type EditorSubWorkflowInputSource = Omit<
  DeepMutable<SubWorkflowInputSource>,
  "selectionPolicy"
> & {
  selectionPolicy?: EditorOutputSelectionPolicy;
};
export type EditorSubWorkflowRef = Omit<
  DeepMutable<SubWorkflowRef>,
  "inputSources" | "nodeIds"
> & {
  inputSources: EditorSubWorkflowInputSource[];
  nodeIds: string[];
};
export type EditorWorkflow = Omit<
  DeepMutable<WorkflowJson>,
  "defaults" | "subWorkflows" | "nodes" | "edges" | "loops"
> & {
  defaults: EditorWorkflowDefaults;
  subWorkflows: EditorSubWorkflowRef[];
  nodes: EditorWorkflowNode[];
  edges: EditorWorkflowEdge[];
  loops?: EditorLoopRule[];
};
export type EditorNodePayload = Omit<
  DeepMutable<WorkflowNodePayload>,
  "executionBackend"
> & {
  executionBackend?: string;
};
export type EditorWorkflowBundle = Omit<
  DeepMutable<NormalizedWorkflowBundle>,
  "workflow" | "nodePayloads"
> & {
  workflow: EditorWorkflow;
  nodePayloads: Record<string, EditorNodePayload>;
};

export function cloneEditableValue<T>(value: T): DeepMutable<T> {
  return JSON.parse(JSON.stringify(value)) as DeepMutable<T>;
}
