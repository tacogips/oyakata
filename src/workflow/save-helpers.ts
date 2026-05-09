import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJsonFile, atomicWriteTextFile } from "../shared/fs";
import {
  cloneNodeTemplateAwarePayload,
  collectNodeTemplateFiles,
  listNodeTemplateFieldContainers,
  NODE_TEMPLATE_FIELD_SPECS,
} from "./node-template-fields";
import {
  resolveAuthoredNodeFileReference,
  resolveWorkflowRelativeNodeFilePath,
} from "./authored-node";
import { resolveWorkflowRelativePath } from "./prompt-template-file";
import { err, ok, type Result } from "./result";
import { collectPromptTemplateFiles } from "./revision";
import type {
  AuthoredWorkflowJson,
  WorkflowJson,
  WorkflowNodeRegistryRef,
  WorkflowStepRef,
} from "./types";

export type AuthoredWorkflowRecord = AuthoredWorkflowJson &
  Readonly<Record<string, unknown>>;

export interface SaveWorkflowInput {
  readonly workflow: unknown;
  readonly nodePayloads: Readonly<Record<string, unknown>>;
  readonly expectedRevision?: string;
}

export interface SaveWorkflowSuccess {
  readonly workflowName: string;
  readonly workflowDirectory: string;
  readonly revision: string;
}

export interface SaveWorkflowFailure {
  readonly code: "INVALID_WORKFLOW_NAME" | "VALIDATION" | "CONFLICT" | "IO";
  readonly message: string;
  readonly issues?: readonly {
    readonly severity: "error" | "warning";
    readonly path: string;
    readonly message: string;
  }[];
  readonly currentRevision?: string;
}

/** Obsolete sidecar filename from an earlier tooling path; removed on save if still present. */
export const OBSOLETE_WORKFLOW_VISUALIZATION_FILE = "workflow-vis.json";
export const WORKFLOW_DEFINITION_FILE = "workflow.json";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(
  value: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

function collectAuthoredNodeFiles(
  authoredWorkflow: Record<string, unknown> | undefined,
): readonly string[] {
  const authoredNodes = authoredWorkflow?.["nodes"];
  if (!Array.isArray(authoredNodes)) {
    return [];
  }

  return [
    ...new Set(
      authoredNodes.flatMap((node) =>
        isRecord(node)
          ? [resolveAuthoredNodeFileReference(node)].filter(
              (nodeFile): nodeFile is string => nodeFile !== undefined,
            )
          : [],
      ),
    ),
  ];
}

function collectAuthoredStepFiles(
  authoredWorkflow: Record<string, unknown> | undefined,
): readonly string[] {
  const authoredSteps = authoredWorkflow?.["steps"];
  if (!Array.isArray(authoredSteps)) {
    return [];
  }

  return [
    ...new Set(
      authoredSteps.flatMap((step) => {
        if (!isRecord(step)) {
          return [];
        }
        const stepFile = step["stepFile"];
        return typeof stepFile === "string" && stepFile.length > 0
          ? [stepFile]
          : [];
      }),
    ),
  ];
}

function isDefaultContainerRuntime(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["runnerKind"] === "podman" &&
    value["runnerPath"] === undefined
  );
}

function projectAuthoredWorkflowFromNormalized(input: {
  readonly workflow: WorkflowJson;
  readonly persistManagerStepId: boolean;
}): AuthoredWorkflowJson {
  const { workflow } = input;

  return {
    workflowId: workflow.workflowId,
    ...(workflow.description.length === 0
      ? {}
      : { description: workflow.description }),
    defaults: {
      nodeTimeoutMs: workflow.defaults.nodeTimeoutMs,
      maxLoopIterations: workflow.defaults.maxLoopIterations,
      ...(workflow.defaults.timeoutPolicy === undefined
        ? {}
        : { timeoutPolicy: workflow.defaults.timeoutPolicy }),
      ...(workflow.defaults.containerRuntime === undefined ||
      isDefaultContainerRuntime(workflow.defaults.containerRuntime)
        ? {}
        : { containerRuntime: workflow.defaults.containerRuntime }),
    },
    ...(workflow.prompts === undefined ? {} : { prompts: workflow.prompts }),
    ...(input.persistManagerStepId &&
    workflow.hasManagerNode !== false &&
    workflow.managerStepId !== undefined
      ? { managerStepId: workflow.managerStepId }
      : {}),
    entryStepId: workflow.entryStepId,
    nodes: workflow.nodeRegistry.map(projectAuthoredWorkflowRegistryNode),
    steps: workflow.steps.map((step) =>
      step.stepFile === undefined
        ? {
            id: step.id,
            nodeId: step.nodeId,
            ...(step.description === undefined
              ? {}
              : { description: step.description }),
            ...(step.role === undefined ? {} : { role: step.role }),
            ...(step.promptVariant === undefined
              ? {}
              : { promptVariant: step.promptVariant }),
            ...(step.timeoutMs === undefined
              ? {}
              : { timeoutMs: step.timeoutMs }),
            ...(step.sessionPolicy === undefined
              ? {}
              : { sessionPolicy: step.sessionPolicy }),
            ...(step.transitions === undefined
              ? {}
              : { transitions: step.transitions }),
          }
        : {
            id: step.id,
            stepFile: step.stepFile,
          },
    ),
  };
}

function projectAuthoredWorkflowRegistryNode(
  node: WorkflowNodeRegistryRef,
): WorkflowNodeRegistryRef {
  return { ...node };
}

export function createPersistedWorkflowJson(input: {
  readonly workflow: WorkflowJson;
  readonly authoredWorkflow: AuthoredWorkflowRecord | undefined;
}): AuthoredWorkflowJson {
  const shouldPersistManagerStepId = (() => {
    if (
      input.workflow.hasManagerNode === false ||
      input.workflow.managerStepId === undefined
    ) {
      return false;
    }
    if (hasOwnKey(input.authoredWorkflow, "managerStepId")) {
      return true;
    }
    const explicitManagerSteps =
      input.workflow.steps?.filter((step) => step.role === "manager") ?? [];
    return !(
      explicitManagerSteps.length === 1 &&
      explicitManagerSteps[0]?.id === input.workflow.managerStepId
    );
  })();

  return projectAuthoredWorkflowFromNormalized({
    workflow: input.workflow,
    persistManagerStepId: shouldPersistManagerStepId,
  });
}

export function createStepAddressedWorkflowForValidation(
  workflow: WorkflowJson,
): AuthoredWorkflowJson {
  return projectAuthoredWorkflowFromNormalized({
    workflow,
    persistManagerStepId:
      workflow.hasManagerNode !== false && workflow.managerStepId !== undefined,
  });
}

export function collectReferencedNodePayloads(input: {
  readonly workflow: {
    readonly nodeRegistry?: readonly {
      readonly id: string;
      readonly nodeFile?: string;
      readonly addon?: unknown;
    }[];
    readonly steps?: readonly {
      readonly id: string;
      readonly promptVariant?: string;
      readonly timeoutMs?: number;
      readonly sessionPolicy?: unknown;
    }[];
    readonly nodes: readonly {
      readonly id: string;
      readonly nodeFile: string;
      readonly addon?: unknown;
    }[];
  };
  readonly nodePayloads: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  const referencedPayloads: Record<string, unknown> = {};
  const authoredNodes =
    input.workflow.nodeRegistry?.map((node) => ({
      id: node.id,
      ...(node.nodeFile === undefined ? {} : { nodeFile: node.nodeFile }),
      ...(node.addon === undefined ? {} : { addon: node.addon }),
    })) ?? input.workflow.nodes;
  for (const node of authoredNodes) {
    if (node.addon !== undefined) {
      continue;
    }
    if (node.nodeFile === undefined) {
      continue;
    }
    const prefersNodeFilePayload =
      input.workflow.nodeRegistry !== undefined &&
      hasStepAddressedDerivedNodePayload({
        workflow: input.workflow,
        nodeId: node.id,
        nodeFile: node.nodeFile,
        nodePayloads: input.nodePayloads,
      });
    const payload =
      input.workflow.nodeRegistry !== undefined
        ? prefersNodeFilePayload
          ? (input.nodePayloads[node.nodeFile] ?? input.nodePayloads[node.id])
          : (input.nodePayloads[node.id] ?? input.nodePayloads[node.nodeFile])
        : (input.nodePayloads[node.nodeFile] ?? input.nodePayloads[node.id]);
    if (payload !== undefined) {
      referencedPayloads[node.nodeFile] = payload;
    }
  }
  return referencedPayloads;
}

export function collectReferencedPromptTemplateFiles(
  nodePayloads: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  return new Set(collectPromptTemplateFiles(nodePayloads));
}

export function collectAuthoredReferencedNodePayloads(
  workflow: unknown,
  nodePayloads: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof workflow !== "object" || workflow === null) {
    return nodePayloads;
  }

  const nodesRaw = (workflow as Record<string, unknown>)["nodes"];
  if (!Array.isArray(nodesRaw)) {
    return nodePayloads;
  }

  const referencedPayloads: Record<string, unknown> = {};
  for (const node of nodesRaw) {
    if (typeof node !== "object" || node === null) {
      continue;
    }

    const nodeRecord = node as Record<string, unknown>;
    const nodeId =
      typeof nodeRecord["id"] === "string" ? nodeRecord["id"] : undefined;
    const nodeFile = resolveAuthoredNodeFileReference(nodeRecord);
    if (!nodeId || nodeFile === undefined) {
      continue;
    }

    const payload = nodePayloads[nodeFile] ?? nodePayloads[nodeId];
    if (payload !== undefined) {
      referencedPayloads[nodeFile] = payload;
    }
  }

  return referencedPayloads;
}

function applyPromptVariantProjection(input: {
  readonly payload: Record<string, unknown>;
  readonly variant: Record<string, unknown>;
}): Record<string, unknown> {
  const projectedPayload = cloneNodeTemplateAwarePayload(input.payload);

  for (const spec of NODE_TEMPLATE_FIELD_SPECS) {
    const variantTemplate = input.variant[spec.textField];
    const variantTemplateFile = input.variant[spec.fileField];
    if (variantTemplate === undefined && variantTemplateFile === undefined) {
      continue;
    }

    delete projectedPayload[spec.textField];
    delete projectedPayload[spec.fileField];
    if (variantTemplate !== undefined) {
      projectedPayload[spec.textField] = variantTemplate;
    }
    if (variantTemplateFile !== undefined) {
      projectedPayload[spec.fileField] = variantTemplateFile;
    }
  }

  return projectedPayload;
}

export function hasStepAddressedDerivedNodePayload(input: {
  readonly workflow: {
    readonly managerStepId?: string;
    readonly steps?: readonly {
      readonly id: string;
      readonly role?: unknown;
      readonly promptVariant?: string;
      readonly timeoutMs?: number;
      readonly sessionPolicy?: unknown;
    }[];
  };
  readonly nodeId: string;
  readonly nodeFile: string;
  readonly nodePayloads: Readonly<Record<string, unknown>>;
}): boolean {
  const step = input.workflow.steps?.find((entry) => entry.id === input.nodeId);
  if (step === undefined) {
    return false;
  }

  const nodeFilePayload = input.nodePayloads[input.nodeFile];
  const nodeIdPayload = input.nodePayloads[input.nodeId];
  if (!isRecord(nodeFilePayload) || !isRecord(nodeIdPayload)) {
    return false;
  }

  let stepProjectedPayload = cloneNodeTemplateAwarePayload(nodeFilePayload);
  stepProjectedPayload["id"] = step.id;
  if (step.timeoutMs === undefined) {
    delete stepProjectedPayload["timeoutMs"];
  } else {
    stepProjectedPayload["timeoutMs"] = step.timeoutMs;
  }
  const sessionPolicy =
    isRecord(step.sessionPolicy) &&
    typeof step.sessionPolicy["mode"] === "string"
      ? { mode: step.sessionPolicy["mode"] }
      : undefined;
  if (sessionPolicy === undefined) {
    delete stepProjectedPayload["sessionPolicy"];
  } else {
    stepProjectedPayload["sessionPolicy"] = sessionPolicy;
  }

  const isManagerStep =
    step.role === "manager" ||
    (step.role === undefined && input.workflow.managerStepId === step.id);
  if (isManagerStep) {
    stepProjectedPayload["managerType"] =
      typeof stepProjectedPayload["managerType"] === "string"
        ? stepProjectedPayload["managerType"]
        : "code";
  } else {
    delete stepProjectedPayload["managerType"];
  }

  if (step.promptVariant !== undefined) {
    const promptVariants = stepProjectedPayload["promptVariants"];
    const variantRaw =
      isRecord(promptVariants) && isRecord(promptVariants[step.promptVariant])
        ? promptVariants[step.promptVariant]
        : undefined;
    if (isRecord(variantRaw)) {
      stepProjectedPayload = applyPromptVariantProjection({
        payload: stepProjectedPayload,
        variant: variantRaw,
      });
    }
  }

  return isDeepStrictEqual(stepProjectedPayload, nodeIdPayload);
}

export function preferStepAddressedRegistryIdPayloads(
  workflow: unknown,
  nodePayloads: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isRecord(workflow) || !Array.isArray(workflow["steps"])) {
    return nodePayloads;
  }
  const nodesRaw = workflow["nodes"];
  if (!Array.isArray(nodesRaw)) {
    return nodePayloads;
  }

  const preferredPayloads: Record<string, unknown> = { ...nodePayloads };
  for (const node of nodesRaw) {
    if (!isRecord(node)) {
      continue;
    }
    const nodeId =
      typeof node["id"] === "string" && node["id"].length > 0
        ? node["id"]
        : undefined;
    const nodeFile =
      typeof node["nodeFile"] === "string" && node["nodeFile"].length > 0
        ? node["nodeFile"]
        : undefined;
    if (nodeId === undefined || nodeFile === undefined) {
      continue;
    }
    const prefersNodeFilePayload = hasStepAddressedDerivedNodePayload({
      workflow,
      nodeId,
      nodeFile,
      nodePayloads,
    });
    if (
      nodePayloads[nodeId] !== undefined &&
      (preferredPayloads[nodeFile] === undefined || !prefersNodeFilePayload)
    ) {
      preferredPayloads[nodeFile] = nodePayloads[nodeId];
    }
  }
  return preferredPayloads;
}

export async function readExistingAuthoredWorkflow(
  workflowDirectory: string,
): Promise<Result<unknown | undefined, SaveWorkflowFailure>> {
  const workflowPath = path.join(workflowDirectory, WORKFLOW_DEFINITION_FILE);
  try {
    const raw = await readFile(workflowPath, "utf8");
    return ok(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("ENOENT")) {
      return ok(undefined);
    }
    return err({
      code: "IO",
      message: `failed reading existing workflow definition '${workflowPath}' while preparing save: ${message}`,
    });
  }
}

async function readExistingNodePayload(
  workflowDirectory: string,
  nodeFile: string,
): Promise<unknown | undefined> {
  const nodeFilePath = resolveWorkflowRelativeNodeFilePath(
    workflowDirectory,
    nodeFile,
  );
  if (!nodeFilePath.ok) {
    return undefined;
  }

  try {
    const raw = await readFile(nodeFilePath.value, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function collectPayloadPromptTemplateFiles(
  payload: unknown,
): readonly string[] {
  return collectNodeTemplateFiles(payload);
}

async function collectExistingPromptTemplateFiles(input: {
  readonly workflowDirectory: string;
  readonly existingNodeFiles: readonly string[];
}): Promise<ReadonlySet<string>> {
  const existingPromptTemplateFiles = new Set<string>();

  for (const nodeFile of input.existingNodeFiles) {
    const existingPayload = await readExistingNodePayload(
      input.workflowDirectory,
      nodeFile,
    );
    for (const templateFile of collectPayloadPromptTemplateFiles(
      existingPayload,
    )) {
      existingPromptTemplateFiles.add(templateFile);
    }
  }

  return existingPromptTemplateFiles;
}

export async function loadExistingAuthoredWorkflowFileState(input: {
  readonly workflowDirectory: string;
  readonly existingAuthoredWorkflow: unknown;
}): Promise<
  Result<
    {
      readonly existingAuthoredWorkflowRecord:
        | Record<string, unknown>
        | undefined;
      readonly existingNodeFiles: readonly string[];
      readonly existingStepFiles: readonly string[];
      readonly existingPromptTemplateFiles: ReadonlySet<string>;
    },
    SaveWorkflowFailure
  >
> {
  const existingAuthoredWorkflowRecord = isRecord(
    input.existingAuthoredWorkflow,
  )
    ? input.existingAuthoredWorkflow
    : undefined;
  const existingNodeFiles = collectAuthoredNodeFiles(
    existingAuthoredWorkflowRecord,
  );
  const existingStepFiles = collectAuthoredStepFiles(
    existingAuthoredWorkflowRecord,
  );

  try {
    const existingPromptTemplateFiles =
      await collectExistingPromptTemplateFiles({
        workflowDirectory: input.workflowDirectory,
        existingNodeFiles,
      });
    return ok({
      existingAuthoredWorkflowRecord,
      existingNodeFiles,
      existingStepFiles,
      existingPromptTemplateFiles,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    return err({
      code: "IO",
      message: `failed reading existing workflow files while preparing save: ${message}`,
    });
  }
}

export async function removeStaleWorkflowFiles(input: {
  readonly workflowDirectory: string;
  readonly existingNodeFiles: readonly string[];
  readonly existingStepFiles: readonly string[];
  readonly existingPromptTemplateFiles: ReadonlySet<string>;
  readonly persistedNodeFiles: readonly string[];
  readonly persistedStepFiles: readonly string[];
  readonly persistedPromptTemplateFiles: ReadonlySet<string>;
}): Promise<void> {
  const persistedNodeFileSet = new Set(input.persistedNodeFiles);
  const staleNodeFiles = input.existingNodeFiles.filter(
    (nodeFile) => !persistedNodeFileSet.has(nodeFile),
  );
  const persistedStepFileSet = new Set(input.persistedStepFiles);
  const staleStepFiles = input.existingStepFiles.filter(
    (stepFile) => !persistedStepFileSet.has(stepFile),
  );
  const stalePromptTemplateFiles = [
    ...input.existingPromptTemplateFiles,
  ].filter(
    (templateFile) => !input.persistedPromptTemplateFiles.has(templateFile),
  );

  for (const nodeFile of staleNodeFiles) {
    const nodeFilePath = resolveWorkflowRelativeNodeFilePath(
      input.workflowDirectory,
      nodeFile,
    );
    if (!nodeFilePath.ok) {
      continue;
    }
    await rm(nodeFilePath.value, { force: true });
  }

  for (const stepFile of staleStepFiles) {
    const stepFilePath = resolveWorkflowRelativePath(
      input.workflowDirectory,
      stepFile,
    );
    if (!stepFilePath.ok) {
      continue;
    }
    await rm(stepFilePath.value, { force: true });
  }

  for (const templateFile of stalePromptTemplateFiles) {
    const templateFilePath = resolveWorkflowRelativePath(
      input.workflowDirectory,
      templateFile,
    );
    if (!templateFilePath.ok) {
      continue;
    }
    await rm(templateFilePath.value, { force: true });
  }
}

export async function persistNodePayload(input: {
  readonly workflowDirectory: string;
  readonly nodeFile: string;
  readonly payload: unknown;
}): Promise<void> {
  if (typeof input.payload !== "object" || input.payload === null) {
    await atomicWriteJsonFile(
      path.join(input.workflowDirectory, input.nodeFile),
      input.payload,
    );
    return;
  }

  const payload = input.payload as Record<string, unknown>;
  const persistedPayload = cloneNodeTemplateAwarePayload(payload);
  let wroteTemplateFile = false;

  for (const { record } of listNodeTemplateFieldContainers(persistedPayload)) {
    for (const spec of NODE_TEMPLATE_FIELD_SPECS) {
      const templateFile = record[spec.fileField];
      const templateText = record[spec.textField];
      if (
        typeof templateFile !== "string" ||
        templateFile.length === 0 ||
        typeof templateText !== "string" ||
        templateText.length === 0
      ) {
        continue;
      }

      const promptFilePath = resolveWorkflowRelativePath(
        input.workflowDirectory,
        templateFile,
      );
      if (!promptFilePath.ok) {
        throw new Error(promptFilePath.error.message);
      }
      await atomicWriteTextFile(
        promptFilePath.value,
        `${templateText.trimEnd()}\n`,
      );
      delete record[spec.textField];
      wroteTemplateFile = true;
    }
  }

  await atomicWriteJsonFile(
    path.join(input.workflowDirectory, input.nodeFile),
    wroteTemplateFile ? persistedPayload : input.payload,
  );
}

export async function persistStepDefinition(input: {
  readonly workflowDirectory: string;
  readonly stepFile: string;
  readonly step: WorkflowStepRef;
}): Promise<void> {
  const stepFilePath = resolveWorkflowRelativePath(
    input.workflowDirectory,
    input.stepFile,
  );
  if (!stepFilePath.ok) {
    throw new Error(stepFilePath.error.message);
  }

  await atomicWriteJsonFile(stepFilePath.value, {
    id: input.step.id,
    nodeId: input.step.nodeId,
    ...(input.step.description === undefined
      ? {}
      : { description: input.step.description }),
    ...(input.step.role === undefined ? {} : { role: input.step.role }),
    ...(input.step.promptVariant === undefined
      ? {}
      : { promptVariant: input.step.promptVariant }),
    ...(input.step.timeoutMs === undefined
      ? {}
      : { timeoutMs: input.step.timeoutMs }),
    ...(input.step.sessionPolicy === undefined
      ? {}
      : { sessionPolicy: input.step.sessionPolicy }),
    ...(input.step.transitions === undefined
      ? {}
      : { transitions: input.step.transitions }),
  });
}
