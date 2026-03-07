import { err, ok, type Result } from "./result";
import {
  DEFAULT_MAX_LOOP_ITERATIONS,
  DEFAULT_NODE_TIMEOUT_MS,
  NODE_ID_PATTERN,
  type ArgumentBinding,
  type CliAgentBackend,
  type CompletionRule,
  type LoopRule,
  type NodeExecutionBackend,
  type NodePayload,
  type NormalizedWorkflowBundle,
  type SubWorkflowConversation,
  type SubWorkflowInputSource,
  type SubWorkflowRef,
  type ValidationIssue,
  type VisNode,
  type WorkflowEdge,
  type WorkflowJson,
  type WorkflowNodeRef,
  type WorkflowVisJson,
} from "./types";

interface RawBundle {
  readonly workflow: unknown;
  readonly workflowVis: unknown;
  readonly nodePayloads: Readonly<Record<string, unknown>>;
}

interface LegacyLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface NormalizedVisNodeCandidate {
  readonly id: string;
  readonly order?: number;
  readonly legacyLayout?: LegacyLayout;
}

type UnknownRecord = Record<string, unknown>;
type ValidationResult = Result<NormalizedWorkflowBundle, readonly ValidationIssue[]>;

interface ValidationSuccessDetails {
  readonly bundle: NormalizedWorkflowBundle;
  readonly issues: readonly ValidationIssue[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCliAgentBackend(value: unknown): value is CliAgentBackend {
  return value === "tacogips/codex-agent" || value === "tacogips/claude-code-agent";
}

function isNodeExecutionBackend(value: unknown): value is NodeExecutionBackend {
  return (
    isCliAgentBackend(value) ||
    value === "official/openai-sdk" ||
    value === "official/anthropic-sdk"
  );
}

function requiresProviderModel(executionBackend: NodeExecutionBackend | undefined): boolean {
  return executionBackend === "official/openai-sdk" || executionBackend === "official/anthropic-sdk";
}

function makeIssue(
  severity: "error" | "warning",
  path: string,
  message: string,
): ValidationIssue {
  return { severity, path, message };
}

function readStringField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(makeIssue("error", `${path}.${key}`, "must be a non-empty string"));
    return null;
  }
  return value;
}

function readNumberField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(makeIssue("error", `${path}.${key}`, "must be a finite number"));
    return null;
  }
  return value;
}

function normalizeCompletion(value: unknown, path: string, issues: ValidationIssue[]): CompletionRule | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return undefined;
  }

  const typeValue = value["type"];
  if (
    typeValue !== "checklist" &&
    typeValue !== "score-threshold" &&
    typeValue !== "validator-result" &&
    typeValue !== "none"
  ) {
    issues.push(makeIssue("error", `${path}.type`, "must be a valid completion type"));
    return undefined;
  }

  const configValue = value["config"];
  if (configValue !== undefined && !isRecord(configValue)) {
    issues.push(makeIssue("error", `${path}.config`, "must be an object when provided"));
    return { type: typeValue };
  }

  if (isRecord(configValue)) {
    return { type: typeValue, config: configValue };
  }
  return { type: typeValue };
}

function normalizeNodeRef(value: unknown, index: number, issues: ValidationIssue[]): WorkflowNodeRef | null {
  const path = `workflow.nodes[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const id = readStringField(value, "id", path, issues);
  const nodeFile = readStringField(value, "nodeFile", path, issues);
  const completion = normalizeCompletion(value["completion"], `${path}.completion`, issues);

  const kindRaw = value["kind"];
  const allowedKinds = new Set(["task", "branch-judge", "loop-judge", "root-manager", "sub-manager", "manager", "input", "output"]);
  let kind: WorkflowNodeRef["kind"];
  if (kindRaw !== undefined) {
    if (typeof kindRaw !== "string" || !allowedKinds.has(kindRaw)) {
      issues.push(makeIssue("error", `${path}.kind`, "must be a valid node kind"));
    } else {
      kind = kindRaw as WorkflowNodeRef["kind"];
    }
  }

  if (id === null || nodeFile === null) {
    return null;
  }

  if (!NODE_ID_PATTERN.test(id)) {
    issues.push(makeIssue("error", `${path}.id`, "must match ^[a-z0-9][a-z0-9-]{1,63}$"));
  }
  if (nodeFile !== `node-${id}.json`) {
    issues.push(makeIssue("error", `${path}.nodeFile`, `must equal node-${id}.json`));
  }

  return {
    id,
    nodeFile,
    ...(kind === undefined ? {} : { kind }),
    ...(completion === undefined ? {} : { completion }),
  };
}

function normalizeEdge(value: unknown, index: number, issues: ValidationIssue[]): WorkflowEdge | null {
  const path = `workflow.edges[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const from = readStringField(value, "from", path, issues);
  const to = readStringField(value, "to", path, issues);
  const when = readStringField(value, "when", path, issues);
  const priorityRaw = value["priority"];

  let priority: number | undefined;
  if (priorityRaw !== undefined) {
    const parsed = readNumberField(value, "priority", path, issues);
    if (parsed !== null) {
      priority = parsed;
    }
  }

  if (from === null || to === null || when === null) {
    return null;
  }

  return {
    from,
    to,
    when,
    ...(priority === undefined ? {} : { priority }),
  };
}

function normalizeLoop(value: unknown, index: number, issues: ValidationIssue[]): LoopRule | null {
  const path = `workflow.loops[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const id = readStringField(value, "id", path, issues);
  const judgeNodeId = readStringField(value, "judgeNodeId", path, issues);
  const continueWhen = readStringField(value, "continueWhen", path, issues);
  const exitWhen = readStringField(value, "exitWhen", path, issues);

  let maxIterations: number | undefined;
  const maxIterationsRaw = value["maxIterations"];
  if (maxIterationsRaw !== undefined) {
    const parsed = readNumberField(value, "maxIterations", path, issues);
    if (parsed !== null && parsed > 0) {
      maxIterations = parsed;
    } else if (parsed !== null) {
      issues.push(makeIssue("error", `${path}.maxIterations`, "must be > 0"));
    }
  }

  let backoffMs: number | undefined;
  const backoffRaw = value["backoffMs"];
  if (backoffRaw !== undefined) {
    const parsed = readNumberField(value, "backoffMs", path, issues);
    if (parsed !== null && parsed >= 0) {
      backoffMs = parsed;
    } else if (parsed !== null) {
      issues.push(makeIssue("error", `${path}.backoffMs`, "must be >= 0"));
    }
  }

  if (id === null || judgeNodeId === null || continueWhen === null || exitWhen === null) {
    return null;
  }

  return {
    id,
    judgeNodeId,
    continueWhen,
    exitWhen,
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(backoffMs === undefined ? {} : { backoffMs }),
  };
}

function normalizeSubWorkflowInputSource(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): SubWorkflowInputSource | null {
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const typeRaw = value["type"];
  if (
    typeRaw !== "human-input" &&
    typeRaw !== "workflow-output" &&
    typeRaw !== "node-output" &&
    typeRaw !== "sub-workflow-output"
  ) {
    issues.push(makeIssue("error", `${path}.type`, "must be a valid sub-workflow input source type"));
    return null;
  }

  const workflowId = typeof value["workflowId"] === "string" ? value["workflowId"] : undefined;
  const nodeId = typeof value["nodeId"] === "string" ? value["nodeId"] : undefined;
  const subWorkflowId = typeof value["subWorkflowId"] === "string" ? value["subWorkflowId"] : undefined;

  if (typeRaw === "workflow-output" && (workflowId === undefined || workflowId.length === 0)) {
    issues.push(makeIssue("error", `${path}.workflowId`, "is required when type is workflow-output"));
  }
  if (typeRaw === "node-output" && (nodeId === undefined || nodeId.length === 0)) {
    issues.push(makeIssue("error", `${path}.nodeId`, "is required when type is node-output"));
  }
  if (typeRaw === "sub-workflow-output" && (subWorkflowId === undefined || subWorkflowId.length === 0)) {
    issues.push(makeIssue("error", `${path}.subWorkflowId`, "is required when type is sub-workflow-output"));
  }

  if (value["selectionPolicy"] !== undefined) {
    issues.push(
      makeIssue(
        "warning",
        `${path}.selectionPolicy`,
        "deprecated/unsupported in current runtime phase; remove or migrate before execution",
      ),
    );
    issues.push(
      makeIssue(
        "error",
        `${path}.selectionPolicy`,
        "is currently unsupported and rejected in the active runtime phase",
      ),
    );
  }

  return {
    type: typeRaw,
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(subWorkflowId === undefined ? {} : { subWorkflowId }),
  };
}

function normalizeSubWorkflow(value: unknown, index: number, issues: ValidationIssue[]): SubWorkflowRef | null {
  const path = `workflow.subWorkflows[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const id = readStringField(value, "id", path, issues);
  const description = readStringField(value, "description", path, issues);
  const managerNodeId = typeof value["managerNodeId"] === "string" ? value["managerNodeId"] : undefined;
  const inputNodeId = readStringField(value, "inputNodeId", path, issues);
  const outputNodeId = readStringField(value, "outputNodeId", path, issues);
  const nodeIdsRaw = value["nodeIds"];
  if (nodeIdsRaw !== undefined && !Array.isArray(nodeIdsRaw)) {
    issues.push(makeIssue("error", `${path}.nodeIds`, "must be an array when provided"));
  }
  const nodeIds = Array.isArray(nodeIdsRaw)
    ? nodeIdsRaw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : undefined;
  if (Array.isArray(nodeIdsRaw) && nodeIds !== undefined && nodeIds.length !== nodeIdsRaw.length) {
    issues.push(makeIssue("error", `${path}.nodeIds`, "must contain only non-empty strings"));
  }

  const inputSourcesAlias = value["inputs"];
  const inputSourcesRaw = value["inputSources"] ?? inputSourcesAlias;
  if (value["inputSources"] === undefined && inputSourcesAlias !== undefined) {
    issues.push(
      makeIssue(
        "warning",
        `${path}.inputs`,
        "legacy field 'inputs' normalized to 'inputSources'; update workflow JSON to canonical schema",
      ),
    );
  }
  if (!Array.isArray(inputSourcesRaw)) {
    issues.push(makeIssue("error", `${path}.inputSources`, "must be an array"));
  }
  const inputSources = Array.isArray(inputSourcesRaw)
    ? inputSourcesRaw
        .map((entry, sourceIndex) =>
          normalizeSubWorkflowInputSource(entry, `${path}.inputSources[${sourceIndex}]`, issues),
        )
        .filter((entry): entry is SubWorkflowInputSource => entry !== null)
    : [];

  if (id === null || description === null || inputNodeId === null || outputNodeId === null) {
    return null;
  }

  return {
    id,
    description,
    ...(managerNodeId === undefined ? {} : { managerNodeId }),
    inputNodeId,
    outputNodeId,
    ...(nodeIds === undefined ? {} : { nodeIds }),
    inputSources,
  };
}

function normalizeSubWorkflowConversation(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
): SubWorkflowConversation | null {
  const path = `workflow.subWorkflowConversations[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const id = readStringField(value, "id", path, issues);
  const stopWhen = readStringField(value, "stopWhen", path, issues);

  const participantsAlias = value["participantsIds"];
  const participantsRaw = value["participants"] ?? participantsAlias;
  if (value["participants"] === undefined && participantsAlias !== undefined) {
    issues.push(
      makeIssue(
        "warning",
        `${path}.participantsIds`,
        "legacy field 'participantsIds' normalized to 'participants'; update workflow JSON to canonical schema",
      ),
    );
  }
  if (!Array.isArray(participantsRaw)) {
    issues.push(makeIssue("error", `${path}.participants`, "must be an array"));
  }
  const participants = Array.isArray(participantsRaw)
    ? participantsRaw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  if (Array.isArray(participantsRaw) && participants.length !== participantsRaw.length) {
    issues.push(makeIssue("error", `${path}.participants`, "must contain only non-empty strings"));
  }

  const maxTurnsRaw = value["maxTurns"];
  let maxTurns: number | null = null;
  if (typeof maxTurnsRaw === "number" && Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0) {
    maxTurns = maxTurnsRaw;
  } else {
    issues.push(makeIssue("error", `${path}.maxTurns`, "must be a positive number"));
  }

  if (value["conversationPolicy"] !== undefined) {
    issues.push(
      makeIssue(
        "warning",
        `${path}.conversationPolicy`,
        "deprecated/unsupported in current runtime phase; remove or migrate before execution",
      ),
    );
    issues.push(
      makeIssue(
        "error",
        `${path}.conversationPolicy`,
        "is currently unsupported and rejected in the active runtime phase",
      ),
    );
  }

  if (id === null || stopWhen === null || maxTurns === null) {
    return null;
  }

  return {
    id,
    participants,
    maxTurns,
    stopWhen,
  };
}

function normalizeWorkflow(workflow: unknown, issues: ValidationIssue[]): WorkflowJson | null {
  if (!isRecord(workflow)) {
    issues.push(makeIssue("error", "workflow", "must be an object"));
    return null;
  }

  const workflowId = readStringField(workflow, "workflowId", "workflow", issues);
  const description = readStringField(workflow, "description", "workflow", issues);
  const managerNodeId = readStringField(workflow, "managerNodeId", "workflow", issues);

  const defaultsValue = workflow["defaults"];
  if (!isRecord(defaultsValue)) {
    issues.push(makeIssue("error", "workflow.defaults", "must be an object"));
  }

  const maxLoopIterations =
    isRecord(defaultsValue) && readNumberField(defaultsValue, "maxLoopIterations", "workflow.defaults", issues);
  const nodeTimeoutMs =
    isRecord(defaultsValue) && readNumberField(defaultsValue, "nodeTimeoutMs", "workflow.defaults", issues);

  const subWorkflowsRaw = workflow["subWorkflows"];
  if (!Array.isArray(subWorkflowsRaw)) {
    issues.push(makeIssue("error", "workflow.subWorkflows", "must be an array"));
  }
  const subWorkflows = Array.isArray(subWorkflowsRaw)
    ? subWorkflowsRaw
        .map((entry, index) => normalizeSubWorkflow(entry, index, issues))
        .filter((entry): entry is SubWorkflowRef => entry !== null)
    : [];

  const nodesRaw = workflow["nodes"];
  if (!Array.isArray(nodesRaw)) {
    issues.push(makeIssue("error", "workflow.nodes", "must be an array"));
  }
  const nodes = Array.isArray(nodesRaw)
    ? nodesRaw
        .map((entry, index) => normalizeNodeRef(entry, index, issues))
        .filter((entry): entry is WorkflowNodeRef => entry !== null)
    : [];

  const edgesRaw = workflow["edges"];
  if (!Array.isArray(edgesRaw)) {
    issues.push(makeIssue("error", "workflow.edges", "must be an array"));
  }
  const edges = Array.isArray(edgesRaw)
    ? edgesRaw
        .map((entry, index) => normalizeEdge(entry, index, issues))
        .filter((entry): entry is WorkflowEdge => entry !== null)
    : [];

  const loopsRaw = workflow["loops"];
  const loops =
    Array.isArray(loopsRaw)
      ? loopsRaw
          .map((entry, index) => normalizeLoop(entry, index, issues))
          .filter((entry): entry is LoopRule => entry !== null)
      : undefined;

  if (loopsRaw !== undefined && !Array.isArray(loopsRaw)) {
    issues.push(makeIssue("error", "workflow.loops", "must be an array when provided"));
  }

  const branching = workflow["branching"];
  if (!isRecord(branching)) {
    issues.push(makeIssue("error", "workflow.branching", "must be an object"));
  }
  if (!isRecord(branching) || branching["mode"] !== "fan-out") {
    issues.push(makeIssue("error", "workflow.branching.mode", "must be 'fan-out'"));
  }

  const subWorkflowConversationsRaw = workflow["subWorkflowConversations"];
  if (subWorkflowConversationsRaw !== undefined && !Array.isArray(subWorkflowConversationsRaw)) {
    issues.push(makeIssue("error", "workflow.subWorkflowConversations", "must be an array when provided"));
  }
  const subWorkflowConversations = Array.isArray(subWorkflowConversationsRaw)
    ? subWorkflowConversationsRaw
        .map((entry, index) => normalizeSubWorkflowConversation(entry, index, issues))
        .filter((entry): entry is SubWorkflowConversation => entry !== null)
    : undefined;

  if (
    workflowId === null ||
    description === null ||
    managerNodeId === null ||
    typeof maxLoopIterations !== "number" ||
    typeof nodeTimeoutMs !== "number" ||
    !Array.isArray(subWorkflowsRaw)
  ) {
    return null;
  }

  if (maxLoopIterations <= 0) {
    issues.push(makeIssue("error", "workflow.defaults.maxLoopIterations", "must be > 0"));
  }
  if (nodeTimeoutMs <= 0) {
    issues.push(makeIssue("error", "workflow.defaults.nodeTimeoutMs", "must be > 0"));
  }

  return {
    workflowId,
    description,
    defaults: { maxLoopIterations, nodeTimeoutMs },
    managerNodeId,
    subWorkflows,
    ...(subWorkflowConversations === undefined ? {} : { subWorkflowConversations }),
    nodes,
    edges,
    ...(loops === undefined ? {} : { loops }),
    branching: { mode: "fan-out" },
  };
}

function normalizeVisNode(value: unknown, index: number, issues: ValidationIssue[]): NormalizedVisNodeCandidate | null {
  const path = `workflowVis.nodes[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const id = readStringField(value, "id", path, issues);
  if (id === null) {
    return null;
  }

  let order: number | undefined;
  const orderRaw = value["order"];
  if (orderRaw !== undefined) {
    if (typeof orderRaw !== "number" || !Number.isInteger(orderRaw) || orderRaw < 0) {
      issues.push(makeIssue("error", `${path}.order`, "must be a non-negative integer"));
    } else {
      order = orderRaw;
    }
  } else {
    const hasLegacyLayoutFields =
      value["x"] !== undefined || value["y"] !== undefined || value["width"] !== undefined || value["height"] !== undefined;
    if (hasLegacyLayoutFields) {
      const x = readNumberField(value, "x", path, issues);
      const y = readNumberField(value, "y", path, issues);
      const width = readNumberField(value, "width", path, issues);
      const height = readNumberField(value, "height", path, issues);
      if (x !== null && y !== null && width !== null && height !== null) {
        return {
          id,
          legacyLayout: { x, y, width, height },
        };
      }
    } else {
      issues.push(makeIssue("error", `${path}.order`, "must be a non-negative integer"));
    }
  }

  if (value["indent"] !== undefined || value["indentLevel"] !== undefined) {
    issues.push(
      makeIssue(
        "warning",
        `${path}.indent`,
        "is ignored; indent is derived from workflow graph structure",
      ),
    );
  }

  if (value["color"] !== undefined) {
    issues.push(
      makeIssue(
        "warning",
        `${path}.color`,
        "is ignored; color is derived from workflow loop/group scope",
      ),
    );
  }

  if (order === undefined) {
    return null;
  }

  return {
    id,
    ...(order === undefined ? {} : { order }),
  };
}

function normalizeWorkflowVis(workflowVis: unknown, issues: ValidationIssue[]): WorkflowVisJson | null {
  if (!isRecord(workflowVis)) {
    issues.push(makeIssue("error", "workflowVis", "must be an object"));
    return null;
  }

  const nodesRaw = workflowVis["nodes"];
  if (!Array.isArray(nodesRaw)) {
    issues.push(makeIssue("error", "workflowVis.nodes", "must be an array"));
    return null;
  }

  const candidates = nodesRaw
    .map((entry, index) => normalizeVisNode(entry, index, issues))
    .filter((entry): entry is NormalizedVisNodeCandidate => entry !== null);

  const legacyCandidates = candidates.filter(
    (entry): entry is NormalizedVisNodeCandidate & { readonly legacyLayout: LegacyLayout } => entry.legacyLayout !== undefined,
  );
  const explicitCandidates = candidates.filter((entry): entry is NormalizedVisNodeCandidate & { readonly order: number } => (
    entry.order !== undefined
  ));

  if (legacyCandidates.length > 0 && explicitCandidates.length > 0) {
    issues.push(
      makeIssue(
        "error",
        "workflowVis.nodes",
        "must not mix explicit order entries with legacy coordinate layout entries",
      ),
    );
  }

  const nodes: readonly VisNode[] =
    legacyCandidates.length > 0
      ? [...legacyCandidates]
          .sort((a, b) => {
            const aLayout = a.legacyLayout;
            const bLayout = b.legacyLayout;
            return (
              aLayout.y - bLayout.y ||
              aLayout.x - bLayout.x ||
              a.id.localeCompare(b.id)
            );
          })
          .map((entry, index) => {
            issues.push(
              makeIssue(
                "warning",
                `workflowVis.nodes[${index}].order`,
                "legacy x/y layout normalized to top-to-bottom, left-to-right order; set explicit order",
              ),
            );
            return { id: entry.id, order: index };
          })
      : [...explicitCandidates]
          .map((entry) => ({ id: entry.id, order: entry.order }))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  if (workflowVis["viewport"] !== undefined) {
    issues.push(
      makeIssue(
        "warning",
        "workflowVis.viewport",
        "legacy canvas viewport is ignored in vertical workflow layout",
      ),
    );
  }

  const uiMetaRaw = workflowVis["uiMeta"];
  if (uiMetaRaw !== undefined && !isRecord(uiMetaRaw)) {
    issues.push(makeIssue("error", "workflowVis.uiMeta", "must be an object when provided"));
  }

  return {
    nodes,
    ...(isRecord(uiMetaRaw) ? { uiMeta: uiMetaRaw } : {}),
  };
}

function normalizeNodePayload(
  nodeId: string,
  nodeFile: string,
  payload: unknown,
  issues: ValidationIssue[],
): NodePayload | null {
  const path = `nodePayloads.${nodeFile}`;
  if (!isRecord(payload)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const id = readStringField(payload, "id", path, issues);
  if (id !== null && id !== nodeId) {
    issues.push(makeIssue("error", `${path}.id`, `must equal ${nodeId}`));
  }

  const modelRaw = payload["model"];
  const model = typeof modelRaw === "string" && modelRaw.length > 0 ? modelRaw : null;
  if (model === null) {
    issues.push(makeIssue("error", `${path}.model`, "must be a non-empty string"));
  }

  const executionBackendRaw = payload["executionBackend"];
  let executionBackend: NodeExecutionBackend | undefined;
  if (executionBackendRaw !== undefined) {
    if (isNodeExecutionBackend(executionBackendRaw)) {
      executionBackend = executionBackendRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.executionBackend`,
          "must be tacogips/codex-agent, tacogips/claude-code-agent, official/openai-sdk, or official/anthropic-sdk",
        ),
      );
    }
  } else if (model !== null && !isCliAgentBackend(model)) {
    issues.push(
      makeIssue(
        "error",
        `${path}.executionBackend`,
        "is required when model is not one of the tacogips CLI-wrapper backend identifiers",
      ),
    );
  }
  if (model !== null && executionBackend !== undefined && requiresProviderModel(executionBackend) && isCliAgentBackend(model)) {
    issues.push(
      makeIssue(
        "error",
        `${path}.model`,
        `must be a provider model name when executionBackend is '${executionBackend}', not a tacogips CLI-wrapper identifier`,
      ),
    );
  }

  const promptTemplateRaw = payload["promptTemplate"];
  const promptAlias = payload["prompt"];
  let promptTemplate: string | null = null;
  if (typeof promptTemplateRaw === "string" && promptTemplateRaw.length > 0) {
    promptTemplate = promptTemplateRaw;
  } else if (typeof promptAlias === "string" && promptAlias.length > 0) {
    promptTemplate = promptAlias;
    issues.push(makeIssue("warning", `${path}.prompt`, "legacy field 'prompt' normalized to 'promptTemplate'"));
  } else {
    issues.push(makeIssue("error", `${path}.promptTemplate`, "must be a non-empty string"));
  }

  const variablesRaw = payload["variables"];
  const variablesAlias = payload["variable"];
  let variables: UnknownRecord | null = null;
  if (isRecord(variablesRaw)) {
    variables = variablesRaw;
  } else if (isRecord(variablesAlias)) {
    variables = variablesAlias;
    issues.push(makeIssue("warning", `${path}.variable`, "legacy field 'variable' normalized to 'variables'"));
  } else {
    issues.push(makeIssue("error", `${path}.variables`, "must be an object"));
  }

  const timeoutRaw = payload["timeoutMs"];
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw === "number" && timeoutRaw > 0) {
      timeoutMs = timeoutRaw;
    } else {
      issues.push(makeIssue("error", `${path}.timeoutMs`, "must be > 0 when provided"));
    }
  }

  const argumentsTemplateRaw = payload["argumentsTemplate"];
  let argumentsTemplate: UnknownRecord | undefined;
  if (argumentsTemplateRaw !== undefined) {
    if (isRecord(argumentsTemplateRaw)) {
      argumentsTemplate = argumentsTemplateRaw;
    } else {
      issues.push(makeIssue("error", `${path}.argumentsTemplate`, "must be an object when provided"));
    }
  }

  const argumentBindingsRaw = payload["argumentBindings"];
  let argumentBindings: readonly ArgumentBinding[] | undefined;
  if (argumentBindingsRaw !== undefined) {
    if (!Array.isArray(argumentBindingsRaw)) {
      issues.push(makeIssue("error", `${path}.argumentBindings`, "must be an array when provided"));
    } else {
      const parsed: ArgumentBinding[] = [];
      argumentBindingsRaw.forEach((entry, index) => {
        const entryPath = `${path}.argumentBindings[${index}]`;
        if (!isRecord(entry)) {
          issues.push(makeIssue("error", entryPath, "must be an object"));
          return;
        }

        const targetPath = readStringField(entry, "targetPath", entryPath, issues);
        const sourceRaw = entry["source"];
        if (
          sourceRaw !== "variables" &&
          sourceRaw !== "node-output" &&
          sourceRaw !== "sub-workflow-output" &&
          sourceRaw !== "workflow-output" &&
          sourceRaw !== "human-input" &&
          sourceRaw !== "conversation-transcript"
        ) {
          issues.push(makeIssue("error", `${entryPath}.source`, "must be a valid binding source"));
          return;
        }

        if (targetPath === null) {
          return;
        }

        const sourceRef = entry["sourceRef"];
        const sourcePath = entry["sourcePath"];
        const required = entry["required"];

        parsed.push({
          targetPath,
          source: sourceRaw,
          ...(typeof sourceRef === "string" || isRecord(sourceRef) ? { sourceRef } : {}),
          ...(typeof sourcePath === "string" ? { sourcePath } : {}),
          ...(typeof required === "boolean" ? { required } : {}),
        });
      });
      argumentBindings = parsed;
    }
  }

  const templateEngineRaw = payload["templateEngine"];
  const templateEngine = typeof templateEngineRaw === "string" ? templateEngineRaw : undefined;

  if (id === null || model === null || promptTemplate === null || variables === null) {
    return null;
  }

  return {
    id,
    model,
    ...(executionBackend === undefined ? {} : { executionBackend }),
    promptTemplate,
    variables,
    ...(argumentsTemplate === undefined ? {} : { argumentsTemplate }),
    ...(argumentBindings === undefined ? {} : { argumentBindings }),
    ...(templateEngine === undefined ? {} : { templateEngine }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function intervalsPartiallyOverlap(
  left: Readonly<{ startOrder: number; endOrder: number }>,
  right: Readonly<{ startOrder: number; endOrder: number }>,
): boolean {
  const leftStartsInsideRight =
    right.startOrder < left.startOrder &&
    left.startOrder <= right.endOrder &&
    right.endOrder < left.endOrder;
  const rightStartsInsideLeft =
    left.startOrder < right.startOrder &&
    right.startOrder <= left.endOrder &&
    left.endOrder < right.endOrder;
  return leftStartsInsideRight || rightStartsInsideLeft;
}

function findNodeIdByOrder(bundle: NormalizedWorkflowBundle, order: number): string {
  return bundle.workflowVis.nodes.find((entry) => entry.order === order)?.id ?? "unknown";
}

function pushCrossingIntervalIssue(
  issues: ValidationIssue[],
  bundle: NormalizedWorkflowBundle,
  args: {
    readonly path: string;
    readonly leftId: string;
    readonly leftStartOrder: number;
    readonly rightId: string;
    readonly rightStartOrder: number;
    readonly messagePrefix: string;
  },
): void {
  const earlierId = args.leftStartOrder <= args.rightStartOrder ? args.leftId : args.rightId;
  const laterId = earlierId === args.leftId ? args.rightId : args.leftId;
  const crossingNodeId = findNodeIdByOrder(
    bundle,
    args.leftStartOrder <= args.rightStartOrder ? args.rightStartOrder : args.leftStartOrder,
  );
  issues.push(
    makeIssue(
      "error",
      args.path,
      `${args.messagePrefix} '${earlierId}' and '${laterId}' cross; reorder or nest them cleanly around node '${crossingNodeId}'`,
    ),
  );
}

function runSemanticValidation(bundle: NormalizedWorkflowBundle, issues: ValidationIssue[]): void {
  const nodeIdSet = new Set(bundle.workflow.nodes.map((node) => node.id));
  const visOrderByNodeId = new Map(bundle.workflowVis.nodes.map((entry) => [entry.id, entry.order]));
  const rootManagerNodeIds = bundle.workflow.nodes
    .filter((node) => node.kind === "root-manager")
    .map((node) => node.id);

  if (!nodeIdSet.has(bundle.workflow.managerNodeId)) {
    issues.push(
      makeIssue(
        "error",
        "workflow.managerNodeId",
        `must reference an existing node id (${bundle.workflow.managerNodeId})`,
      ),
    );
  }

  const managerNode = bundle.workflow.nodes.find((node) => node.id === bundle.workflow.managerNodeId);
  if (managerNode?.kind !== "manager" && managerNode?.kind !== "root-manager") {
    issues.push(
      makeIssue(
        "error",
        "workflow.managerNodeId",
        "must reference a node with kind 'root-manager' (legacy 'manager' is still accepted during transition)",
      ),
    );
  }
  rootManagerNodeIds.forEach((nodeId) => {
    if (nodeId === bundle.workflow.managerNodeId) {
      return;
    }
    issues.push(
      makeIssue(
        "error",
        "workflow.nodes",
        `node '${nodeId}' cannot use kind 'root-manager' unless it is workflow.managerNodeId`,
      ),
    );
  });

  const seenNodeIds = new Set<string>();
  bundle.workflow.nodes.forEach((node, index) => {
    if (seenNodeIds.has(node.id)) {
      issues.push(makeIssue("error", `workflow.nodes[${index}].id`, `duplicate node id '${node.id}'`));
      return;
    }
    seenNodeIds.add(node.id);

    const payload = bundle.nodePayloads[node.id];
    if (!payload) {
      issues.push(makeIssue("error", `nodePayloads.${node.nodeFile}`, "node payload file is missing"));
      return;
    }

    if (payload.timeoutMs === undefined && bundle.workflow.defaults.nodeTimeoutMs === DEFAULT_NODE_TIMEOUT_MS) {
      issues.push(
        makeIssue(
          "warning",
          `nodePayloads.${node.nodeFile}.timeoutMs`,
          "not set; workflow default timeout will be applied",
        ),
      );
    }
  });

  bundle.workflow.edges.forEach((edge, index) => {
    if (!nodeIdSet.has(edge.from)) {
      issues.push(makeIssue("error", `workflow.edges[${index}].from`, "must reference an existing node id"));
    }
    if (!nodeIdSet.has(edge.to)) {
      issues.push(makeIssue("error", `workflow.edges[${index}].to`, "must reference an existing node id"));
    }
  });

  bundle.workflow.loops?.forEach((loop, index) => {
    if (!nodeIdSet.has(loop.judgeNodeId)) {
      issues.push(makeIssue("error", `workflow.loops[${index}].judgeNodeId`, "must reference an existing node id"));
      return;
    }
    const judgeNode = bundle.workflow.nodes.find((node) => node.id === loop.judgeNodeId);
    if (judgeNode?.kind !== "loop-judge") {
      issues.push(makeIssue("error", `workflow.loops[${index}].judgeNodeId`, "must reference a loop-judge node"));
    }
  });

  const declaredSubWorkflowIds = new Set(bundle.workflow.subWorkflows.map((entry) => entry.id));
  const subWorkflowIdSet = new Set<string>();
  const subWorkflowNodeOwnership = new Map<string, string>();
  const subWorkflowBoundaryOwnership = new Map<string, string>();
  bundle.workflow.subWorkflows.forEach((subWorkflow, index) => {
    if (subWorkflowIdSet.has(subWorkflow.id)) {
      issues.push(makeIssue("error", `workflow.subWorkflows[${index}].id`, `duplicate subWorkflow id '${subWorkflow.id}'`));
    } else {
      subWorkflowIdSet.add(subWorkflow.id);
    }

    if (subWorkflow.managerNodeId !== undefined && subWorkflow.managerNodeId === subWorkflow.inputNodeId) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflows[${index}].managerNodeId`,
          "must not reference the same node as inputNodeId",
        ),
      );
    }
    if (subWorkflow.managerNodeId !== undefined && subWorkflow.managerNodeId === subWorkflow.outputNodeId) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflows[${index}].managerNodeId`,
          "must not reference the same node as outputNodeId",
        ),
      );
    }
    if (subWorkflow.inputNodeId === subWorkflow.outputNodeId) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflows[${index}].inputNodeId`,
          "must not reference the same node as outputNodeId",
        ),
      );
    }

    if (subWorkflow.managerNodeId !== undefined) {
      if (!nodeIdSet.has(subWorkflow.managerNodeId)) {
        issues.push(
          makeIssue(
            "error",
            `workflow.subWorkflows[${index}].managerNodeId`,
            "must reference an existing node id",
          ),
        );
      } else {
        const subManagerNode = bundle.workflow.nodes.find((node) => node.id === subWorkflow.managerNodeId);
        if (subManagerNode?.kind !== "sub-manager" && subManagerNode?.kind !== "manager") {
          issues.push(
            makeIssue(
              "error",
              `workflow.subWorkflows[${index}].managerNodeId`,
              "must reference a node with kind 'sub-manager'",
            ),
          );
        }
      }
      const existingBoundaryOwner = subWorkflowBoundaryOwnership.get(subWorkflow.managerNodeId);
      if (existingBoundaryOwner !== undefined && existingBoundaryOwner !== subWorkflow.id) {
        issues.push(
          makeIssue(
            "error",
            `workflow.subWorkflows[${index}].managerNodeId`,
            `manager node '${subWorkflow.managerNodeId}' is already assigned to subWorkflow '${existingBoundaryOwner}'`,
          ),
        );
      } else {
        subWorkflowBoundaryOwnership.set(subWorkflow.managerNodeId, subWorkflow.id);
      }
    }

    if (!nodeIdSet.has(subWorkflow.inputNodeId)) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflows[${index}].inputNodeId`,
          "must reference an existing node id",
        ),
      );
    } else {
      const inputNode = bundle.workflow.nodes.find((node) => node.id === subWorkflow.inputNodeId);
      if (inputNode?.kind !== "input") {
        issues.push(
          makeIssue(
            "error",
            `workflow.subWorkflows[${index}].inputNodeId`,
            "must reference a node with kind 'input'",
          ),
        );
      }
    }
    const existingInputOwner = subWorkflowBoundaryOwnership.get(subWorkflow.inputNodeId);
    if (existingInputOwner !== undefined && existingInputOwner !== subWorkflow.id) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflows[${index}].inputNodeId`,
          `input node '${subWorkflow.inputNodeId}' is already assigned to subWorkflow '${existingInputOwner}'`,
        ),
      );
    } else {
      subWorkflowBoundaryOwnership.set(subWorkflow.inputNodeId, subWorkflow.id);
    }

    if (!nodeIdSet.has(subWorkflow.outputNodeId)) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflows[${index}].outputNodeId`,
          "must reference an existing node id",
        ),
      );
    } else {
      const outputNode = bundle.workflow.nodes.find((node) => node.id === subWorkflow.outputNodeId);
      if (outputNode?.kind !== "output") {
        issues.push(
          makeIssue(
            "error",
            `workflow.subWorkflows[${index}].outputNodeId`,
            "must reference a node with kind 'output'",
          ),
        );
      }
    }
    const existingOutputOwner = subWorkflowBoundaryOwnership.get(subWorkflow.outputNodeId);
    if (existingOutputOwner !== undefined && existingOutputOwner !== subWorkflow.id) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflows[${index}].outputNodeId`,
          `output node '${subWorkflow.outputNodeId}' is already assigned to subWorkflow '${existingOutputOwner}'`,
        ),
      );
    } else {
      subWorkflowBoundaryOwnership.set(subWorkflow.outputNodeId, subWorkflow.id);
    }

    if (subWorkflow.nodeIds !== undefined) {
      if (subWorkflow.nodeIds.length === 0) {
        issues.push(makeIssue("error", `workflow.subWorkflows[${index}].nodeIds`, "must not be empty"));
      }
      const seenNodeIds = new Set<string>();
      subWorkflow.nodeIds.forEach((nodeId, nodeIndex) => {
        if (seenNodeIds.has(nodeId)) {
          issues.push(
            makeIssue(
              "error",
              `workflow.subWorkflows[${index}].nodeIds[${nodeIndex}]`,
              `duplicate node id '${nodeId}' is not allowed within the same subWorkflow`,
            ),
          );
          return;
        }
        seenNodeIds.add(nodeId);
        if (!nodeIdSet.has(nodeId)) {
          issues.push(
            makeIssue(
              "error",
              `workflow.subWorkflows[${index}].nodeIds[${nodeIndex}]`,
              "must reference an existing node id",
            ),
          );
          return;
        }
        const existingOwner = subWorkflowNodeOwnership.get(nodeId);
        if (existingOwner !== undefined && existingOwner !== subWorkflow.id) {
          issues.push(
            makeIssue(
              "error",
              `workflow.subWorkflows[${index}].nodeIds[${nodeIndex}]`,
              `node id '${nodeId}' is already owned by subWorkflow '${existingOwner}'`,
            ),
          );
          return;
        }
        subWorkflowNodeOwnership.set(nodeId, subWorkflow.id);
      });

      if (subWorkflow.managerNodeId !== undefined && !subWorkflow.nodeIds.includes(subWorkflow.managerNodeId)) {
        issues.push(
          makeIssue(
            "error",
            `workflow.subWorkflows[${index}].nodeIds`,
            "must include managerNodeId when managerNodeId is provided",
          ),
        );
      }
      if (!subWorkflow.nodeIds.includes(subWorkflow.inputNodeId)) {
        issues.push(makeIssue("error", `workflow.subWorkflows[${index}].nodeIds`, "must include inputNodeId"));
      }
      if (!subWorkflow.nodeIds.includes(subWorkflow.outputNodeId)) {
        issues.push(makeIssue("error", `workflow.subWorkflows[${index}].nodeIds`, "must include outputNodeId"));
      }
    }

    subWorkflow.inputSources.forEach((source, sourceIndex) => {
      const sourcePath = `workflow.subWorkflows[${index}].inputSources[${sourceIndex}]`;
      if (source.type === "node-output" && source.nodeId !== undefined && !nodeIdSet.has(source.nodeId)) {
        issues.push(makeIssue("error", `${sourcePath}.nodeId`, "must reference an existing node id"));
      }
      if (
        source.type === "sub-workflow-output" &&
        source.subWorkflowId !== undefined &&
        !declaredSubWorkflowIds.has(source.subWorkflowId)
      ) {
        issues.push(makeIssue("error", `${sourcePath}.subWorkflowId`, "must reference an existing subWorkflow id"));
      }
    });
  });

  bundle.workflow.subWorkflowConversations?.forEach((conversation, index) => {
    if (conversation.participants.length < 2) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflowConversations[${index}].participants`,
          "must include at least two participants",
        ),
      );
    }
    if (new Set(conversation.participants).size < 2) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflowConversations[${index}].participants`,
          "must include at least two distinct participants",
        ),
      );
    }
    conversation.participants.forEach((participant, participantIndex) => {
      if (!declaredSubWorkflowIds.has(participant)) {
        issues.push(
          makeIssue(
            "error",
            `workflow.subWorkflowConversations[${index}].participants[${participantIndex}]`,
            "must reference an existing subWorkflow id",
          ),
        );
      }
    });
  });

  const visNodeSet = new Set<string>();
  const visOrderSet = new Set<number>();
  bundle.workflowVis.nodes.forEach((entry, index) => {
    if (!nodeIdSet.has(entry.id)) {
      issues.push(makeIssue("error", `workflowVis.nodes[${index}].id`, "references unknown node id"));
    }
    if (visNodeSet.has(entry.id)) {
      issues.push(makeIssue("error", `workflowVis.nodes[${index}].id`, `duplicate vis node id '${entry.id}'`));
    } else {
      visNodeSet.add(entry.id);
    }
    if (visOrderSet.has(entry.order)) {
      issues.push(makeIssue("error", `workflowVis.nodes[${index}].order`, `duplicate order '${entry.order}'`));
    } else {
      visOrderSet.add(entry.order);
    }
  });

  nodeIdSet.forEach((nodeId) => {
    if (!visNodeSet.has(nodeId)) {
      issues.push(makeIssue("error", "workflowVis.nodes", `missing vertical order for node '${nodeId}'`));
    }
  });

  const subWorkflowIntervals: Array<{ readonly id: string; readonly inputOrder: number; readonly outputOrder: number }> = [];
  for (const subWorkflow of bundle.workflow.subWorkflows) {
    const inputOrder = visOrderByNodeId.get(subWorkflow.inputNodeId);
    const outputOrder = visOrderByNodeId.get(subWorkflow.outputNodeId);
    if (inputOrder === undefined || outputOrder === undefined) {
      continue;
    }
    if (inputOrder > outputOrder) {
      issues.push(
        makeIssue(
          "error",
          `workflow.subWorkflows.${subWorkflow.id}`,
          "must place inputNodeId before outputNodeId in vertical order",
        ),
      );
      continue;
    }
    subWorkflowIntervals.push({
      id: subWorkflow.id,
      inputOrder,
      outputOrder,
    });
  }

  for (let index = 0; index < subWorkflowIntervals.length; index += 1) {
    const current = subWorkflowIntervals[index];
    if (current === undefined) {
      continue;
    }
    for (let compareIndex = index + 1; compareIndex < subWorkflowIntervals.length; compareIndex += 1) {
      const other = subWorkflowIntervals[compareIndex];
      if (other === undefined) {
        continue;
      }
      if (
        intervalsPartiallyOverlap(
          { startOrder: current.inputOrder, endOrder: current.outputOrder },
          { startOrder: other.inputOrder, endOrder: other.outputOrder },
        )
      ) {
        pushCrossingIntervalIssue(issues, bundle, {
          path: "workflow.subWorkflows",
          leftId: current.id,
          leftStartOrder: current.inputOrder,
          rightId: other.id,
          rightStartOrder: other.inputOrder,
          messagePrefix: "vertical subWorkflow groups",
        });
      }
    }
  }

  const loopIntervals: Array<{ readonly id: string; readonly startOrder: number; readonly endOrder: number }> = [];
  bundle.workflow.loops?.forEach((loop, index) => {
    const judgeOrder = visOrderByNodeId.get(loop.judgeNodeId);
    if (judgeOrder === undefined) {
      return;
    }

    const continueTargets = bundle.workflow.edges.filter(
      (edge) => edge.from === loop.judgeNodeId && edge.when === loop.continueWhen,
    );
    if (continueTargets.length === 0) {
      issues.push(
        makeIssue(
          "error",
          `workflow.loops[${index}].continueWhen`,
          "must have at least one matching continue edge from the loop judge",
        ),
      );
    }
    continueTargets.forEach((edge, continueIndex) => {
      const targetOrder = visOrderByNodeId.get(edge.to);
      if (targetOrder === undefined) {
        return;
      }
      if (targetOrder <= judgeOrder) {
        loopIntervals.push({
          id: loop.id,
          startOrder: targetOrder,
          endOrder: judgeOrder,
        });
      }
      if (targetOrder > judgeOrder) {
        issues.push(
          makeIssue(
            "error",
            `workflow.loops[${index}].continueWhen`,
            `continue edge target '${edge.to}' must appear before loop judge '${loop.judgeNodeId}' in vertical order`,
          ),
        );
      }
      if (continueIndex > 0 && targetOrder !== undefined && targetOrder !== visOrderByNodeId.get(continueTargets[0]?.to ?? "")) {
        issues.push(
          makeIssue(
            "warning",
            `workflow.loops[${index}].continueWhen`,
            "multiple continue targets produce a shared visual loop block based on the earliest target",
          ),
        );
      }
    });

    bundle.workflow.edges
      .filter((edge) => edge.from === loop.judgeNodeId && edge.when === loop.exitWhen)
      .forEach((edge) => {
        const targetOrder = visOrderByNodeId.get(edge.to);
        if (targetOrder === undefined) {
          return;
        }
        if (targetOrder <= judgeOrder) {
          issues.push(
            makeIssue(
              "error",
              `workflow.loops[${index}].exitWhen`,
              `exit edge target '${edge.to}' must appear after loop judge '${loop.judgeNodeId}' in vertical order`,
            ),
          );
        }
      });
  });

  for (let index = 0; index < loopIntervals.length; index += 1) {
    const current = loopIntervals[index];
    if (current === undefined) {
      continue;
    }
    for (let compareIndex = index + 1; compareIndex < loopIntervals.length; compareIndex += 1) {
      const other = loopIntervals[compareIndex];
      if (other === undefined || current.id === other.id) {
        continue;
      }
      if (intervalsPartiallyOverlap(current, other)) {
        pushCrossingIntervalIssue(issues, bundle, {
          path: "workflow.loops",
          leftId: current.id,
          leftStartOrder: current.startOrder,
          rightId: other.id,
          rightStartOrder: other.startOrder,
          messagePrefix: "vertical loop scopes",
        });
      }
    }
  }

  for (const groupInterval of subWorkflowIntervals) {
    for (const loopInterval of loopIntervals) {
      if (
        intervalsPartiallyOverlap(
          { startOrder: groupInterval.inputOrder, endOrder: groupInterval.outputOrder },
          loopInterval,
        )
      ) {
        pushCrossingIntervalIssue(issues, bundle, {
          path: "workflow",
          leftId: groupInterval.id,
          leftStartOrder: groupInterval.inputOrder,
          rightId: loopInterval.id,
          rightStartOrder: loopInterval.startOrder,
          messagePrefix: "vertical group and loop scopes",
        });
      }
    }
  }

  if (bundle.workflow.defaults.maxLoopIterations === DEFAULT_MAX_LOOP_ITERATIONS) {
    issues.push(
      makeIssue(
        "warning",
        "workflow.defaults.maxLoopIterations",
        "using default loop iteration value; consider explicit value per workflow",
      ),
    );
  }
}

export function validateWorkflowBundleDetailed(raw: RawBundle): Result<ValidationSuccessDetails, readonly ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  const workflow = normalizeWorkflow(raw.workflow, issues);
  const workflowVis = normalizeWorkflowVis(raw.workflowVis, issues);

  const nodePayloads: Record<string, NodePayload> = {};
  if (workflow !== null) {
    workflow.nodes.forEach((node) => {
      const payloadRaw = raw.nodePayloads[node.nodeFile];
      if (payloadRaw === undefined) {
        issues.push(makeIssue("error", `nodePayloads.${node.nodeFile}`, "node payload file is missing"));
        return;
      }
      const payload = normalizeNodePayload(node.id, node.nodeFile, payloadRaw, issues);
      if (payload !== null) {
        nodePayloads[node.id] = payload;
      }
    });
  }

  if (workflow === null || workflowVis === null) {
    return err(issues);
  }

  const bundle: NormalizedWorkflowBundle = {
    workflow,
    workflowVis,
    nodePayloads,
  };

  runSemanticValidation(bundle, issues);
  const allErrors = issues.filter((entry) => entry.severity === "error");
  if (allErrors.length > 0) {
    return err(issues);
  }

  return ok({ bundle, issues });
}

export function validateWorkflowBundle(raw: RawBundle): ValidationResult {
  const validation = validateWorkflowBundleDetailed(raw);
  if (!validation.ok) {
    return err(validation.error);
  }
  return ok(validation.value.bundle);
}
