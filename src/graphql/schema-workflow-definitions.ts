import type {
  SaveWorkflowResponse,
  ValidationResponse,
  WorkflowResponse,
} from "../shared/ui-contract";
import {
  createWorkflowTemplate,
  type CreateWorkflowTemplateMode,
} from "../workflow/create";
import { buildInspectionSummary } from "../workflow/inspect";
import { collectWorkflowAddonSourceSummaries } from "../workflow/addon-source-summary";
import { loadWorkflowFromCatalog, type LoadedWorkflow } from "../workflow/load";
import { isSafeWorkflowName } from "../workflow/paths";
import {
  listWorkflowCatalogSources,
  resolveWorkflowSource,
  withResolvedWorkflowSourceOptions,
} from "../workflow/catalog";
import {
  collectPromptTemplateFiles,
  collectWorkflowRevisionNodeFiles,
  computeWorkflowRevisionFromFiles,
} from "../workflow/revision";
import { saveWorkflowToDisk } from "../workflow/save";
import { validateWorkflowBundleDetailedAsync } from "../workflow/validate";
import { deriveWorkflowVisualization } from "../workflow/visualization";
import { parseWorkflowBundleInput } from "../workflow/workflow-bundle-input";
import {
  buildWorkflowCatalogOverview,
  buildWorkflowStatusOverview,
  type WorkflowCatalogOverview,
  type WorkflowStatusOverview,
} from "../workflow/overview";
import type {
  CreateWorkflowDefinitionInput,
  SaveWorkflowDefinitionInput,
  SaveWorkflowDefinitionPayload,
  ValidateWorkflowDefinitionInput,
  ValidateWorkflowDefinitionPayload,
  WorkflowDefinitionView,
  WorkflowDefinitionsView,
  WorkflowCatalogOverviewGraphqlInput,
  WorkflowStatusOverviewGraphqlInput,
  WorkflowView,
  WorkflowLookupInput,
  GraphqlRequestContext,
} from "./types";

export async function listWorkflowDefinitionNames(
  context: GraphqlRequestContext,
): Promise<WorkflowDefinitionsView> {
  const sources = await listWorkflowCatalogSources(context);
  if (!sources.ok) {
    throw new Error(sources.error.message);
  }

  const names =
    context.fixedWorkflowName === undefined
      ? sources.value.map((source) => source.workflowName)
      : sources.value
          .filter((source) => source.workflowName === context.fixedWorkflowName)
          .map((source) => source.workflowName);

  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

export function assertWorkflowDefinitionAccess(
  workflowName: string,
  context: GraphqlRequestContext,
): void {
  if (!isSafeWorkflowName(workflowName)) {
    throw new Error(`invalid workflow name '${workflowName}'`);
  }
  if (
    context.fixedWorkflowName !== undefined &&
    context.fixedWorkflowName !== workflowName
  ) {
    throw new Error("workflow name not allowed in fixed workflow mode");
  }
}

export function isOverviewWorkflowCatalogNotFound(error: {
  readonly code: string;
  readonly message: string;
}): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "NOT_FOUND" &&
    typeof error.message === "string" &&
    !error.message.startsWith("session not found:")
  );
}

export async function workflowCatalogOverviewQuery(
  input: WorkflowCatalogOverviewGraphqlInput,
  context: GraphqlRequestContext,
): Promise<WorkflowCatalogOverview> {
  const catalogInput = {
    ...(input.workflowScope === undefined
      ? {}
      : { workflowScope: input.workflowScope }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
  const built = await buildWorkflowCatalogOverview(catalogInput, context);
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  let workflows = built.value.workflows;
  if (
    context.fixedWorkflowName !== undefined &&
    context.fixedResolvedWorkflowSource === undefined
  ) {
    workflows = workflows.filter(
      (row) => row.workflowName === context.fixedWorkflowName,
    );
  }
  return { workflows };
}

export function workflowStatusOverviewInputForFixedMode(
  input: WorkflowStatusOverviewGraphqlInput,
  context: GraphqlRequestContext,
): WorkflowStatusOverviewGraphqlInput {
  const fixedSource = context.fixedResolvedWorkflowSource;
  if (fixedSource === undefined) {
    return input;
  }
  return {
    workflowName: fixedSource.workflowName,
    ...(fixedSource.scope === "direct"
      ? {}
      : { workflowScope: fixedSource.scope }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

export async function workflowStatusOverviewQuery(
  input: WorkflowStatusOverviewGraphqlInput,
  context: GraphqlRequestContext,
): Promise<WorkflowStatusOverview | null> {
  assertWorkflowDefinitionAccess(input.workflowName, context);
  const effectiveInput = workflowStatusOverviewInputForFixedMode(
    input,
    context,
  );
  const built = await buildWorkflowStatusOverview(effectiveInput, context);
  if (!built.ok) {
    if (isOverviewWorkflowCatalogNotFound(built.error)) {
      return null;
    }
    throw new Error(built.error.message);
  }
  return built.value;
}

export function assertWorkflowDefinitionWritable(
  workflowName: string,
  context: GraphqlRequestContext,
): void {
  if (context.readOnly === true) {
    throw new Error("read-only mode enabled");
  }
  if (
    context.fixedWorkflowName !== undefined &&
    context.fixedWorkflowName !== workflowName
  ) {
    throw new Error(
      "cannot write workflows outside fixed workflow mode target",
    );
  }
}

export function optionsForLoadedWorkflow(
  loadedWorkflow: LoadedWorkflow,
  context: GraphqlRequestContext,
): GraphqlRequestContext {
  return loadedWorkflow.source === undefined
    ? context
    : withResolvedWorkflowSourceOptions(loadedWorkflow.source, context);
}

export async function loadWorkflowDefinitionForGraphql(
  workflowName: string,
  context: GraphqlRequestContext,
): Promise<LoadedWorkflow | null> {
  assertWorkflowDefinitionAccess(workflowName, context);
  const loaded = await loadWorkflowFromCatalog(workflowName, context);
  return loaded.ok ? loaded.value : null;
}

export async function resolveWorkflowContextForGraphql(
  workflowName: string,
  context: GraphqlRequestContext,
): Promise<GraphqlRequestContext> {
  assertWorkflowDefinitionAccess(workflowName, context);
  const source = await resolveWorkflowSource(workflowName, context);
  if (!source.ok) {
    throw new Error(source.error.message);
  }
  return withResolvedWorkflowSourceOptions(source.value, context);
}

export async function buildWorkflowDefinitionView(
  workflowName: string,
  context: GraphqlRequestContext,
): Promise<WorkflowDefinitionView | null> {
  const loaded = await loadWorkflowDefinitionForGraphql(workflowName, context);
  if (loaded === null) {
    return null;
  }
  const nodeFiles = collectWorkflowRevisionNodeFiles(loaded.bundle.workflow);
  const revision = await computeWorkflowRevisionFromFiles(
    loaded.workflowDirectory,
    nodeFiles,
    collectPromptTemplateFiles(loaded.bundle.nodePayloads),
  );
  return {
    workflowName: loaded.workflowName,
    workflowDirectory: loaded.workflowDirectory,
    artifactWorkflowRoot: loaded.artifactWorkflowRoot,
    revision: revision.ok ? revision.value : null,
    bundle: loaded.bundle,
    derivedVisualization: deriveWorkflowVisualization({
      workflow: loaded.bundle.workflow,
    }),
  } satisfies WorkflowResponse;
}

export async function createWorkflowDefinitionMutation(
  input: CreateWorkflowDefinitionInput,
  context: GraphqlRequestContext,
): Promise<WorkflowDefinitionView> {
  if (context.readOnly === true) {
    throw new Error("read-only mode enabled");
  }
  if (context.fixedWorkflowName !== undefined) {
    throw new Error("cannot create workflows in fixed workflow mode");
  }
  if (!isSafeWorkflowName(input.workflowName)) {
    throw new Error(`invalid workflow name '${input.workflowName}'`);
  }
  const templateMode = normalizeCreateWorkflowTemplateMode(input.templateMode);
  const created = await createWorkflowTemplate(input.workflowName, {
    ...context,
    ...(templateMode === undefined ? {} : { templateMode }),
  });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  const loaded = await buildWorkflowDefinitionView(
    created.value.workflowName,
    context,
  );
  if (loaded === null) {
    throw new Error(
      `workflow '${created.value.workflowName}' was not found after creation`,
    );
  }
  return loaded;
}

function normalizeCreateWorkflowTemplateMode(
  value: CreateWorkflowDefinitionInput["templateMode"],
): CreateWorkflowTemplateMode | undefined {
  if (value === undefined || value === "managed" || value === "MANAGED") {
    return value === undefined ? undefined : "managed";
  }
  if (value === "worker-only" || value === "WORKER_ONLY") {
    return "worker-only";
  }
  throw new Error(`unsupported workflow template mode '${value}'`);
}

export async function saveWorkflowDefinitionMutation(
  input: SaveWorkflowDefinitionInput,
  context: GraphqlRequestContext,
): Promise<SaveWorkflowDefinitionPayload> {
  const parsedBundle = parseWorkflowBundleInput(input.bundle, "input.bundle");
  if (!parsedBundle.ok) {
    return {
      workflowName: input.workflowName,
      error: parsedBundle.error,
      issues: [],
    };
  }
  assertWorkflowDefinitionWritable(input.workflowName, context);
  const workflowContext = await resolveWorkflowContextForGraphql(
    input.workflowName,
    context,
  );
  const saveResult = await saveWorkflowToDisk(
    input.workflowName,
    {
      workflow: parsedBundle.value.workflow,
      nodePayloads: parsedBundle.value.nodePayloads,
      ...(input.expectedRevision === undefined
        ? {}
        : { expectedRevision: input.expectedRevision }),
    },
    workflowContext,
  );
  if (!saveResult.ok) {
    return {
      workflowName: input.workflowName,
      error: saveResult.error.message,
      ...(saveResult.error.currentRevision === undefined
        ? {}
        : { currentRevision: saveResult.error.currentRevision }),
      ...(saveResult.error.issues === undefined
        ? {}
        : { issues: saveResult.error.issues }),
    };
  }
  return {
    workflowName: saveResult.value.workflowName,
    workflowDirectory: saveResult.value.workflowDirectory,
    revision: saveResult.value.revision,
  } satisfies SaveWorkflowResponse;
}

export async function validateWorkflowDefinitionMutation(
  input: ValidateWorkflowDefinitionInput,
  context: GraphqlRequestContext,
): Promise<ValidateWorkflowDefinitionPayload> {
  if (input.bundle !== undefined) {
    const parsedBundle = parseWorkflowBundleInput(input.bundle, "input.bundle");
    if (!parsedBundle.ok) {
      return {
        valid: false,
        error: parsedBundle.error,
        issues: [],
      } satisfies ValidationResponse;
    }
    const validation = await validateWorkflowBundleDetailedAsync(
      {
        workflow: parsedBundle.value.workflow,
        nodePayloads: parsedBundle.value.nodePayloads,
      },
      context,
    );
    if (!validation.ok) {
      return {
        valid: false,
        issues: validation.error,
      } satisfies ValidationResponse;
    }
    const addonSources = await collectWorkflowAddonSourceSummaries({
      workflow: validation.value.bundle.workflow,
      options: context,
    });
    return {
      valid: true,
      workflowId: validation.value.bundle.workflow.workflowId,
      addonSources,
      warnings: validation.value.issues.filter(
        (issue) => issue.severity === "warning",
      ),
      issues: validation.value.issues,
    } satisfies ValidationResponse;
  }

  assertWorkflowDefinitionAccess(input.workflowName, context);
  const loaded = await loadWorkflowFromCatalog(input.workflowName, context);
  if (!loaded.ok) {
    return {
      valid: false,
      error: loaded.error.message,
      issues: loaded.error.issues ?? [],
    } satisfies ValidationResponse;
  }
  const workflowContext = optionsForLoadedWorkflow(loaded.value, context);
  return {
    valid: true,
    workflowId: loaded.value.bundle.workflow.workflowId,
    addonSources: await collectWorkflowAddonSourceSummaries({
      workflow: loaded.value.bundle.workflow,
      options: workflowContext,
      ...(loaded.value.source === undefined
        ? {}
        : { workflowSource: loaded.value.source }),
    }),
    warnings: [],
  } satisfies ValidationResponse;
}

export async function buildWorkflowView(
  input: WorkflowLookupInput,
  context: GraphqlRequestContext,
): Promise<WorkflowView | null> {
  const loaded = await loadWorkflowDefinitionForGraphql(
    input.workflowName,
    context,
  );
  if (loaded === null) {
    return null;
  }
  return buildInspectionSummary(
    loaded,
    optionsForLoadedWorkflow(loaded, context),
  );
}
