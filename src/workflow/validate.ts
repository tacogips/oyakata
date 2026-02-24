import { err, ok, type Result } from "./result";
import {
  DEFAULT_MAX_LOOP_ITERATIONS,
  DEFAULT_NODE_TIMEOUT_MS,
  NODE_ID_PATTERN,
  type AgentModel,
  type ArgumentBinding,
  type CompletionRule,
  type LoopRule,
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

type UnknownRecord = Record<string, unknown>;
type ValidationResult = Result<NormalizedWorkflowBundle, readonly ValidationIssue[]>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentModel(value: unknown): value is AgentModel {
  return value === "tacogips/codex-agent" || value === "tacogips/claude-code-agent";
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
  const allowedKinds = new Set(["task", "branch-judge", "loop-judge", "manager", "input", "output"]);
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
  const inputNodeId = readStringField(value, "inputNodeId", path, issues);
  const outputNodeId = readStringField(value, "outputNodeId", path, issues);

  const inputSourcesRaw = value["inputSources"];
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
    inputNodeId,
    outputNodeId,
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

  const participantsRaw = value["participants"];
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

function normalizeVisNode(value: unknown, index: number, issues: ValidationIssue[]): VisNode | null {
  const path = `workflowVis.nodes[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const id = readStringField(value, "id", path, issues);
  const x = readNumberField(value, "x", path, issues);
  const y = readNumberField(value, "y", path, issues);
  const width = readNumberField(value, "width", path, issues);
  const height = readNumberField(value, "height", path, issues);

  if (id === null || x === null || y === null || width === null || height === null) {
    return null;
  }

  return { id, x, y, width, height };
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

  const nodes = nodesRaw
    .map((entry, index) => normalizeVisNode(entry, index, issues))
    .filter((entry): entry is VisNode => entry !== null);

  const viewportRaw = workflowVis["viewport"];
  if (viewportRaw !== undefined && !isRecord(viewportRaw)) {
    issues.push(makeIssue("error", "workflowVis.viewport", "must be an object when provided"));
  }

  const uiMetaRaw = workflowVis["uiMeta"];
  if (uiMetaRaw !== undefined && !isRecord(uiMetaRaw)) {
    issues.push(makeIssue("error", "workflowVis.uiMeta", "must be an object when provided"));
  }

  return {
    nodes,
    ...(isRecord(viewportRaw) ? { viewport: viewportRaw } : {}),
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
  if (!isAgentModel(modelRaw)) {
    issues.push(makeIssue("error", `${path}.model`, "must be tacogips/codex-agent or tacogips/claude-code-agent"));
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

  if (id === null || !isAgentModel(modelRaw) || promptTemplate === null || variables === null) {
    return null;
  }

  return {
    id,
    model: modelRaw,
    promptTemplate,
    variables,
    ...(argumentsTemplate === undefined ? {} : { argumentsTemplate }),
    ...(argumentBindings === undefined ? {} : { argumentBindings }),
    ...(templateEngine === undefined ? {} : { templateEngine }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function runSemanticValidation(bundle: NormalizedWorkflowBundle, issues: ValidationIssue[]): void {
  const nodeIdSet = new Set(bundle.workflow.nodes.map((node) => node.id));

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
  if (managerNode?.kind !== "manager") {
    issues.push(makeIssue("error", "workflow.managerNodeId", "must reference a node with kind 'manager'"));
  }

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
  bundle.workflow.subWorkflows.forEach((subWorkflow, index) => {
    if (subWorkflowIdSet.has(subWorkflow.id)) {
      issues.push(makeIssue("error", `workflow.subWorkflows[${index}].id`, `duplicate subWorkflow id '${subWorkflow.id}'`));
    } else {
      subWorkflowIdSet.add(subWorkflow.id);
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

  const visNodeSet = new Set(bundle.workflowVis.nodes.map((entry) => entry.id));
  nodeIdSet.forEach((nodeId) => {
    if (!visNodeSet.has(nodeId)) {
      issues.push(makeIssue("warning", "workflowVis.nodes", `missing layout for node '${nodeId}'`));
    }
  });

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

export function validateWorkflowBundle(raw: RawBundle): ValidationResult {
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

  return ok(bundle);
}
