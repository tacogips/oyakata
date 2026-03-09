<script lang="ts">
  import type {
    CompletionType,
    NodeKind,
    SubWorkflowBlockType,
    SubWorkflowInputSourceType,
    ValidationIssue,
  } from "../../../../src/workflow/types";
  import type { UiConfigResponse, WorkflowResponse } from "../../../../src/shared/ui-contract";
  import type { DerivedVisNode } from "../../../../src/workflow/visualization";
  import {
    availableSubWorkflowBoundaryNodes,
    availableSubWorkflowMemberNodes,
    nextGeneratedNodeId,
    orderedNodes,
    workflowManagerCandidateNodes,
  } from "../editor-workflow-operations";
  import { RESERVED_STRUCTURE_KINDS } from "../editor-field-updates";
  import type {
    EditorNodePayload,
    EditorWorkflowBundle,
    EditorWorkflowDefaults,
    EditorWorkflowEdge,
    EditorWorkflowNode,
  } from "../editor-workflow";

  type VoidAction = () => void;
  type SelectNodeAction = (nodeId: string) => void;
  type MoveNodeAction = (nodeId: string, direction: -1 | 1) => void;
  type UpdateDefaultAction = (field: keyof EditorWorkflowDefaults, value: string) => void;
  type UpdateEdgeAction = (index: number, field: keyof EditorWorkflowEdge, value: string) => void;
  type UpdateLoopAction = (
    index: number,
    field: "id" | "judgeNodeId" | "continueWhen" | "exitWhen" | "maxIterations",
    value: string,
  ) => void;
  type UpdateSubWorkflowFieldAction = (index: number, field: "id" | "description", value: string) => void;
  type UpdateSubWorkflowBoundaryAction = (
    index: number,
    field: "managerNodeId" | "inputNodeId" | "outputNodeId",
    value: string,
  ) => void;
  type ToggleSubWorkflowNodeAction = (index: number, nodeId: string, checked: boolean) => void;
  type UpdateSubWorkflowInputSourceTypeAction = (
    index: number,
    sourceIndex: number,
    value: SubWorkflowInputSourceType,
  ) => void;
  type UpdateSubWorkflowInputSourceFieldAction = (
    index: number,
    sourceIndex: number,
    field: "workflowId" | "nodeId" | "subWorkflowId",
    value: string,
  ) => void;
  type UpdateNodeKindAction = (nodeId: string, kind: NodeKind) => void;
  type UpdateNodeCompletionAction = (nodeId: string, completionType: CompletionType) => void;
  type UpdateNodePayloadStringAction = (
    field: "executionBackend" | "model" | "promptTemplate",
    value: string,
  ) => void;
  type UpdateNodeTimeoutAction = (value: string) => void;

  const MANUALLY_ASSIGNABLE_NODE_KINDS: readonly NodeKind[] = ["task", "branch-judge", "loop-judge", "manager"];
  const noop = (): void => {};
  const noopSelectNode: SelectNodeAction = () => {};
  const noopMoveNode: MoveNodeAction = () => {};
  const noopUpdateDefault: UpdateDefaultAction = () => {};
  const noopUpdateEdge: UpdateEdgeAction = () => {};
  const noopUpdateLoop: UpdateLoopAction = () => {};
  const noopUpdateSubWorkflowField: UpdateSubWorkflowFieldAction = () => {};
  const noopUpdateSubWorkflowBoundary: UpdateSubWorkflowBoundaryAction = () => {};
  const noopToggleSubWorkflowNode: ToggleSubWorkflowNodeAction = () => {};
  const noopUpdateSubWorkflowInputSourceType: UpdateSubWorkflowInputSourceTypeAction = () => {};
  const noopUpdateSubWorkflowInputSourceField: UpdateSubWorkflowInputSourceFieldAction = () => {};
  const noopUpdateNodeKind: UpdateNodeKindAction = () => {};
  const noopUpdateNodeCompletion: UpdateNodeCompletionAction = () => {};
  const noopUpdateNodePayloadString: UpdateNodePayloadStringAction = () => {};
  const noopUpdateNodeTimeout: UpdateNodeTimeoutAction = () => {};

  export let loading = false;
  export let busy = false;
  export let config: UiConfigResponse | null = null;
  export let workflow: WorkflowResponse | null = null;
  export let editableBundle: EditorWorkflowBundle | null = null;
  export let editableDerivedVisualization: readonly DerivedVisNode[] = [];
  export let selectedNodeId = "";
  export let selectedNode: EditorWorkflowNode | null = null;
  export let selectedNodePayload: EditorNodePayload | null = null;
  export let nodeVariablesText = "{}";
  export let validationIssues: readonly ValidationIssue[] = [];
  export let validationSummary = "";
  export let workflowDirty = false;
  export let newNodeId = "";
  export let newNodeKind: NodeKind = "task";
  export let onUpdateDescription: (value: string) => void = noop;
  export let onUpdateDefaultNumber: UpdateDefaultAction = noopUpdateDefault;
  export let onUpdateManagerNode: (nodeId: string) => void = noop;
  export let onAddNode: VoidAction = noop;
  export let onSetSelectedNode: SelectNodeAction = noopSelectNode;
  export let onMoveNode: MoveNodeAction = noopMoveNode;
  export let onRemoveNode: SelectNodeAction = noopSelectNode;
  export let onUpdateNodeKind: UpdateNodeKindAction = noopUpdateNodeKind;
  export let onUpdateNodeCompletion: UpdateNodeCompletionAction = noopUpdateNodeCompletion;
  export let onUpdateNodePayloadString: UpdateNodePayloadStringAction = noopUpdateNodePayloadString;
  export let onUpdateNodeTimeout: UpdateNodeTimeoutAction = noopUpdateNodeTimeout;
  export let onSyncVariablesText: (value: string) => void = noop;
  export let onAddEdge: VoidAction = noop;
  export let onRemoveEdge: (index: number) => void = noop;
  export let onUpdateEdgeField: UpdateEdgeAction = noopUpdateEdge;
  export let onAddLoop: VoidAction = noop;
  export let onRemoveLoop: (index: number) => void = noop;
  export let onUpdateLoopField: UpdateLoopAction = noopUpdateLoop;
  export let onAddSubWorkflow: VoidAction = noop;
  export let onRemoveSubWorkflow: (index: number) => void = noop;
  export let onUpdateSubWorkflowField: UpdateSubWorkflowFieldAction = noopUpdateSubWorkflowField;
  export let onUpdateSubWorkflowBlockType: (index: number, value: SubWorkflowBlockType) => void = noop;
  export let onUpdateSubWorkflowBlockLoopId: (index: number, value: string) => void = noop;
  export let onUpdateSubWorkflowBoundary: UpdateSubWorkflowBoundaryAction = noopUpdateSubWorkflowBoundary;
  export let onToggleSubWorkflowNodeMembership: ToggleSubWorkflowNodeAction = noopToggleSubWorkflowNode;
  export let onAddSubWorkflowInputSource: (index: number) => void = noop;
  export let onRemoveSubWorkflowInputSource: (index: number, sourceIndex: number) => void = noop;
  export let onUpdateSubWorkflowInputSourceType: UpdateSubWorkflowInputSourceTypeAction =
    noopUpdateSubWorkflowInputSourceType;
  export let onUpdateSubWorkflowInputSourceField: UpdateSubWorkflowInputSourceFieldAction =
    noopUpdateSubWorkflowInputSourceField;

  function visualizationForNode(nodeId: string): DerivedVisNode | undefined {
    return editableDerivedVisualization.find((entry) => entry.id === nodeId);
  }

  $: orderedWorkflowNodes = orderedNodes(editableBundle);
</script>

<section class="panel main-panel">
  <div class="section-head">
    <div>
      <h2>Workflow Editor</h2>
      {#if workflow}
        <p class="subtle">
          {workflow.workflowName} · revision {workflow.revision ?? "none"} · {workflowDirty ? "unsaved changes" : "saved"}
        </p>
      {/if}
    </div>
    {#if editableBundle}
      <span class="badge subtle">{editableBundle.workflow.workflowId}</span>
    {/if}
  </div>

  {#if loading}
    <p class="empty">Loading UI bootstrap data...</p>
  {:else if editableBundle}
    <div class="editor-grid">
      <div class="editor-column">
        <label for="description">Workflow Description</label>
        <textarea
          id="description"
          value={editableBundle.workflow.description}
          on:input={(event) => onUpdateDescription((event.currentTarget as HTMLTextAreaElement).value)}
          disabled={config?.readOnly || busy}
        ></textarea>

        <div class="defaults-grid">
          <div>
            <label for="max-loop-iterations">Default Max Loop Iterations</label>
            <input
              id="max-loop-iterations"
              type="number"
              min="1"
              value={String(editableBundle.workflow.defaults.maxLoopIterations)}
              on:input={(event) =>
                onUpdateDefaultNumber("maxLoopIterations", (event.currentTarget as HTMLInputElement).value)}
              disabled={config?.readOnly || busy}
            />
          </div>
          <div>
            <label for="default-timeout">Default Node Timeout (ms)</label>
            <input
              id="default-timeout"
              type="number"
              min="1"
              value={String(editableBundle.workflow.defaults.nodeTimeoutMs)}
              on:input={(event) => onUpdateDefaultNumber("nodeTimeoutMs", (event.currentTarget as HTMLInputElement).value)}
              disabled={config?.readOnly || busy}
            />
          </div>
        </div>

        <div class="structure-block">
          <div class="section-head">
            <h3>Structure</h3>
            <span>{editableBundle.workflow.edges.length} edges · {editableBundle.workflow.loops?.length ?? 0} loops</span>
          </div>

          <div class="property-grid">
            <div>
              <label for="manager-node">Manager Node</label>
              <select
                id="manager-node"
                value={editableBundle.workflow.managerNodeId}
                on:change={(event) => onUpdateManagerNode((event.currentTarget as HTMLSelectElement).value)}
                disabled={config?.readOnly || busy}
              >
                {#each workflowManagerCandidateNodes(editableBundle) as node}
                  <option value={node.id}>{node.id}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="section-head">
            <h3>Node Actions</h3>
            <button class="ghost" on:click={onAddNode} disabled={config?.readOnly || busy}>Add Node</button>
          </div>
          <div class="property-grid">
            <div>
              <label for="new-node-id">New Node ID</label>
              <input
                id="new-node-id"
                bind:value={newNodeId}
                placeholder={nextGeneratedNodeId(editableBundle)}
                disabled={config?.readOnly || busy}
              />
            </div>
            <div>
              <label for="new-node-kind">New Node Kind</label>
              <select id="new-node-kind" bind:value={newNodeKind} disabled={config?.readOnly || busy}>
                {#each MANUALLY_ASSIGNABLE_NODE_KINDS as kind}
                  <option value={kind}>{kind}</option>
                {/each}
              </select>
            </div>
          </div>
        </div>

        <div class="nodes">
          <div class="section-head">
            <h3>Nodes</h3>
            <span>{editableBundle.workflow.nodes.length}</span>
          </div>
          {#each orderedWorkflowNodes as node}
            {@const view = visualizationForNode(node.id)}
            {@const payload = editableBundle.nodePayloads[node.id] ?? editableBundle.nodePayloads[node.nodeFile]}
            <div
              class:selected={node.id === selectedNodeId}
              class="node-card ghost"
              on:click={() => onSetSelectedNode(node.id)}
              on:keydown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSetSelectedNode(node.id);
                }
              }}
              role="button"
              tabindex="0"
            >
              <div class="node-head">
                <strong>{node.label ?? node.id}</strong>
                <span class="node-kind">{node.kind ?? "task"}</span>
              </div>
              <div class="node-meta">
                <span>Indent {view?.indent ?? 0}</span>
                <span>{view?.color ?? "default"}</span>
              </div>
              <div class="node-meta">
                <span>{payload?.executionBackend ?? "legacy backend"}</span>
                <span>{payload?.model ?? "unspecified"}</span>
              </div>
              <div class="node-actions">
                <button
                  class="ghost"
                  type="button"
                  on:click|stopPropagation={() => onMoveNode(node.id, -1)}
                  disabled={config?.readOnly || busy || orderedWorkflowNodes[0]?.id === node.id}
                >
                  Up
                </button>
                <button
                  class="ghost"
                  type="button"
                  on:click|stopPropagation={() => onMoveNode(node.id, 1)}
                  disabled={config?.readOnly || busy || orderedWorkflowNodes[orderedWorkflowNodes.length - 1]?.id === node.id}
                >
                  Down
                </button>
                <button
                  class="ghost"
                  type="button"
                  on:click|stopPropagation={() => onRemoveNode(node.id)}
                  disabled={config?.readOnly || busy || editableBundle.workflow.managerNodeId === node.id}
                >
                  Remove
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div class="editor-column">
        <div class="section-head">
          <h3>Selected Node</h3>
          {#if selectedNode}
            <span class="badge subtle">{selectedNode.nodeFile}</span>
          {/if}
        </div>

        {#if selectedNode && selectedNodePayload}
          {@const activeNode = selectedNode}
          <div class="property-grid">
            <div>
              <label for="node-id">Node ID</label>
              <input id="node-id" value={activeNode.id} readonly />
            </div>
            <div>
              <label for="node-kind">Kind</label>
              {#if activeNode.kind && RESERVED_STRUCTURE_KINDS.has(activeNode.kind)}
                <input id="node-kind" value={`${activeNode.kind} (derived from structure)`} readonly />
              {:else}
                <select
                  id="node-kind"
                  value={activeNode.kind ?? "task"}
                  on:change={(event) =>
                    onUpdateNodeKind(activeNode.id, (event.currentTarget as HTMLSelectElement).value as NodeKind)}
                  disabled={config?.readOnly || busy}
                >
                  {#each MANUALLY_ASSIGNABLE_NODE_KINDS as kind}
                    <option value={kind}>{kind}</option>
                  {/each}
                </select>
              {/if}
            </div>
            <div>
              <label for="node-completion">Completion</label>
              <select
                id="node-completion"
                value={activeNode.completion?.type ?? "none"}
                on:change={(event) =>
                  onUpdateNodeCompletion(activeNode.id, (event.currentTarget as HTMLSelectElement).value as CompletionType)}
                disabled={config?.readOnly || busy}
              >
                <option value="none">none</option>
                <option value="checklist">checklist</option>
                <option value="score-threshold">score-threshold</option>
                <option value="validator-result">validator-result</option>
              </select>
            </div>
            <div>
              <label for="execution-backend">Execution Backend</label>
              <input
                id="execution-backend"
                value={selectedNodePayload.executionBackend ?? ""}
                placeholder="tacogips/codex-agent"
                on:input={(event) =>
                  onUpdateNodePayloadString("executionBackend", (event.currentTarget as HTMLInputElement).value)}
                disabled={config?.readOnly || busy}
              />
            </div>
            <div>
              <label for="model">Model</label>
              <input
                id="model"
                value={selectedNodePayload.model}
                placeholder="gpt-5 / claude-sonnet-4-5 / claude-opus-4-1"
                on:input={(event) => onUpdateNodePayloadString("model", (event.currentTarget as HTMLInputElement).value)}
                disabled={config?.readOnly || busy}
              />
            </div>
            <div>
              <label for="timeout">Node Timeout (ms)</label>
              <input
                id="timeout"
                type="number"
                min="1"
                value={selectedNodePayload.timeoutMs === undefined ? "" : String(selectedNodePayload.timeoutMs)}
                placeholder="inherit default"
                on:input={(event) => onUpdateNodeTimeout((event.currentTarget as HTMLInputElement).value)}
                disabled={config?.readOnly || busy}
              />
            </div>
          </div>

          <label for="prompt-template">Prompt Template</label>
          <textarea
            id="prompt-template"
            value={selectedNodePayload.promptTemplate}
            on:input={(event) =>
              onUpdateNodePayloadString("promptTemplate", (event.currentTarget as HTMLTextAreaElement).value)}
            disabled={config?.readOnly || busy}
          ></textarea>

          <label for="variables">Variables JSON</label>
          <textarea
            id="variables"
            class="code"
            value={nodeVariablesText}
            on:input={(event) => onSyncVariablesText((event.currentTarget as HTMLTextAreaElement).value)}
            spellcheck="false"
            disabled={config?.readOnly || busy}
          ></textarea>
        {:else}
          <p class="empty">Select a node to edit backend, model, prompt, and variables.</p>
        {/if}

        <div class="validation-block">
          <div class="section-head">
            <h3>Validation</h3>
            <span>{validationIssues.length}</span>
          </div>
          <p class="subtle">{validationSummary || "Run validation before saving to inspect workflow and payload issues."}</p>
          {#if validationIssues.length === 0}
            <p class="empty">No validation results yet.</p>
          {:else}
            <div class="issues">
              {#each validationIssues as issue}
                <article class:error={issue.severity === "error"} class:warning={issue.severity === "warning"} class="issue-card">
                  <div class="issue-head">
                    <strong>{issue.severity}</strong>
                    <span>{issue.path}</span>
                  </div>
                  <p>{issue.message}</p>
                </article>
              {/each}
            </div>
          {/if}
        </div>

        <div class="structure-block">
          <div class="section-head">
            <h3>Edges</h3>
            <button class="ghost" on:click={onAddEdge} disabled={config?.readOnly || busy || editableBundle.workflow.nodes.length < 2}>
              Add Edge
            </button>
          </div>
          {#if editableBundle.workflow.edges.length === 0}
            <p class="empty">No edges defined.</p>
          {:else}
            <div class="issues">
              {#each editableBundle.workflow.edges as edge, index}
                <article class="issue-card">
                  <div class="property-grid">
                    <div>
                      <label for={`edge-from-${index}`}>From</label>
                      <select
                        id={`edge-from-${index}`}
                        value={edge.from}
                        on:change={(event) => onUpdateEdgeField(index, "from", (event.currentTarget as HTMLSelectElement).value)}
                        disabled={config?.readOnly || busy}
                      >
                        {#each editableBundle.workflow.nodes as node}
                          <option value={node.id}>{node.id}</option>
                        {/each}
                      </select>
                    </div>
                    <div>
                      <label for={`edge-to-${index}`}>To</label>
                      <select
                        id={`edge-to-${index}`}
                        value={edge.to}
                        on:change={(event) => onUpdateEdgeField(index, "to", (event.currentTarget as HTMLSelectElement).value)}
                        disabled={config?.readOnly || busy}
                      >
                        {#each editableBundle.workflow.nodes as node}
                          <option value={node.id}>{node.id}</option>
                        {/each}
                      </select>
                    </div>
                    <div>
                      <label for={`edge-when-${index}`}>When</label>
                      <input
                        id={`edge-when-${index}`}
                        value={edge.when}
                        on:input={(event) => onUpdateEdgeField(index, "when", (event.currentTarget as HTMLInputElement).value)}
                        disabled={config?.readOnly || busy}
                      />
                    </div>
                    <div>
                      <label for={`edge-priority-${index}`}>Priority</label>
                      <input
                        id={`edge-priority-${index}`}
                        type="number"
                        min="0"
                        value={edge.priority === undefined ? "" : String(edge.priority)}
                        on:input={(event) => onUpdateEdgeField(index, "priority", (event.currentTarget as HTMLInputElement).value)}
                        disabled={config?.readOnly || busy}
                      />
                    </div>
                  </div>
                  <button class="ghost" on:click={() => onRemoveEdge(index)} disabled={config?.readOnly || busy}>Remove Edge</button>
                </article>
              {/each}
            </div>
          {/if}
        </div>

        <div class="structure-block">
          <div class="section-head">
            <h3>Loops</h3>
            <button class="ghost" on:click={onAddLoop} disabled={config?.readOnly || busy}>Add Loop</button>
          </div>
          {#if (editableBundle.workflow.loops?.length ?? 0) === 0}
            <p class="empty">No loops defined.</p>
          {:else}
            <div class="issues">
              {#each editableBundle.workflow.loops ?? [] as loop, index}
                <article class="issue-card">
                  <div class="property-grid">
                    <div>
                      <label for={`loop-id-${index}`}>Loop ID</label>
                      <input
                        id={`loop-id-${index}`}
                        value={loop.id}
                        on:input={(event) => onUpdateLoopField(index, "id", (event.currentTarget as HTMLInputElement).value)}
                        disabled={config?.readOnly || busy}
                      />
                    </div>
                    <div>
                      <label for={`loop-judge-${index}`}>Judge Node</label>
                      <select
                        id={`loop-judge-${index}`}
                        value={loop.judgeNodeId}
                        on:change={(event) =>
                          onUpdateLoopField(index, "judgeNodeId", (event.currentTarget as HTMLSelectElement).value)}
                        disabled={config?.readOnly || busy}
                      >
                        <option value="">Select a loop-judge node</option>
                        {#each editableBundle.workflow.nodes.filter((node) => node.kind === "loop-judge") as node}
                          <option value={node.id}>{node.id}</option>
                        {/each}
                      </select>
                    </div>
                    <div>
                      <label for={`loop-continue-${index}`}>Continue When</label>
                      <input
                        id={`loop-continue-${index}`}
                        value={loop.continueWhen}
                        on:input={(event) =>
                          onUpdateLoopField(index, "continueWhen", (event.currentTarget as HTMLInputElement).value)}
                        disabled={config?.readOnly || busy}
                      />
                    </div>
                    <div>
                      <label for={`loop-exit-${index}`}>Exit When</label>
                      <input
                        id={`loop-exit-${index}`}
                        value={loop.exitWhen}
                        on:input={(event) => onUpdateLoopField(index, "exitWhen", (event.currentTarget as HTMLInputElement).value)}
                        disabled={config?.readOnly || busy}
                      />
                    </div>
                    <div>
                      <label for={`loop-max-${index}`}>Max Iterations</label>
                      <input
                        id={`loop-max-${index}`}
                        type="number"
                        min="1"
                        value={loop.maxIterations === undefined ? "" : String(loop.maxIterations)}
                        on:input={(event) =>
                          onUpdateLoopField(index, "maxIterations", (event.currentTarget as HTMLInputElement).value)}
                        disabled={config?.readOnly || busy}
                      />
                    </div>
                  </div>
                  <button class="ghost" on:click={() => onRemoveLoop(index)} disabled={config?.readOnly || busy}>Remove Loop</button>
                </article>
              {/each}
            </div>
          {/if}
        </div>

        <div class="structure-block">
          <div class="section-head">
            <h3>Sub-Workflows</h3>
            <button class="ghost" on:click={onAddSubWorkflow} disabled={config?.readOnly || busy}>Add Sub-Workflow</button>
          </div>
          {#if editableBundle.workflow.subWorkflows.length === 0}
            <p class="empty">No sub-workflows defined.</p>
          {:else}
            <div class="issues">
              {#each editableBundle.workflow.subWorkflows as subWorkflow, index}
                <article class="issue-card">
                  <div class="property-grid">
                    <div>
                      <label for={`sub-workflow-id-${index}`}>Sub-Workflow ID</label>
                      <input
                        id={`sub-workflow-id-${index}`}
                        value={subWorkflow.id}
                        on:input={(event) =>
                          onUpdateSubWorkflowField(index, "id", (event.currentTarget as HTMLInputElement).value)}
                        disabled={config?.readOnly || busy}
                      />
                    </div>
                    <div>
                      <label for={`sub-workflow-description-${index}`}>Description</label>
                      <input
                        id={`sub-workflow-description-${index}`}
                        value={subWorkflow.description}
                        on:input={(event) =>
                          onUpdateSubWorkflowField(index, "description", (event.currentTarget as HTMLInputElement).value)}
                        disabled={config?.readOnly || busy}
                      />
                    </div>
                    <div>
                      <label for={`sub-workflow-block-type-${index}`}>Block Type</label>
                      <select
                        id={`sub-workflow-block-type-${index}`}
                        value={subWorkflow.block?.type ?? "plain"}
                        on:change={(event) =>
                          onUpdateSubWorkflowBlockType(index, (event.currentTarget as HTMLSelectElement).value as SubWorkflowBlockType)}
                        disabled={config?.readOnly || busy}
                      >
                        <option value="plain">plain</option>
                        <option value="branch-block">branch-block</option>
                        <option value="loop-body">loop-body</option>
                      </select>
                    </div>
                    {#if subWorkflow.block?.type === "loop-body"}
                      <div>
                        <label for={`sub-workflow-loop-id-${index}`}>Loop</label>
                        <select
                          id={`sub-workflow-loop-id-${index}`}
                          value={subWorkflow.block.loopId ?? ""}
                          on:change={(event) =>
                            onUpdateSubWorkflowBlockLoopId(index, (event.currentTarget as HTMLSelectElement).value.trim())}
                          disabled={config?.readOnly || busy}
                        >
                          <option value="">Select a loop</option>
                          {#each editableBundle.workflow.loops ?? [] as loop}
                            <option value={loop.id}>{loop.id}</option>
                          {/each}
                        </select>
                      </div>
                    {/if}
                    <div>
                      <label for={`sub-workflow-manager-${index}`}>Manager Node</label>
                      <select
                        id={`sub-workflow-manager-${index}`}
                        value={subWorkflow.managerNodeId}
                        on:change={(event) =>
                          onUpdateSubWorkflowBoundary(index, "managerNodeId", (event.currentTarget as HTMLSelectElement).value)}
                        disabled={config?.readOnly || busy}
                      >
                        {#each availableSubWorkflowBoundaryNodes(editableBundle, "managerNodeId", subWorkflow.id) as node}
                          <option value={node.id}>{node.id}</option>
                        {/each}
                      </select>
                    </div>
                    <div>
                      <label for={`sub-workflow-input-${index}`}>Input Node</label>
                      <select
                        id={`sub-workflow-input-${index}`}
                        value={subWorkflow.inputNodeId}
                        on:change={(event) =>
                          onUpdateSubWorkflowBoundary(index, "inputNodeId", (event.currentTarget as HTMLSelectElement).value)}
                        disabled={config?.readOnly || busy}
                      >
                        {#each availableSubWorkflowBoundaryNodes(editableBundle, "inputNodeId", subWorkflow.id) as node}
                          <option value={node.id}>{node.id}</option>
                        {/each}
                      </select>
                    </div>
                    <div>
                      <label for={`sub-workflow-output-${index}`}>Output Node</label>
                      <select
                        id={`sub-workflow-output-${index}`}
                        value={subWorkflow.outputNodeId}
                        on:change={(event) =>
                          onUpdateSubWorkflowBoundary(index, "outputNodeId", (event.currentTarget as HTMLSelectElement).value)}
                        disabled={config?.readOnly || busy}
                      >
                        {#each availableSubWorkflowBoundaryNodes(editableBundle, "outputNodeId", subWorkflow.id) as node}
                          <option value={node.id}>{node.id}</option>
                        {/each}
                      </select>
                    </div>
                  </div>

                  <div class="selection-group">
                    <div class="section-head compact">
                      <h4>Member Nodes</h4>
                      <span>{subWorkflow.nodeIds.length}</span>
                    </div>
                    <div class="check-grid">
                      {#each availableSubWorkflowMemberNodes(editableBundle, subWorkflow.id) as node}
                        {@const lockedBoundary = node.id === subWorkflow.managerNodeId || node.id === subWorkflow.inputNodeId || node.id === subWorkflow.outputNodeId}
                        <label class:locked={lockedBoundary} class="check-chip">
                          <input
                            type="checkbox"
                            checked={subWorkflow.nodeIds.includes(node.id)}
                            disabled={config?.readOnly || busy || lockedBoundary}
                            on:change={(event) =>
                              onToggleSubWorkflowNodeMembership(index, node.id, (event.currentTarget as HTMLInputElement).checked)}
                          />
                          <span>{node.id}</span>
                          <small>{node.kind ?? "task"}</small>
                        </label>
                      {/each}
                    </div>
                  </div>

                  <div class="selection-group">
                    <div class="section-head compact">
                      <h4>Input Sources</h4>
                      <button class="ghost" type="button" on:click={() => onAddSubWorkflowInputSource(index)} disabled={config?.readOnly || busy}>
                        Add Source
                      </button>
                    </div>
                    {#if subWorkflow.inputSources.length === 0}
                      <p class="empty compact">No input sources defined.</p>
                    {:else}
                      <div class="issues">
                        {#each subWorkflow.inputSources as source, sourceIndex}
                          <article class="issue-card nested">
                            <div class="property-grid">
                              <div>
                                <label for={`sub-workflow-source-type-${index}-${sourceIndex}`}>Source Type</label>
                                <select
                                  id={`sub-workflow-source-type-${index}-${sourceIndex}`}
                                  value={source.type}
                                  on:change={(event) =>
                                    onUpdateSubWorkflowInputSourceType(
                                      index,
                                      sourceIndex,
                                      (event.currentTarget as HTMLSelectElement).value as SubWorkflowInputSourceType,
                                    )}
                                  disabled={config?.readOnly || busy}
                                >
                                  <option value="human-input">human-input</option>
                                  <option value="workflow-output">workflow-output</option>
                                  <option value="node-output">node-output</option>
                                  <option value="sub-workflow-output">sub-workflow-output</option>
                                </select>
                              </div>
                              {#if source.type === "workflow-output"}
                                <div>
                                  <label for={`sub-workflow-source-workflow-${index}-${sourceIndex}`}>Workflow ID</label>
                                  <input
                                    id={`sub-workflow-source-workflow-${index}-${sourceIndex}`}
                                    value={source.workflowId ?? ""}
                                    on:input={(event) =>
                                      onUpdateSubWorkflowInputSourceField(
                                        index,
                                        sourceIndex,
                                        "workflowId",
                                        (event.currentTarget as HTMLInputElement).value.trim(),
                                      )}
                                    disabled={config?.readOnly || busy}
                                  />
                                </div>
                              {:else if source.type === "node-output"}
                                <div>
                                  <label for={`sub-workflow-source-node-${index}-${sourceIndex}`}>Node</label>
                                  <select
                                    id={`sub-workflow-source-node-${index}-${sourceIndex}`}
                                    value={source.nodeId ?? ""}
                                    on:change={(event) =>
                                      onUpdateSubWorkflowInputSourceField(
                                        index,
                                        sourceIndex,
                                        "nodeId",
                                        (event.currentTarget as HTMLSelectElement).value.trim(),
                                      )}
                                    disabled={config?.readOnly || busy}
                                  >
                                    <option value="">Select a node</option>
                                    {#each editableBundle.workflow.nodes as node}
                                      <option value={node.id}>{node.id}</option>
                                    {/each}
                                  </select>
                                </div>
                              {:else if source.type === "sub-workflow-output"}
                                <div>
                                  <label for={`sub-workflow-source-ref-${index}-${sourceIndex}`}>Sub-Workflow</label>
                                  <select
                                    id={`sub-workflow-source-ref-${index}-${sourceIndex}`}
                                    value={source.subWorkflowId ?? ""}
                                    on:change={(event) =>
                                      onUpdateSubWorkflowInputSourceField(
                                        index,
                                        sourceIndex,
                                        "subWorkflowId",
                                        (event.currentTarget as HTMLSelectElement).value.trim(),
                                      )}
                                    disabled={config?.readOnly || busy}
                                  >
                                    <option value="">Select a sub-workflow</option>
                                    {#each editableBundle.workflow.subWorkflows.filter((entry) => entry.id !== subWorkflow.id) as entry}
                                      <option value={entry.id}>{entry.id}</option>
                                    {/each}
                                  </select>
                                </div>
                              {/if}
                            </div>
                            <button class="ghost" type="button" on:click={() => onRemoveSubWorkflowInputSource(index, sourceIndex)} disabled={config?.readOnly || busy}>
                              Remove Source
                            </button>
                          </article>
                        {/each}
                      </div>
                    {/if}
                  </div>

                  <button class="ghost" on:click={() => onRemoveSubWorkflow(index)} disabled={config?.readOnly || busy}>
                    Remove Sub-Workflow
                  </button>
                </article>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <p class="empty">Select or create a workflow to inspect it.</p>
  {/if}
</section>
