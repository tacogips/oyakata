<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  type FrontendMode = "legacy-inline" | "svelte-dist";
  type SessionStatus = "running" | "paused" | "completed" | "failed" | "cancelled";
  type NodeKind = "task" | "branch-judge" | "loop-judge" | "root-manager" | "sub-manager" | "manager" | "input" | "output";
  type CompletionType = "checklist" | "score-threshold" | "validator-result" | "none";
  const RESERVED_STRUCTURE_KINDS = new Set<NodeKind>(["root-manager", "sub-manager", "input", "output"]);
  const MANUALLY_ASSIGNABLE_NODE_KINDS: readonly NodeKind[] = ["task", "branch-judge", "loop-judge", "manager"];

  interface UiConfig {
    fixedWorkflowName: string | null;
    readOnly: boolean;
    noExec: boolean;
    frontend: FrontendMode;
  }

  interface WorkflowListResponse {
    workflows: string[];
  }

  interface WorkflowNode {
    id: string;
    label?: string;
    kind?: NodeKind;
    nodeFile: string;
    completion?: {
      type: CompletionType;
    };
  }

  interface WorkflowEdge {
    from: string;
    to: string;
    when: string;
    priority?: number;
  }

  interface LoopRule {
    id: string;
    judgeNodeId: string;
    continueWhen: string;
    exitWhen: string;
    maxIterations?: number;
  }

  interface OutputSelectionPolicy {
    mode: "explicit" | "latest-succeeded" | "latest-any" | "by-loop-iteration";
    nodeExecId?: string;
    loopIteration?: number;
  }

  type SubWorkflowInputSourceType =
    | "human-input"
    | "workflow-output"
    | "node-output"
    | "sub-workflow-output";

  interface SubWorkflowInputSource {
    type: SubWorkflowInputSourceType;
    workflowId?: string;
    nodeId?: string;
    subWorkflowId?: string;
    selectionPolicy?: OutputSelectionPolicy;
  }

  type SubWorkflowBlockType = "plain" | "branch-block" | "loop-body";

  interface SubWorkflowBlock {
    type: SubWorkflowBlockType;
    loopId?: string;
  }

  interface SubWorkflowRef {
    id: string;
    description: string;
    managerNodeId: string;
    inputNodeId: string;
    outputNodeId: string;
    nodeIds: string[];
    inputSources: SubWorkflowInputSource[];
    block?: SubWorkflowBlock;
  }

  interface WorkflowDefaults {
    maxLoopIterations: number;
    nodeTimeoutMs: number;
  }

  interface WorkflowJson {
    workflowId: string;
    description: string;
    defaults: WorkflowDefaults;
    managerNodeId: string;
    subWorkflows: SubWorkflowRef[];
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    loops?: LoopRule[];
  }

  interface WorkflowVisNode {
    id: string;
    order: number;
  }

  interface WorkflowVis {
    nodes: WorkflowVisNode[];
  }

  interface NodePayload {
    id: string;
    executionBackend?: string;
    model: string;
    promptTemplate: string;
    variables: Record<string, unknown>;
    timeoutMs?: number;
  }

  interface WorkflowBundle {
    workflow: WorkflowJson;
    workflowVis: WorkflowVis;
    nodePayloads: Record<string, NodePayload>;
  }

  interface VisualizationEntry {
    id: string;
    indent: number;
    color: string;
  }

  interface ScopeInterval {
    id: string;
    startOrder: number;
    endOrder: number;
  }

  interface NodeUsage {
    isWorkflowManager: boolean;
    managerOf: string[];
    inputOf: string[];
    outputOf: string[];
  }

  interface WorkflowResponse {
    workflowName: string;
    revision: string | null;
    bundle: WorkflowBundle;
    derivedVisualization: VisualizationEntry[];
  }

  interface SessionSummary {
    workflowExecutionId: string;
    sessionId: string;
    workflowName: string;
    status: SessionStatus;
    currentNodeId: string | null;
    nodeExecutionCounter: number;
    startedAt: string;
    endedAt: string | null;
  }

  interface SessionsResponse {
    sessions: SessionSummary[];
  }

  interface SessionTransition {
    from: string;
    to: string;
    when: string;
  }

  interface NodeExecutionRecord {
    nodeId: string;
    nodeExecId: string;
    status: "succeeded" | "failed" | "timed_out" | "cancelled";
    artifactDir: string;
    startedAt: string;
    endedAt: string;
    attempt?: number;
  }

  interface WorkflowSessionState {
    workflowExecutionId: string;
    sessionId: string;
    workflowName: string;
    workflowId: string;
    status: SessionStatus;
    startedAt: string;
    endedAt?: string;
    queue: readonly string[];
    currentNodeId?: string;
    nodeExecutionCounter: number;
    transitions: readonly SessionTransition[];
    nodeExecutions: readonly NodeExecutionRecord[];
    runtimeVariables: Record<string, unknown>;
    lastError?: string;
  }

  interface ValidationIssue {
    severity: "error" | "warning";
    path: string;
    message: string;
  }

  interface ValidationResponse {
    valid: boolean;
    workflowId?: string;
    warnings?: ValidationIssue[];
    issues?: ValidationIssue[];
    error?: string;
  }

  interface SaveWorkflowResponse {
    workflowName: string;
    revision: string;
  }

  interface ExecuteWorkflowResponse {
    workflowExecutionId?: string;
    accepted?: boolean;
    sessionId: string;
    status: SessionStatus;
  }

  interface CancelSessionResponse {
    accepted: boolean;
    status: SessionStatus;
    workflowExecutionId?: string;
    sessionId?: string;
    error?: string;
  }

  interface ErrorResponse {
    error?: string;
    currentRevision?: string | null;
  }

  const SESSION_POLL_INTERVAL_MS = 2_000;

  let config: UiConfig | null = null;
  let workflows: string[] = [];
  let selectedWorkflowName = "";
  let workflow: WorkflowResponse | null = null;
  let editableBundle: WorkflowBundle | null = null;
  let editableDerivedVisualization: VisualizationEntry[] = [];
  let selectedNodeId = "";
  let selectedNode: WorkflowNode | null = null;
  let selectedNodePayload: NodePayload | null = null;
  let nodeVariablesText = "{}";
  let sessions: SessionSummary[] = [];
  let selectedExecutionId = "";
  let selectedSession: WorkflowSessionState | null = null;
  let newWorkflowName = "";
  let validationIssues: ValidationIssue[] = [];
  let validationSummary = "";
  let loading = true;
  let busy = false;
  let errorMessage = "";
  let infoMessage = "";
  let runtimeVariablesText = "{\n  \"topic\": \"demo\"\n}";
  let mockScenarioText = "";
  let maxStepsText = "";
  let maxLoopIterationsText = "";
  let defaultTimeoutText = "";
  let runAsync = true;
  let runDryRun = false;
  let sessionPollTimer: ReturnType<typeof setTimeout> | null = null;
  let newNodeId = "";
  let newNodeKind: NodeKind = "task";

  function isValidWorkflowNameInput(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
  }

  function isValidNodeIdInput(value: string): boolean {
    return /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
  }

  function cloneValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function defaultNodeFile(nodeId: string): string {
    return `node-${nodeId}.json`;
  }

  async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
    const response = await fetch(input, init);
    const payload = (await response.json()) as T & ErrorResponse;
    if (!response.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : `request failed: ${response.status}`);
    }
    return payload;
  }

  async function fetchJsonWithResponse<T>(input: RequestInfo, init?: RequestInit): Promise<{
    response: Response;
    payload: T & ErrorResponse;
  }> {
    const response = await fetch(input, init);
    const payload = (await response.json()) as T & ErrorResponse;
    return { response, payload };
  }

  function clearSessionPoll(): void {
    if (sessionPollTimer !== null) {
      clearTimeout(sessionPollTimer);
      sessionPollTimer = null;
    }
  }

  function executionIdFromSummary(session: SessionSummary): string {
    return session.workflowExecutionId || session.sessionId;
  }

  function executionIdFromState(session: WorkflowSessionState): string {
    return session.workflowExecutionId || session.sessionId;
  }

  function scheduleSessionPoll(sessionId: string, status: SessionStatus): void {
    clearSessionPoll();
    if (status !== "running") {
      return;
    }

    sessionPollTimer = setTimeout(() => {
      void pollSelectedSession(sessionId);
    }, SESSION_POLL_INTERVAL_MS);
  }

  function applyLoadedWorkflow(nextWorkflow: WorkflowResponse): void {
    workflow = nextWorkflow;
    editableBundle = cloneValue(nextWorkflow.bundle);
    editableDerivedVisualization = nextWorkflow.derivedVisualization;

    const preferredNodeId = selectedNodeId;
    const availableNodeIds = new Set(editableBundle.workflow.nodes.map((node) => node.id));
    selectedNodeId = availableNodeIds.has(preferredNodeId)
      ? preferredNodeId
      : (editableBundle.workflow.nodes[0]?.id ?? "");
    syncSelectedNodeState();
  }

  function visualizationForNode(nodeId: string): VisualizationEntry | undefined {
    return editableDerivedVisualization.find((entry) => entry.id === nodeId);
  }

  function orderedNodes(): WorkflowNode[] {
    if (!editableBundle) {
      return [];
    }

    const orderMap = new Map(editableBundle.workflowVis.nodes.map((entry) => [entry.id, entry.order]));
    return [...editableBundle.workflow.nodes].sort((left, right) => {
      const leftOrder = orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.id.localeCompare(right.id);
    });
  }

  function ensureLoops(): LoopRule[] {
    if (!editableBundle) {
      return [];
    }
    editableBundle.workflow.loops ??= [];
    return editableBundle.workflow.loops;
  }

  function nodeExists(nodeId: string): boolean {
    return editableBundle?.workflow.nodes.some((node) => node.id === nodeId) ?? false;
  }

  function nextGeneratedNodeId(): string {
    let counter = (editableBundle?.workflow.nodes.length ?? 0) + 1;
    let candidate = `worker-${counter}`;
    while (nodeExists(candidate)) {
      counter += 1;
      candidate = `worker-${counter}`;
    }
    return candidate;
  }

  function normalizeWorkflowVis(): void {
    if (!editableBundle) {
      return;
    }

    const orderMap = new Map(editableBundle.workflowVis.nodes.map((entry) => [entry.id, entry.order]));
    editableBundle.workflowVis.nodes = editableBundle.workflow.nodes
      .map((node, index) => ({
        id: node.id,
        order: orderMap.get(node.id) ?? index,
      }))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((entry, index) => ({
        id: entry.id,
        order: index,
      }));
  }

  function compareScopeIntervals(left: ScopeInterval, right: ScopeInterval): number {
    const leftSpan = left.endOrder - left.startOrder;
    const rightSpan = right.endOrder - right.startOrder;
    return leftSpan - rightSpan || left.startOrder - right.startOrder || left.id.localeCompare(right.id);
  }

  function colorForSubWorkflow(subWorkflow: SubWorkflowRef): string {
    if (subWorkflow.block?.type === "loop-body") {
      return `loop:${subWorkflow.block.loopId ?? subWorkflow.id}`;
    }
    if (subWorkflow.block?.type === "branch-block") {
      return `branch:${subWorkflow.id}`;
    }
    return `group:${subWorkflow.id}`;
  }

  function preferredGroupScopeColor(
    groupScopes: readonly ScopeInterval[],
    colorByGroupScopeId: ReadonlyMap<string, string>,
  ): string {
    const loopColor = groupScopes
      .map((scope) => colorByGroupScopeId.get(scope.id))
      .find((color): color is string => typeof color === "string" && color.startsWith("loop:"));
    if (loopColor !== undefined) {
      return loopColor;
    }

    const branchColor = groupScopes
      .map((scope) => colorByGroupScopeId.get(scope.id))
      .find((color): color is string => typeof color === "string" && color.startsWith("branch:"));
    if (branchColor !== undefined) {
      return branchColor;
    }

    return colorByGroupScopeId.get(groupScopes[0]?.id ?? "") ?? "default";
  }

  function deriveVisualizationEntries(bundle: WorkflowBundle): VisualizationEntry[] {
    const orderedVisNodes = [...bundle.workflowVis.nodes].sort((left, right) => {
      return left.order - right.order || left.id.localeCompare(right.id);
    });
    const orderByNodeId = new Map<string, number>();
    for (const entry of orderedVisNodes) {
      orderByNodeId.set(entry.id, entry.order);
    }

    const collectScopesForOrder = (order: number, intervals: readonly ScopeInterval[]): ScopeInterval[] => {
      return intervals
        .filter((entry) => entry.startOrder <= order && order <= entry.endOrder)
        .sort(compareScopeIntervals);
    };

    const groupIntervals = bundle.workflow.subWorkflows
      .map((subWorkflow) => {
        const inputOrder = orderByNodeId.get(subWorkflow.inputNodeId);
        const outputOrder = orderByNodeId.get(subWorkflow.outputNodeId);
        if (inputOrder === undefined || outputOrder === undefined || inputOrder > outputOrder) {
          return null;
        }
        return {
          id: subWorkflow.id,
          startOrder: inputOrder,
          endOrder: outputOrder,
        } satisfies ScopeInterval;
      })
      .filter((entry): entry is ScopeInterval => entry !== null)
      .sort(compareScopeIntervals);

    const colorByGroupScopeId = new Map<string, string>();
    bundle.workflow.subWorkflows.forEach((subWorkflow) => {
      colorByGroupScopeId.set(subWorkflow.id, colorForSubWorkflow(subWorkflow));
    });

    const loopIdsRepresentedBySubWorkflow = new Set(
      bundle.workflow.subWorkflows
        .filter((subWorkflow) => subWorkflow.block?.type === "loop-body")
        .map((subWorkflow) => subWorkflow.block?.loopId)
        .filter((loopId): loopId is string => loopId !== undefined),
    );

    const loopIntervals = (bundle.workflow.loops ?? [])
      .filter((loop) => !loopIdsRepresentedBySubWorkflow.has(loop.id))
      .map((loop) => {
        const judgeOrder = orderByNodeId.get(loop.judgeNodeId);
        if (judgeOrder === undefined) {
          return null;
        }
        const continueTargetOrders = bundle.workflow.edges
          .filter((edge) => edge.from === loop.judgeNodeId && edge.when === loop.continueWhen)
          .map((edge) => orderByNodeId.get(edge.to))
          .filter((value): value is number => value !== undefined)
          .filter((value) => value <= judgeOrder);
        if (continueTargetOrders.length === 0) {
          return null;
        }
        return {
          id: loop.id,
          startOrder: Math.min(...continueTargetOrders),
          endOrder: judgeOrder,
        } satisfies ScopeInterval;
      })
      .filter((entry): entry is ScopeInterval => entry !== null)
      .sort(compareScopeIntervals);

    return orderedVisNodes.map((entry) => {
      const loopScopes = collectScopesForOrder(entry.order, loopIntervals);
      const groupScopes = collectScopesForOrder(entry.order, groupIntervals);
      return {
        id: entry.id,
        indent: loopScopes.length + groupScopes.length,
        color:
          loopScopes.length > 0
            ? `loop:${loopScopes[0]?.id ?? ""}`
            : groupScopes.length > 0
              ? preferredGroupScopeColor(groupScopes, colorByGroupScopeId)
              : "default",
      };
    });
  }

  function moveNode(nodeId: string, direction: -1 | 1): void {
    if (!editableBundle) {
      return;
    }

    const ordered = orderedNodes();
    const index = ordered.findIndex((node) => node.id === nodeId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) {
      return;
    }

    const nextOrdered = [...ordered];
    const [moved] = nextOrdered.splice(index, 1);
    if (!moved) {
      return;
    }
    nextOrdered.splice(targetIndex, 0, moved);
    editableBundle.workflowVis.nodes = nextOrdered.map((node, order) => ({ id: node.id, order }));
    markWorkflowEdited();
  }

  function normalizeNodeIds(nodeIds: readonly string[]): string[] {
    const existingIds = new Set(editableBundle?.workflow.nodes.map((node) => node.id) ?? []);
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const nodeId of nodeIds) {
      if (!existingIds.has(nodeId) || seen.has(nodeId)) {
        continue;
      }
      seen.add(nodeId);
      normalized.push(nodeId);
    }
    return normalized;
  }

  function subWorkflowUsageForNode(nodeId: string): NodeUsage {
    if (!editableBundle) {
      return {
        isWorkflowManager: false,
        managerOf: [],
        inputOf: [],
        outputOf: [],
      };
    }

    return {
      isWorkflowManager: editableBundle.workflow.managerNodeId === nodeId,
      managerOf: editableBundle.workflow.subWorkflows
        .filter((subWorkflow) => subWorkflow.managerNodeId === nodeId)
        .map((subWorkflow) => subWorkflow.id),
      inputOf: editableBundle.workflow.subWorkflows
        .filter((subWorkflow) => subWorkflow.inputNodeId === nodeId)
        .map((subWorkflow) => subWorkflow.id),
      outputOf: editableBundle.workflow.subWorkflows
        .filter((subWorkflow) => subWorkflow.outputNodeId === nodeId)
        .map((subWorkflow) => subWorkflow.id),
    };
  }

  function nodeReservedByOtherSubWorkflow(nodeId: string, currentSubWorkflowId: string): boolean {
    const usage = subWorkflowUsageForNode(nodeId);
    return (
      usage.managerOf.some((subWorkflowId) => subWorkflowId !== currentSubWorkflowId) ||
      usage.inputOf.some((subWorkflowId) => subWorkflowId !== currentSubWorkflowId) ||
      usage.outputOf.some((subWorkflowId) => subWorkflowId !== currentSubWorkflowId)
    );
  }

  function syncDerivedWorkflowMetadata(): void {
    if (!editableBundle) {
      editableDerivedVisualization = [];
      return;
    }
    editableDerivedVisualization = deriveVisualizationEntries(editableBundle);
  }

  function syncSubWorkflowNodeKinds(): void {
    if (!editableBundle) {
      return;
    }

    const assignedKinds = new Map<string, NodeKind>();
    assignedKinds.set(editableBundle.workflow.managerNodeId, "root-manager");

    for (const subWorkflow of editableBundle.workflow.subWorkflows) {
      assignedKinds.set(subWorkflow.managerNodeId, "sub-manager");
      assignedKinds.set(subWorkflow.inputNodeId, "input");
      assignedKinds.set(subWorkflow.outputNodeId, "output");
      subWorkflow.nodeIds = normalizeNodeIds([
        ...subWorkflow.nodeIds,
        subWorkflow.managerNodeId,
        subWorkflow.inputNodeId,
        subWorkflow.outputNodeId,
      ]);
    }

    for (const node of editableBundle.workflow.nodes) {
      const assignedKind = assignedKinds.get(node.id);
      if (assignedKind !== undefined) {
        node.kind = assignedKind;
        continue;
      }

      if (node.kind !== undefined && RESERVED_STRUCTURE_KINDS.has(node.kind)) {
        node.kind = "task";
      }
    }
  }

  function nextSubWorkflowId(): string {
    let counter = (editableBundle?.workflow.subWorkflows.length ?? 0) + 1;
    let candidate = `group-${counter}`;
    while (editableBundle?.workflow.subWorkflows.some((subWorkflow) => subWorkflow.id === candidate) ?? false) {
      counter += 1;
      candidate = `group-${counter}`;
    }
    return candidate;
  }

  function renameSubWorkflowReferences(oldId: string, nextId: string): void {
    if (!editableBundle || oldId.length === 0 || nextId.length === 0 || oldId === nextId) {
      return;
    }

    for (const subWorkflow of editableBundle.workflow.subWorkflows) {
      for (const source of subWorkflow.inputSources) {
        if (source.subWorkflowId === oldId) {
          source.subWorkflowId = nextId;
        }
      }
    }
  }

  function removeSubWorkflowReferences(subWorkflowId: string): void {
    if (!editableBundle || subWorkflowId.length === 0) {
      return;
    }

    for (const subWorkflow of editableBundle.workflow.subWorkflows) {
      for (const source of subWorkflow.inputSources) {
        if (source.subWorkflowId === subWorkflowId) {
          source.type = "human-input";
          delete source.subWorkflowId;
          delete source.nodeId;
          delete source.workflowId;
          delete source.selectionPolicy;
        }
      }
    }
  }

  function availableSubWorkflowBoundaryNodes(
    kind: "managerNodeId" | "inputNodeId" | "outputNodeId",
    currentSubWorkflowId: string,
  ): WorkflowNode[] {
    if (!editableBundle) {
      return [];
    }
    const workflow = editableBundle.workflow;
    const currentSubWorkflow = workflow.subWorkflows.find((entry) => entry.id === currentSubWorkflowId);
    return workflow.nodes.filter((node) => {
      if (workflow.managerNodeId === node.id) {
        return false;
      }
      if (nodeReservedByOtherSubWorkflow(node.id, currentSubWorkflowId)) {
        return false;
      }
      if (!currentSubWorkflow) {
        return true;
      }
      const conflictingNodeIds = new Set(
        [currentSubWorkflow.managerNodeId, currentSubWorkflow.inputNodeId, currentSubWorkflow.outputNodeId].filter(
          (value) => value.length > 0,
        ),
      );
      conflictingNodeIds.delete(currentSubWorkflow[kind]);
      return !conflictingNodeIds.has(node.id);
    });
  }

  function availableSubWorkflowMemberNodes(currentSubWorkflowId: string): WorkflowNode[] {
    if (!editableBundle) {
      return [];
    }
    const workflow = editableBundle.workflow;
    return workflow.nodes.filter((node) => {
      if (workflow.managerNodeId === node.id) {
        return false;
      }
      return !nodeReservedByOtherSubWorkflow(node.id, currentSubWorkflowId);
    });
  }

  function workflowManagerCandidateNodes(): WorkflowNode[] {
    if (!editableBundle) {
      return [];
    }
    const workflow = editableBundle.workflow;
    return workflow.nodes.filter((node) => {
      if (node.id === workflow.managerNodeId) {
        return true;
      }
      const usage = subWorkflowUsageForNode(node.id);
      return usage.managerOf.length === 0 && usage.inputOf.length === 0 && usage.outputOf.length === 0;
    });
  }

  function addNode(): void {
    if (!editableBundle || config?.readOnly) {
      return;
    }

    const trimmedId = newNodeId.trim();
    const nodeId = trimmedId.length > 0 ? trimmedId : nextGeneratedNodeId();
    if (!isValidNodeIdInput(nodeId) || nodeExists(nodeId)) {
      errorMessage = `Node id '${nodeId}' is invalid or already exists.`;
      return;
    }

    const node: WorkflowNode = {
      id: nodeId,
      kind: newNodeKind,
      nodeFile: defaultNodeFile(nodeId),
      completion: { type: "none" },
    };
    editableBundle.workflow.nodes = [...editableBundle.workflow.nodes, node];
    editableBundle.nodePayloads[nodeId] = {
      id: nodeId,
      model: "",
      promptTemplate: "",
      variables: {},
    };
    editableBundle.workflowVis.nodes = [...editableBundle.workflowVis.nodes, { id: nodeId, order: editableBundle.workflowVis.nodes.length }];
    normalizeWorkflowVis();
    newNodeId = "";
    selectedNodeId = nodeId;
    markWorkflowEdited({ syncSelectedNode: true });
  }

  function removeNode(nodeId: string): void {
    if (!editableBundle || config?.readOnly) {
      return;
    }
    if (editableBundle.workflow.managerNodeId === nodeId) {
      errorMessage = `Cannot remove manager node '${nodeId}'.`;
      return;
    }

    const removedSubWorkflowIds = editableBundle.workflow.subWorkflows
      .filter((subWorkflow) => {
        return (
          subWorkflow.managerNodeId === nodeId ||
          subWorkflow.inputNodeId === nodeId ||
          subWorkflow.outputNodeId === nodeId
        );
      })
      .map((subWorkflow) => subWorkflow.id);

    editableBundle.workflow.nodes = editableBundle.workflow.nodes.filter((node) => node.id !== nodeId);
    editableBundle.workflow.edges = editableBundle.workflow.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    editableBundle.workflow.loops = ensureLoops().filter((loop) => loop.judgeNodeId !== nodeId);
    editableBundle.workflow.subWorkflows = editableBundle.workflow.subWorkflows
      .filter((subWorkflow) => {
        return (
          subWorkflow.managerNodeId !== nodeId &&
          subWorkflow.inputNodeId !== nodeId &&
          subWorkflow.outputNodeId !== nodeId
        );
      })
      .map((subWorkflow) => ({
        ...subWorkflow,
        nodeIds: subWorkflow.nodeIds.filter((entry) => entry !== nodeId),
        inputSources: subWorkflow.inputSources.map((source) => {
          if (source.nodeId !== nodeId) {
            return source;
          }
          const { nodeId: _nodeId, ...rest } = source;
          return rest;
        }),
      }));
    for (const subWorkflowId of removedSubWorkflowIds) {
      removeSubWorkflowReferences(subWorkflowId);
    }
    editableBundle.workflowVis.nodes = editableBundle.workflowVis.nodes.filter((entry) => entry.id !== nodeId);
    delete editableBundle.nodePayloads[nodeId];
    normalizeWorkflowVis();
    if (selectedNodeId === nodeId) {
      selectedNodeId = editableBundle.workflow.nodes[0]?.id ?? "";
    }
    markWorkflowEdited({ syncSelectedNode: true });
  }

  function addEdge(): void {
    if (!editableBundle || config?.readOnly || editableBundle.workflow.nodes.length < 2) {
      return;
    }

    const ordered = orderedNodes();
    editableBundle.workflow.edges = [
      ...editableBundle.workflow.edges,
      {
        from: ordered[0]?.id ?? "",
        to: ordered[1]?.id ?? "",
        when: "always",
      },
    ];
    markWorkflowEdited();
  }

  function removeEdge(index: number): void {
    if (!editableBundle || config?.readOnly) {
      return;
    }
    editableBundle.workflow.edges = editableBundle.workflow.edges.filter((_, edgeIndex) => edgeIndex !== index);
    markWorkflowEdited();
  }

  function addLoop(): void {
    if (!editableBundle || config?.readOnly) {
      return;
    }

    const judgeNodeId = editableBundle.workflow.nodes.find((node) => node.kind === "loop-judge")?.id ?? "";
    const loops = ensureLoops();
    loops.push({
      id: `loop-${loops.length + 1}`,
      judgeNodeId,
      continueWhen: "retry",
      exitWhen: "done",
    });
    markWorkflowEdited();
  }

  function addSubWorkflow(): void {
    if (!editableBundle || config?.readOnly) {
      return;
    }

    const id = nextSubWorkflowId();
    const managerNode = availableSubWorkflowBoundaryNodes("managerNodeId", id).find((node) => node.kind === "sub-manager");
    const inputNode = availableSubWorkflowBoundaryNodes("inputNodeId", id).find((node) => node.id !== managerNode?.id && node.kind === "input")
      ?? availableSubWorkflowBoundaryNodes("inputNodeId", id).find((node) => node.id !== managerNode?.id);
    const outputNode = availableSubWorkflowBoundaryNodes("outputNodeId", id).find((node) => {
      return node.id !== managerNode?.id && node.id !== inputNode?.id && node.kind === "output";
    }) ?? availableSubWorkflowBoundaryNodes("outputNodeId", id).find((node) => {
      return node.id !== managerNode?.id && node.id !== inputNode?.id;
    });

    if (!managerNode) {
      errorMessage = "Add a dedicated sub-manager node before creating another sub-workflow.";
      return;
    }

    if (!inputNode || !outputNode) {
      errorMessage = "Add at least three non-root nodes before creating another sub-workflow.";
      return;
    }

    editableBundle.workflow.subWorkflows = [
      ...editableBundle.workflow.subWorkflows,
      {
        id,
        description: `${id} sub-workflow`,
        managerNodeId: managerNode.id,
        inputNodeId: inputNode.id,
        outputNodeId: outputNode.id,
        nodeIds: [managerNode.id, inputNode.id, outputNode.id],
        inputSources: [{ type: "human-input" }],
        block: { type: "plain" },
      },
    ];
    syncSubWorkflowNodeKinds();
    markWorkflowEdited();
  }

  function removeSubWorkflow(index: number): void {
    if (!editableBundle || config?.readOnly) {
      return;
    }
    const removedSubWorkflowId = editableBundle.workflow.subWorkflows[index]?.id;
    editableBundle.workflow.subWorkflows = editableBundle.workflow.subWorkflows.filter((_, currentIndex) => currentIndex !== index);
    if (removedSubWorkflowId !== undefined) {
      removeSubWorkflowReferences(removedSubWorkflowId);
    }
    syncSubWorkflowNodeKinds();
    markWorkflowEdited();
  }

  function updateSubWorkflowField(index: number, field: "id" | "description", event: Event): void {
    const subWorkflow = editableBundle?.workflow.subWorkflows[index];
    if (!subWorkflow) {
      return;
    }
    const nextValue = (event.currentTarget as HTMLInputElement).value;
    if (field === "id") {
      const previousId = subWorkflow.id;
      subWorkflow.id = nextValue;
      renameSubWorkflowReferences(previousId, subWorkflow.id);
    } else {
      subWorkflow[field] = nextValue;
    }
    markWorkflowEdited();
  }

  function updateSubWorkflowBlockType(index: number, event: Event): void {
    const subWorkflow = editableBundle?.workflow.subWorkflows[index];
    if (!subWorkflow) {
      return;
    }

    const type = (event.currentTarget as HTMLSelectElement).value as SubWorkflowBlockType;
    if (type === "loop-body") {
      subWorkflow.block = {
        type,
        ...(subWorkflow.block?.loopId !== undefined ? { loopId: subWorkflow.block.loopId } : {}),
      };
    } else {
      subWorkflow.block = { type };
    }
    markWorkflowEdited();
  }

  function updateSubWorkflowBlockLoopId(index: number, event: Event): void {
    const subWorkflow = editableBundle?.workflow.subWorkflows[index];
    if (!subWorkflow || subWorkflow.block?.type !== "loop-body") {
      return;
    }

    const loopId = (event.currentTarget as HTMLSelectElement).value.trim();
    subWorkflow.block = loopId.length === 0
      ? { type: "loop-body" }
      : { type: "loop-body", loopId };
    markWorkflowEdited();
  }

  function updateSubWorkflowBoundary(
    index: number,
    field: "managerNodeId" | "inputNodeId" | "outputNodeId",
    event: Event,
  ): void {
    const subWorkflow = editableBundle?.workflow.subWorkflows[index];
    if (!subWorkflow) {
      return;
    }

    subWorkflow[field] = (event.currentTarget as HTMLSelectElement).value;
    subWorkflow.nodeIds = normalizeNodeIds([
      ...subWorkflow.nodeIds,
      subWorkflow.managerNodeId,
      subWorkflow.inputNodeId,
      subWorkflow.outputNodeId,
    ]);
    syncSubWorkflowNodeKinds();
    markWorkflowEdited();
  }

  function toggleSubWorkflowNodeMembership(index: number, nodeId: string, checked: boolean): void {
    const subWorkflow = editableBundle?.workflow.subWorkflows[index];
    if (!subWorkflow) {
      return;
    }

    if (checked) {
      subWorkflow.nodeIds = normalizeNodeIds([...subWorkflow.nodeIds, nodeId]);
    } else {
      const locked = new Set([subWorkflow.managerNodeId, subWorkflow.inputNodeId, subWorkflow.outputNodeId]);
      if (locked.has(nodeId)) {
        return;
      }
      subWorkflow.nodeIds = normalizeNodeIds(subWorkflow.nodeIds.filter((entry) => entry !== nodeId));
    }
    markWorkflowEdited();
  }

  function addSubWorkflowInputSource(index: number): void {
    const subWorkflow = editableBundle?.workflow.subWorkflows[index];
    if (!subWorkflow) {
      return;
    }
    subWorkflow.inputSources = [...subWorkflow.inputSources, { type: "human-input" }];
    markWorkflowEdited();
  }

  function removeSubWorkflowInputSource(index: number, sourceIndex: number): void {
    const subWorkflow = editableBundle?.workflow.subWorkflows[index];
    if (!subWorkflow) {
      return;
    }
    subWorkflow.inputSources = subWorkflow.inputSources.filter((_, currentIndex) => currentIndex !== sourceIndex);
    markWorkflowEdited();
  }

  function updateSubWorkflowInputSourceType(index: number, sourceIndex: number, event: Event): void {
    const source = editableBundle?.workflow.subWorkflows[index]?.inputSources[sourceIndex];
    if (!source) {
      return;
    }
    const nextType = (event.currentTarget as HTMLSelectElement).value as SubWorkflowInputSourceType;
    source.type = nextType;
    delete source.workflowId;
    delete source.nodeId;
    delete source.subWorkflowId;
    markWorkflowEdited();
  }

  function updateSubWorkflowInputSourceField(
    index: number,
    sourceIndex: number,
    field: "workflowId" | "nodeId" | "subWorkflowId",
    event: Event,
  ): void {
    const source = editableBundle?.workflow.subWorkflows[index]?.inputSources[sourceIndex];
    if (!source) {
      return;
    }

    const value = (event.currentTarget as HTMLInputElement | HTMLSelectElement).value.trim();
    if (value.length === 0) {
      delete source[field];
    } else {
      source[field] = value;
    }
    markWorkflowEdited();
  }

  function removeLoop(index: number): void {
    if (!editableBundle || config?.readOnly) {
      return;
    }
    editableBundle.workflow.loops = ensureLoops().filter((_, loopIndex) => loopIndex !== index);
    markWorkflowEdited();
  }

  function ensureNodePayload(node: WorkflowNode): NodePayload {
    if (!editableBundle) {
      throw new Error("workflow bundle not loaded");
    }

    const existing = editableBundle.nodePayloads[node.id] ?? editableBundle.nodePayloads[node.nodeFile];
    if (existing) {
      if (editableBundle.nodePayloads[node.id] === undefined) {
        editableBundle.nodePayloads[node.id] = cloneValue(existing);
      }
      return editableBundle.nodePayloads[node.id]!;
    }

    const created: NodePayload = {
      id: node.id,
      model: "",
      promptTemplate: "",
      variables: {},
    };
    editableBundle.nodePayloads[node.id] = created;
    return created;
  }

  function syncSelectedNodeState(): void {
    if (!editableBundle || !selectedNodeId) {
      selectedNode = null;
      selectedNodePayload = null;
      nodeVariablesText = "{}";
      return;
    }

    const node = editableBundle.workflow.nodes.find((entry) => entry.id === selectedNodeId) ?? null;
    if (!node) {
      selectedNodeId = "";
      selectedNode = null;
      selectedNodePayload = null;
      nodeVariablesText = "{}";
      return;
    }

    selectedNode = node;
    selectedNodePayload = ensureNodePayload(node);
    nodeVariablesText = JSON.stringify(selectedNodePayload.variables ?? {}, null, 2);
  }

  function clearMessages(): void {
    errorMessage = "";
    infoMessage = "";
  }

  function clearValidation(): void {
    validationIssues = [];
    validationSummary = "";
  }

  function markWorkflowEdited(options?: {
    readonly syncSelectedNode?: boolean;
  }): void {
    if (!editableBundle) {
      return;
    }

    editableBundle = editableBundle;
    syncSubWorkflowNodeKinds();
    syncDerivedWorkflowMetadata();
    clearValidation();
    if (options?.syncSelectedNode === true) {
      syncSelectedNodeState();
    }
  }

  function workflowDirty(): boolean {
    return workflow !== null && editableBundle !== null && JSON.stringify(workflow.bundle) !== JSON.stringify(editableBundle);
  }

  function setSelectedNode(nodeId: string): void {
    selectedNodeId = nodeId;
    syncSelectedNodeState();
  }

  function parseJsonObject(text: string, fieldName: string, emptyValue: Record<string, unknown> = {}): Record<string, unknown> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return emptyValue;
    }

    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${fieldName} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  }

  function parseOptionalInteger(text: string, fieldName: string): number | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`${fieldName} must be a positive integer.`);
    }
    return parsed;
  }

  function combinedValidationIssues(result: ValidationResponse): ValidationIssue[] {
    const merged = [...(result.issues ?? []), ...(result.warnings ?? [])];
    const seen = new Set<string>();
    return merged.filter((issue) => {
      const key = `${issue.severity}:${issue.path}:${issue.message}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function updateDescription(event: Event): void {
    if (!editableBundle) {
      return;
    }

    editableBundle.workflow.description = (event.currentTarget as HTMLTextAreaElement).value;
    markWorkflowEdited();
  }

  function updateManagerNode(event: Event): void {
    if (!editableBundle) {
      return;
    }
    editableBundle.workflow.managerNodeId = (event.currentTarget as HTMLSelectElement).value;
    markWorkflowEdited();
  }

  function updateNodeKind(nodeId: string, event: Event): void {
    if (!editableBundle) {
      return;
    }

    const node = editableBundle.workflow.nodes.find((entry) => entry.id === nodeId);
    if (node) {
      const nextKind = (event.currentTarget as HTMLSelectElement).value as NodeKind;
      if (RESERVED_STRUCTURE_KINDS.has(nextKind)) {
        errorMessage = `Node kind '${nextKind}' is assigned by workflow structure. Edit the manager or sub-workflow boundaries instead.`;
        return;
      }
      node.kind = nextKind;
      markWorkflowEdited();
    }
  }

  function updateNodeCompletion(nodeId: string, event: Event): void {
    if (!editableBundle) {
      return;
    }

    const node = editableBundle.workflow.nodes.find((entry) => entry.id === nodeId);
    if (node) {
      node.completion = { type: (event.currentTarget as HTMLSelectElement).value as CompletionType };
      markWorkflowEdited();
    }
  }

  function updateEdgeField(index: number, field: keyof WorkflowEdge, event: Event): void {
    if (!editableBundle) {
      return;
    }

    const edge = editableBundle.workflow.edges[index];
    if (!edge) {
      return;
    }

    const value = (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
    if (field === "priority") {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        delete edge.priority;
        markWorkflowEdited();
        return;
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        edge.priority = parsed;
        markWorkflowEdited();
      }
      return;
    }

    edge[field] = value;
    markWorkflowEdited();
  }

  function updateLoopField(index: number, field: keyof LoopRule, event: Event): void {
    const loops = editableBundle?.workflow.loops;
    if (!loops) {
      return;
    }

    const loop = loops[index];
    if (!loop) {
      return;
    }

    const value = (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
    if (field === "maxIterations") {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        delete loop.maxIterations;
        markWorkflowEdited();
        return;
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        loop.maxIterations = parsed;
        markWorkflowEdited();
      }
      return;
    }

    loop[field] = value;
    markWorkflowEdited();
  }

  function updateDefaultNumber(field: keyof WorkflowDefaults, event: Event): void {
    if (!editableBundle) {
      return;
    }

    const raw = (event.currentTarget as HTMLInputElement).value.trim();
    const parsed = Number.parseInt(raw, 10);
    editableBundle.workflow.defaults[field] = Number.isFinite(parsed) ? parsed : 0;
    markWorkflowEdited();
  }

  function updateNodePayloadString(field: "executionBackend" | "model" | "promptTemplate", event: Event): void {
    if (!selectedNodePayload) {
      return;
    }

    const value = (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
    if (field === "executionBackend") {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        delete selectedNodePayload.executionBackend;
      } else {
        selectedNodePayload.executionBackend = trimmed;
      }
      markWorkflowEdited();
      return;
    }

    selectedNodePayload[field] = value;
    markWorkflowEdited();
  }

  function updateNodeTimeout(event: Event): void {
    if (!selectedNodePayload) {
      return;
    }

    const raw = (event.currentTarget as HTMLInputElement).value.trim();
    if (raw.length === 0) {
      delete selectedNodePayload.timeoutMs;
      markWorkflowEdited();
      return;
    }

    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      selectedNodePayload.timeoutMs = parsed;
      markWorkflowEdited();
    }
  }

  function syncVariablesText(event: Event): void {
    nodeVariablesText = (event.currentTarget as HTMLTextAreaElement).value;
  }

  function syncSelectedNodeVariablesOrThrow(): void {
    if (!selectedNodePayload) {
      return;
    }

    selectedNodePayload.variables = parseJsonObject(nodeVariablesText, "Node variables");
    markWorkflowEdited();
  }

  async function loadConfig(): Promise<void> {
    config = await fetchJson<UiConfig>("/api/ui-config");
  }

  async function loadWorkflowNames(): Promise<void> {
    const payload = await fetchJson<WorkflowListResponse>("/api/workflows");
    workflows = payload.workflows;

    if (config?.fixedWorkflowName) {
      selectedWorkflowName = config.fixedWorkflowName;
      return;
    }

    if (!workflows.includes(selectedWorkflowName)) {
      selectedWorkflowName = workflows[0] ?? "";
    }
  }

  async function loadSessions(workflowName: string): Promise<void> {
    const payload = await fetchJson<SessionsResponse>("/api/sessions");
    sessions = payload.sessions
      .filter((entry) => entry.workflowName === workflowName)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    if (selectedExecutionId && !sessions.some((entry) => executionIdFromSummary(entry) === selectedExecutionId)) {
      selectedExecutionId = "";
      selectedSession = null;
      clearSessionPoll();
    }
  }

  async function loadSelectedSession(workflowExecutionId: string, allowPolling = true): Promise<void> {
    const payload = await fetchJson<WorkflowSessionState>(
      `/api/workflow-executions/${encodeURIComponent(workflowExecutionId)}`,
    );
    selectedExecutionId = executionIdFromState(payload);
    selectedSession = payload;
    scheduleSessionPoll(executionIdFromState(payload), allowPolling ? payload.status : "completed");
  }

  async function loadWorkflow(name: string): Promise<void> {
    if (!name) {
      workflow = null;
      editableBundle = null;
      selectedNodeId = "";
      selectedNode = null;
      selectedNodePayload = null;
      editableDerivedVisualization = [];
      sessions = [];
      selectedExecutionId = "";
      selectedSession = null;
      clearSessionPoll();
      clearValidation();
      return;
    }

    const payload = await fetchJson<WorkflowResponse>(`/api/workflows/${encodeURIComponent(name)}`);
    applyLoadedWorkflow(payload);
    clearValidation();
    await loadSessions(name);
    if (selectedExecutionId) {
      await loadSelectedSession(selectedExecutionId, true);
    }
  }

  async function refresh(): Promise<void> {
    loading = true;
    clearMessages();

    try {
      await loadConfig();
      await loadWorkflowNames();
      if (selectedWorkflowName) {
        await loadWorkflow(selectedWorkflowName);
      } else {
        workflow = null;
        editableBundle = null;
        editableDerivedVisualization = [];
        sessions = [];
        selectedSession = null;
        selectedExecutionId = "";
        clearSessionPoll();
        clearValidation();
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  async function selectWorkflow(workflowName: string): Promise<void> {
    selectedWorkflowName = workflowName;
    clearMessages();

    try {
      busy = true;
      selectedExecutionId = "";
      selectedSession = null;
      clearSessionPoll();
      await loadWorkflow(selectedWorkflowName);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function handleWorkflowSelection(event: Event): Promise<void> {
    const target = event.currentTarget as HTMLSelectElement;
    await selectWorkflow(target.value);
  }

  async function createWorkflow(): Promise<void> {
    const workflowName = newWorkflowName.trim();
    if (!isValidWorkflowNameInput(workflowName) || config?.readOnly || config?.fixedWorkflowName) {
      return;
    }

    busy = true;
    clearMessages();

    try {
      const created = await fetchJson<WorkflowResponse>("/api/workflows", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ workflowName }),
      });

      newWorkflowName = "";
      await loadWorkflowNames();
      selectedWorkflowName = created.workflowName;
      selectedSession = null;
      selectedExecutionId = "";
      clearSessionPoll();
      applyLoadedWorkflow(created);
      await loadSessions(created.workflowName);
      infoMessage = `Created workflow '${created.workflowName}'.`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function validateWorkflow(): Promise<void> {
    if (!editableBundle || !selectedWorkflowName) {
      return;
    }

    busy = true;
    clearMessages();

    try {
      syncSelectedNodeVariablesOrThrow();
      const result = await fetchJson<ValidationResponse>(
        `/api/workflows/${encodeURIComponent(selectedWorkflowName)}/validate`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ bundle: editableBundle }),
        },
      );

      validationIssues = combinedValidationIssues(result);
      const warningCount = validationIssues.filter((issue) => issue.severity === "warning").length;
      const errorCount = validationIssues.length - warningCount;
      validationSummary = result.valid
        ? `Validation passed${warningCount > 0 ? ` with ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}.`
        : `Validation returned ${errorCount} error${errorCount === 1 ? "" : "s"} and ${warningCount} warning${warningCount === 1 ? "" : "s"}.`;
      infoMessage = validationSummary;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      validationSummary = "";
    } finally {
      busy = false;
    }
  }

  async function saveWorkflow(): Promise<void> {
    if (!editableBundle || !selectedWorkflowName || config?.readOnly) {
      return;
    }

    busy = true;
    clearMessages();

    try {
      syncSelectedNodeVariablesOrThrow();
      const { response, payload } = await fetchJsonWithResponse<SaveWorkflowResponse>(
        `/api/workflows/${encodeURIComponent(selectedWorkflowName)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            bundle: editableBundle,
            expectedRevision: workflow?.revision ?? undefined,
          }),
        },
      );

      if (!response.ok) {
        if (response.status === 409 && payload.currentRevision) {
          throw new Error(`Workflow revision conflict. Current revision is ${payload.currentRevision}. Reload and retry.`);
        }
        throw new Error(typeof payload.error === "string" ? payload.error : `request failed: ${response.status}`);
      }

      await loadWorkflow(selectedWorkflowName);
      infoMessage = `Saved workflow '${payload.workflowName}' at revision ${payload.revision}.`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function refreshSessions(): Promise<void> {
    if (!selectedWorkflowName) {
      return;
    }

    busy = true;
    clearMessages();

    try {
      await loadSessions(selectedWorkflowName);
      if (selectedExecutionId) {
        await loadSelectedSession(selectedExecutionId, true);
      }
      infoMessage = `Refreshed sessions for '${selectedWorkflowName}'.`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function selectSession(workflowExecutionId: string): Promise<void> {
    clearMessages();

    try {
      busy = true;
      await loadSelectedSession(workflowExecutionId, true);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function pollSelectedSession(workflowExecutionId: string): Promise<void> {
    if (selectedExecutionId !== workflowExecutionId || selectedWorkflowName.length === 0) {
      return;
    }

    try {
      await loadSelectedSession(workflowExecutionId, true);
      await loadSessions(selectedWorkflowName);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      scheduleSessionPoll(workflowExecutionId, "running");
    }
  }

  async function executeWorkflow(): Promise<void> {
    if (!selectedWorkflowName || config?.noExec) {
      return;
    }

    busy = true;
    clearMessages();

    try {
      const runtimeVariables = parseJsonObject(runtimeVariablesText, "Runtime variables");
      const mockScenario = parseJsonObject(mockScenarioText, "Mock scenario");
      const maxSteps = parseOptionalInteger(maxStepsText, "Max steps");
      const maxLoopIterations = parseOptionalInteger(maxLoopIterationsText, "Max loop iterations");
      const defaultTimeoutMs = parseOptionalInteger(defaultTimeoutText, "Default timeout");

      const body: Record<string, unknown> = {
        runtimeVariables,
        async: runAsync,
      };

      if (Object.keys(mockScenario).length > 0) {
        body["mockScenario"] = mockScenario;
      }
      if (maxSteps !== undefined) {
        body["maxSteps"] = maxSteps;
      }
      if (maxLoopIterations !== undefined) {
        body["maxLoopIterations"] = maxLoopIterations;
      }
      if (defaultTimeoutMs !== undefined) {
        body["defaultTimeoutMs"] = defaultTimeoutMs;
      }
      if (runDryRun) {
        body["dryRun"] = true;
      }

      const result = await fetchJson<ExecuteWorkflowResponse>(
        `/api/workflows/${encodeURIComponent(selectedWorkflowName)}/execute`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      const workflowExecutionId = result.workflowExecutionId ?? result.sessionId;
      await loadSessions(selectedWorkflowName);
      await loadSelectedSession(workflowExecutionId, true);
      infoMessage = result.accepted === true
        ? `Execution accepted for '${selectedWorkflowName}' as execution ${workflowExecutionId}.`
        : `Execution ${workflowExecutionId} completed with session ${result.sessionId} in status ${result.status}.`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function cancelSelectedSession(): Promise<void> {
    if (!selectedSession || config?.noExec) {
      return;
    }

    busy = true;
    clearMessages();

    try {
      const result = await fetchJson<CancelSessionResponse>(
        `/api/workflow-executions/${encodeURIComponent(executionIdFromState(selectedSession))}/cancel`,
        {
          method: "POST",
        },
      );
      await loadSessions(selectedWorkflowName);
      await loadSelectedSession(selectedExecutionId, false);
      infoMessage = result.accepted
        ? `Cancelled execution ${selectedExecutionId}.`
        : `Execution ${selectedExecutionId} is already ${result.status}.`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  function sessionStatusClass(status: SessionStatus): string {
    switch (status) {
      case "completed":
        return "ok";
      case "failed":
      case "cancelled":
        return "error";
      case "paused":
        return "warning";
      default:
        return "running";
    }
  }

  function canCancelSelectedSession(): boolean {
    return selectedSession !== null && selectedSession.status !== "completed" && selectedSession.status !== "failed" && selectedSession.status !== "cancelled";
  }

  onMount(async () => {
    await refresh();
  });

  onDestroy(() => {
    clearSessionPoll();
  });
</script>

<svelte:head>
  <title>oyakata Svelte UI</title>
</svelte:head>

<div class="page">
  <header class="hero">
    <div>
      <p class="eyebrow">Workflow Editor Migration</p>
      <h1>oyakata Svelte UI</h1>
      <p class="lede">
        This iteration moves the structure editor closer to parity by keeping execution controls while adding editable sub-workflows and reactive vertical grouping feedback.
      </p>
    </div>
    <div class="hero-actions">
      <button class="ghost" on:click={refresh} disabled={loading || busy}>Reload</button>
    </div>
  </header>

  {#if config}
    <section class="modes">
      {#if config.fixedWorkflowName}
        <span class="badge">Fixed workflow: {config.fixedWorkflowName}</span>
      {/if}
      {#if config.readOnly}
        <span class="badge warn">Read-only</span>
      {/if}
      {#if config.noExec}
        <span class="badge warn">Execution disabled</span>
      {/if}
      <span class="badge subtle">Frontend mode: {config.frontend}</span>
    </section>
  {/if}

  {#if errorMessage}
    <p class="message error">{errorMessage}</p>
  {/if}

  {#if infoMessage}
    <p class="message info">{infoMessage}</p>
  {/if}

  <main class="layout">
    <section class="panel side-panel">
      <h2>Workflows</h2>
      <label for="workflow">Select Workflow</label>
      <select id="workflow" bind:value={selectedWorkflowName} on:change={handleWorkflowSelection} disabled={loading || busy}>
        <option value="">Select a workflow</option>
        {#each workflows as workflowName}
          <option value={workflowName}>{workflowName}</option>
        {/each}
      </select>

      <div class="create">
        <label for="new-workflow">Create Workflow</label>
        <input
          id="new-workflow"
          bind:value={newWorkflowName}
          placeholder="workflow-name"
          disabled={config?.readOnly || Boolean(config?.fixedWorkflowName) || busy}
        />
        <button
          class="secondary"
          on:click={createWorkflow}
          disabled={!isValidWorkflowNameInput(newWorkflowName.trim()) || config?.readOnly || Boolean(config?.fixedWorkflowName) || busy}
        >
          Create
        </button>
      </div>

      <div class="toolbar-grid">
        <button class="ghost" on:click={validateWorkflow} disabled={!editableBundle || busy}>Validate</button>
        <button on:click={saveWorkflow} disabled={!editableBundle || !workflowDirty() || config?.readOnly || busy}>Save</button>
        <button class="ghost" on:click={refreshSessions} disabled={!selectedWorkflowName || busy}>Refresh Sessions</button>
      </div>

      <div class="list">
        {#if workflows.length === 0}
          <p class="empty">No workflows found.</p>
        {:else}
          {#each workflows as workflowName}
            <button
              class:selected={workflowName === selectedWorkflowName}
              class="workflow-link ghost"
              on:click={() => selectWorkflow(workflowName)}
            >
              {workflowName}
            </button>
          {/each}
        {/if}
      </div>
    </section>

    <section class="panel main-panel">
      <div class="section-head">
        <div>
          <h2>Workflow Editor</h2>
          {#if workflow}
            <p class="subtle">
              {workflow.workflowName} · revision {workflow.revision ?? "none"} · {workflowDirty() ? "unsaved changes" : "saved"}
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
              on:input={updateDescription}
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
                  on:input={(event) => updateDefaultNumber("maxLoopIterations", event)}
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
                  on:input={(event) => updateDefaultNumber("nodeTimeoutMs", event)}
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
                    on:change={updateManagerNode}
                    disabled={config?.readOnly || busy}
                  >
                    {#each workflowManagerCandidateNodes() as node}
                      <option value={node.id}>{node.id}</option>
                    {/each}
                  </select>
                </div>
              </div>

              <div class="section-head">
                <h3>Node Actions</h3>
                <button class="ghost" on:click={addNode} disabled={config?.readOnly || busy}>Add Node</button>
              </div>
              <div class="property-grid">
                <div>
                  <label for="new-node-id">New Node ID</label>
                  <input
                    id="new-node-id"
                    bind:value={newNodeId}
                    placeholder={nextGeneratedNodeId()}
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
              {#each orderedNodes() as node}
                {@const view = visualizationForNode(node.id)}
                {@const payload = editableBundle.nodePayloads[node.id] ?? editableBundle.nodePayloads[node.nodeFile]}
                <div
                  class:selected={node.id === selectedNodeId}
                  class="node-card ghost"
                  on:click={() => setSelectedNode(node.id)}
                  on:keydown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedNode(node.id);
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
                      on:click|stopPropagation={() => moveNode(node.id, -1)}
                      disabled={config?.readOnly || busy || orderedNodes()[0]?.id === node.id}
                    >
                      Up
                    </button>
                    <button
                      class="ghost"
                      type="button"
                      on:click|stopPropagation={() => moveNode(node.id, 1)}
                      disabled={config?.readOnly || busy || orderedNodes()[orderedNodes().length - 1]?.id === node.id}
                    >
                      Down
                    </button>
                    <button
                      class="ghost"
                      type="button"
                      on:click|stopPropagation={() => removeNode(node.id)}
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
                      on:change={(event) => updateNodeKind(activeNode.id, event)}
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
                    on:change={(event) => updateNodeCompletion(activeNode.id, event)}
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
                    on:input={(event) => updateNodePayloadString("executionBackend", event)}
                    disabled={config?.readOnly || busy}
                  />
                </div>
                <div>
                  <label for="model">Model</label>
                  <input
                    id="model"
                    value={selectedNodePayload.model}
                    placeholder="gpt-5 / claude-sonnet-4-5 / claude-opus-4-1"
                    on:input={(event) => updateNodePayloadString("model", event)}
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
                    on:input={updateNodeTimeout}
                    disabled={config?.readOnly || busy}
                  />
                </div>
              </div>

              <label for="prompt-template">Prompt Template</label>
              <textarea
                id="prompt-template"
                value={selectedNodePayload.promptTemplate}
                on:input={(event) => updateNodePayloadString("promptTemplate", event)}
                disabled={config?.readOnly || busy}
              ></textarea>

              <label for="variables">Variables JSON</label>
              <textarea
                id="variables"
                class="code"
                value={nodeVariablesText}
                on:input={syncVariablesText}
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
                <button class="ghost" on:click={addEdge} disabled={config?.readOnly || busy || editableBundle.workflow.nodes.length < 2}>
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
                            on:change={(event) => updateEdgeField(index, "from", event)}
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
                            on:change={(event) => updateEdgeField(index, "to", event)}
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
                            on:input={(event) => updateEdgeField(index, "when", event)}
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
                            on:input={(event) => updateEdgeField(index, "priority", event)}
                            disabled={config?.readOnly || busy}
                          />
                        </div>
                      </div>
                      <button class="ghost" on:click={() => removeEdge(index)} disabled={config?.readOnly || busy}>Remove Edge</button>
                    </article>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="structure-block">
              <div class="section-head">
                <h3>Loops</h3>
                <button class="ghost" on:click={addLoop} disabled={config?.readOnly || busy}>Add Loop</button>
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
                            on:input={(event) => updateLoopField(index, "id", event)}
                            disabled={config?.readOnly || busy}
                          />
                        </div>
                        <div>
                          <label for={`loop-judge-${index}`}>Judge Node</label>
                          <select
                            id={`loop-judge-${index}`}
                            value={loop.judgeNodeId}
                            on:change={(event) => updateLoopField(index, "judgeNodeId", event)}
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
                            on:input={(event) => updateLoopField(index, "continueWhen", event)}
                            disabled={config?.readOnly || busy}
                          />
                        </div>
                        <div>
                          <label for={`loop-exit-${index}`}>Exit When</label>
                          <input
                            id={`loop-exit-${index}`}
                            value={loop.exitWhen}
                            on:input={(event) => updateLoopField(index, "exitWhen", event)}
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
                            on:input={(event) => updateLoopField(index, "maxIterations", event)}
                            disabled={config?.readOnly || busy}
                          />
                        </div>
                      </div>
                      <button class="ghost" on:click={() => removeLoop(index)} disabled={config?.readOnly || busy}>Remove Loop</button>
                    </article>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="structure-block">
              <div class="section-head">
                <h3>Sub-Workflows</h3>
                <button class="ghost" on:click={addSubWorkflow} disabled={config?.readOnly || busy}>Add Sub-Workflow</button>
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
                            on:input={(event) => updateSubWorkflowField(index, "id", event)}
                            disabled={config?.readOnly || busy}
                          />
                        </div>
                        <div>
                          <label for={`sub-workflow-description-${index}`}>Description</label>
                          <input
                            id={`sub-workflow-description-${index}`}
                            value={subWorkflow.description}
                            on:input={(event) => updateSubWorkflowField(index, "description", event)}
                            disabled={config?.readOnly || busy}
                          />
                        </div>
                        <div>
                          <label for={`sub-workflow-block-type-${index}`}>Block Type</label>
                          <select
                            id={`sub-workflow-block-type-${index}`}
                            value={subWorkflow.block?.type ?? "plain"}
                            on:change={(event) => updateSubWorkflowBlockType(index, event)}
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
                              on:change={(event) => updateSubWorkflowBlockLoopId(index, event)}
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
                            on:change={(event) => updateSubWorkflowBoundary(index, "managerNodeId", event)}
                            disabled={config?.readOnly || busy}
                          >
                            {#each availableSubWorkflowBoundaryNodes("managerNodeId", subWorkflow.id) as node}
                              <option value={node.id}>{node.id}</option>
                            {/each}
                          </select>
                        </div>
                        <div>
                          <label for={`sub-workflow-input-${index}`}>Input Node</label>
                          <select
                            id={`sub-workflow-input-${index}`}
                            value={subWorkflow.inputNodeId}
                            on:change={(event) => updateSubWorkflowBoundary(index, "inputNodeId", event)}
                            disabled={config?.readOnly || busy}
                          >
                            {#each availableSubWorkflowBoundaryNodes("inputNodeId", subWorkflow.id) as node}
                              <option value={node.id}>{node.id}</option>
                            {/each}
                          </select>
                        </div>
                        <div>
                          <label for={`sub-workflow-output-${index}`}>Output Node</label>
                          <select
                            id={`sub-workflow-output-${index}`}
                            value={subWorkflow.outputNodeId}
                            on:change={(event) => updateSubWorkflowBoundary(index, "outputNodeId", event)}
                            disabled={config?.readOnly || busy}
                          >
                            {#each availableSubWorkflowBoundaryNodes("outputNodeId", subWorkflow.id) as node}
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
                          {#each availableSubWorkflowMemberNodes(subWorkflow.id) as node}
                            {@const lockedBoundary = node.id === subWorkflow.managerNodeId || node.id === subWorkflow.inputNodeId || node.id === subWorkflow.outputNodeId}
                            <label class:locked={lockedBoundary} class="check-chip">
                              <input
                                type="checkbox"
                                checked={subWorkflow.nodeIds.includes(node.id)}
                                disabled={config?.readOnly || busy || lockedBoundary}
                                on:change={(event) =>
                                  toggleSubWorkflowNodeMembership(index, node.id, (event.currentTarget as HTMLInputElement).checked)}
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
                          <button class="ghost" type="button" on:click={() => addSubWorkflowInputSource(index)} disabled={config?.readOnly || busy}>
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
                                      on:change={(event) => updateSubWorkflowInputSourceType(index, sourceIndex, event)}
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
                                        on:input={(event) => updateSubWorkflowInputSourceField(index, sourceIndex, "workflowId", event)}
                                        disabled={config?.readOnly || busy}
                                      />
                                    </div>
                                  {:else if source.type === "node-output"}
                                    <div>
                                      <label for={`sub-workflow-source-node-${index}-${sourceIndex}`}>Node</label>
                                      <select
                                        id={`sub-workflow-source-node-${index}-${sourceIndex}`}
                                        value={source.nodeId ?? ""}
                                        on:change={(event) => updateSubWorkflowInputSourceField(index, sourceIndex, "nodeId", event)}
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
                                        on:change={(event) => updateSubWorkflowInputSourceField(index, sourceIndex, "subWorkflowId", event)}
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
                                <button class="ghost" type="button" on:click={() => removeSubWorkflowInputSource(index, sourceIndex)} disabled={config?.readOnly || busy}>
                                  Remove Source
                                </button>
                              </article>
                            {/each}
                          </div>
                        {/if}
                      </div>

                      <button class="ghost" on:click={() => removeSubWorkflow(index)} disabled={config?.readOnly || busy}>
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

    <section class="panel side-panel">
      <h2>Execution</h2>
      {#if selectedWorkflowName === ""}
        <p class="empty">Choose a workflow to run or inspect sessions.</p>
      {:else}
        <div class="execution-form">
          <label for="runtime-variables">Runtime Variables JSON</label>
          <textarea
            id="runtime-variables"
            class="code compact"
            bind:value={runtimeVariablesText}
            spellcheck="false"
            disabled={config?.noExec || busy}
          ></textarea>

          <label for="mock-scenario">Mock Scenario JSON</label>
          <textarea
            id="mock-scenario"
            class="code compact"
            bind:value={mockScenarioText}
            placeholder={`{"node-id":{"provider":"scenario-mock","when":{"always":true},"payload":{"stage":"demo"}}}`}
            spellcheck="false"
            disabled={config?.noExec || busy}
          ></textarea>

          <div class="property-grid execution-grid">
            <div>
              <label for="max-steps">Max Steps</label>
              <input id="max-steps" bind:value={maxStepsText} placeholder="optional" disabled={config?.noExec || busy} />
            </div>
            <div>
              <label for="max-loop">Max Loop Iterations</label>
              <input id="max-loop" bind:value={maxLoopIterationsText} placeholder="optional" disabled={config?.noExec || busy} />
            </div>
            <div>
              <label for="run-timeout">Default Timeout (ms)</label>
              <input id="run-timeout" bind:value={defaultTimeoutText} placeholder="optional" disabled={config?.noExec || busy} />
            </div>
          </div>

          <label class="toggle">
            <input type="checkbox" bind:checked={runAsync} disabled={config?.noExec || busy} />
            <span>Run asynchronously and poll selected session</span>
          </label>

          <label class="toggle">
            <input type="checkbox" bind:checked={runDryRun} disabled={config?.noExec || busy} />
            <span>Dry run</span>
          </label>

          <div class="toolbar-grid single-row">
            <button class="secondary" on:click={executeWorkflow} disabled={config?.noExec || busy}>Run Workflow</button>
            <button class="ghost" on:click={cancelSelectedSession} disabled={config?.noExec || busy || !canCancelSelectedSession()}>
              Cancel Selected
            </button>
          </div>
        </div>

        <div class="sessions">
          <div class="section-head">
            <h3>Recent Sessions</h3>
            <span>{sessions.length}</span>
          </div>
          {#if sessions.length === 0}
            <p class="empty">No sessions recorded for {selectedWorkflowName}.</p>
          {:else}
            {#each sessions as session}
              <button
                class:selected={executionIdFromSummary(session) === selectedExecutionId}
                class="session-card ghost"
                on:click={() => selectSession(executionIdFromSummary(session))}
              >
                <div class="session-head">
                  <strong class={sessionStatusClass(session.status)}>{session.status}</strong>
                  <span>{session.currentNodeId ?? "no active node"}</span>
                </div>
                <div class="session-meta">{session.sessionId}</div>
                <div class="session-meta">Executions: {session.nodeExecutionCounter}</div>
                <div class="session-meta">Started: {session.startedAt}</div>
              </button>
            {/each}
          {/if}
        </div>

        <div class="session-detail">
          <div class="section-head">
            <h3>Selected Session</h3>
            {#if selectedSession}
              <span class={`badge ${sessionStatusClass(selectedSession.status)}`}>{selectedSession.status}</span>
            {/if}
          </div>

          {#if selectedSession}
            <div class="detail-grid">
              <div>
                <span class="detail-label">Execution ID</span>
                <code>{selectedSession.workflowExecutionId}</code>
              </div>
              <div>
                <span class="detail-label">Session ID</span>
                <code>{selectedSession.sessionId}</code>
              </div>
              <div>
                <span class="detail-label">Current Node</span>
                <code>{selectedSession.currentNodeId ?? "-"}</code>
              </div>
              <div>
                <span class="detail-label">Queue</span>
                <code>{selectedSession.queue.length > 0 ? selectedSession.queue.join(", ") : "-"}</code>
              </div>
              <div>
                <span class="detail-label">Transitions</span>
                <code>{selectedSession.transitions.length}</code>
              </div>
            </div>

            {#if selectedSession.lastError}
              <p class="message error compact-message">{selectedSession.lastError}</p>
            {/if}

            <p class="detail-label">Runtime Variables</p>
            <pre>{JSON.stringify(selectedSession.runtimeVariables, null, 2)}</pre>

            <div class="execution-history">
              <div class="section-head">
                <h3>Node Executions</h3>
                <span>{selectedSession.nodeExecutions.length}</span>
              </div>
              {#if selectedSession.nodeExecutions.length === 0}
                <p class="empty">No node executions recorded yet.</p>
              {:else}
                {#each [...selectedSession.nodeExecutions].reverse() as execution}
                  <article class="history-card">
                    <div class="session-head">
                      <strong>{execution.nodeId}</strong>
                      <span class={execution.status}>{execution.status}</span>
                    </div>
                    <div class="session-meta">{execution.nodeExecId}</div>
                    <div class="session-meta">Started: {execution.startedAt}</div>
                    <div class="session-meta">Ended: {execution.endedAt}</div>
                  </article>
                {/each}
              {/if}
            </div>
          {:else}
            <p class="empty">Select a session to inspect status, queue, and node execution history.</p>
          {/if}
        </div>
      {/if}
    </section>
  </main>
</div>

<style>
  .page {
    max-width: 1440px;
    margin: 0 auto;
    padding: 1.5rem;
  }

  .hero {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    margin-bottom: 1rem;
  }

  .hero-actions {
    display: flex;
    align-items: center;
  }

  .eyebrow {
    margin: 0 0 0.35rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 0.76rem;
    font-weight: 700;
  }

  h1,
  h2,
  h3,
  p {
    margin-top: 0;
  }

  h1 {
    margin-bottom: 0.5rem;
    font-size: clamp(2rem, 4vw, 3.2rem);
    line-height: 0.95;
  }

  h2 {
    margin-bottom: 0.75rem;
  }

  .lede,
  .subtle,
  .detail-label {
    color: var(--muted);
  }

  .layout {
    display: grid;
    grid-template-columns: 20rem minmax(0, 1fr) 23rem;
    gap: 1rem;
    align-items: start;
  }

  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 1.25rem;
    padding: 1rem;
    box-shadow: var(--shadow);
    backdrop-filter: blur(8px);
  }

  .side-panel {
    position: sticky;
    top: 1rem;
  }

  .main-panel {
    min-width: 0;
  }

  .modes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .badge {
    border-radius: 999px;
    padding: 0.35rem 0.7rem;
    background: rgba(139, 61, 22, 0.12);
    color: var(--text);
    font-size: 0.85rem;
  }

  .badge.warn,
  .error {
    background: rgba(160, 48, 48, 0.12);
  }

  .badge.subtle,
  .ok {
    background: rgba(45, 91, 70, 0.12);
  }

  .warning {
    color: #8a5f00;
  }

  .running {
    color: var(--accent-2);
  }

  .message {
    border-radius: 1rem;
    padding: 0.85rem 1rem;
    margin-bottom: 1rem;
  }

  .compact-message {
    margin-top: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .message.error {
    color: var(--danger);
  }

  .message.info {
    background: rgba(45, 91, 70, 0.12);
  }

  .create,
  .list,
  .nodes,
  .sessions,
  .issues,
  .execution-form,
  .session-detail,
  .execution-history {
    display: grid;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .toolbar-grid,
  .defaults-grid,
  .property-grid,
  .detail-grid {
    display: grid;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .toolbar-grid,
  .defaults-grid,
  .detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .property-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .single-row {
    grid-template-columns: 1fr 1fr;
  }

  .workflow-link,
  .node-card,
  .session-card {
    justify-content: flex-start;
    border-radius: 1rem;
    text-align: left;
    display: grid;
    gap: 0.35rem;
    width: 100%;
  }

  .node-card {
    cursor: pointer;
  }

  .workflow-link.selected,
  .node-card.selected,
  .session-card.selected {
    border-color: rgba(139, 61, 22, 0.45);
    background: rgba(139, 61, 22, 0.12);
  }

  .section-head,
  .node-head,
  .node-meta,
  .node-actions,
  .issue-head,
  .session-head {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: center;
  }

  .editor-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }

  .editor-column {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .node-kind,
  .session-meta,
  .detail-label {
    font-size: 0.85rem;
  }

  .execution-grid {
    margin-top: 0;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: var(--text);
  }

  .toggle input {
    width: auto;
    margin: 0;
  }

  .history-card,
  .issue-card {
    border: 1px solid var(--line);
    border-radius: 1rem;
    padding: 0.85rem;
    background: rgba(255, 255, 255, 0.62);
  }

  .issue-card.error {
    border-color: rgba(160, 48, 48, 0.3);
  }

  .issue-card.warning {
    border-color: rgba(138, 95, 0, 0.3);
  }

  .detail-grid code,
  pre {
    display: block;
    border-radius: 1rem;
    padding: 0.85rem;
    background: #12211a;
    color: #e4f0e5;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .code {
    font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
  }

  .compact {
    min-height: 8rem;
  }

  .empty {
    color: var(--muted);
  }

  @media (max-width: 1180px) {
    .layout {
      grid-template-columns: 1fr;
    }

    .side-panel {
      position: static;
    }
  }

  @media (max-width: 760px) {
    .page {
      padding: 1rem;
    }

    .hero,
    .section-head,
    .node-head,
    .node-meta,
    .session-head {
      flex-direction: column;
      align-items: flex-start;
    }

    .editor-grid,
    .toolbar-grid,
    .defaults-grid,
    .property-grid,
    .detail-grid,
    .single-row {
      grid-template-columns: 1fr;
    }
  }
</style>
